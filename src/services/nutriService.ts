import pool from '../config/database';
import { hasActiveConsent } from './consentService';
import { getMetabolismForUser } from '../modules/metabolism/metabolic.service';
import { logDataAccessEvent } from './dataAccessAuditService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NutriObjective =
  | 'weight_loss'
  | 'muscle_gain'
  | 'metabolic_health'
  | 'performance'
  | 'maintenance';

export type Adherence = 'full' | 'partial' | 'skipped';

export type MealCheckinStatus = 'done' | 'partial' | 'skipped' | 'substituted' | 'delayed';

export type MealStatus = 'upcoming' | 'due_now' | 'done' | 'partial' | 'skipped' | 'substituted' | 'delayed' | 'missed_window' | 'no_time';

export interface MealInput {
  name: string;
  orientation: string;
  order_index: number;
  meal_time?: string | null;
  tolerance_minutes?: number | null;
  reminder_minutes?: number | null;
  metabolic_goal?: string | null;
  workout_relation?: string | null;
  hydration_note?: string | null;
  supplement_note?: string | null;
  alternatives?: Array<{ description: string; order_index: number }>;
}

export interface CreatePlanInput {
  title: string;
  objective: NutriObjective;
  general_notes?: string;
  meals: MealInput[];
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function createPlan(
  nutriId: number,
  patientId: number,
  academyId: number | null,
  data: CreatePlanInput
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // End previous active plan for this pair
    await client.query(
      `UPDATE nutrition_plans
       SET status = 'ended', ended_at = NOW(), updated_at = NOW()
       WHERE nutri_id = $1 AND patient_id = $2 AND status = 'active'`,
      [nutriId, patientId]
    );

    const planResult = await client.query(
      `INSERT INTO nutrition_plans
         (nutri_id, patient_id, academy_id, title, objective, general_notes, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), NOW())
       RETURNING *`,
      [nutriId, patientId, academyId, data.title.trim(), data.objective, data.general_notes?.trim() ?? null]
    );
    const plan = planResult.rows[0];

    if (data.meals.length > 0) {
      for (const m of data.meals) {
        const mealRes = await client.query(
          `INSERT INTO nutrition_plan_meals
             (plan_id, name, orientation, order_index,
              meal_time, tolerance_minutes, reminder_minutes,
              metabolic_goal, workout_relation, hydration_note, supplement_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            plan.id,
            m.name.trim().slice(0, 80),
            m.orientation.trim(),
            m.order_index ?? 0,
            m.meal_time ?? null,
            m.tolerance_minutes ?? null,
            m.reminder_minutes ?? null,
            m.metabolic_goal ?? null,
            m.workout_relation ?? null,
            m.hydration_note?.trim().slice(0, 200) ?? null,
            m.supplement_note?.trim().slice(0, 200) ?? null,
          ]
        );
        const mealId = mealRes.rows[0].id;
        if (Array.isArray(m.alternatives) && m.alternatives.length > 0) {
          for (const alt of m.alternatives) {
            await client.query(
              `INSERT INTO nutrition_meal_alternatives (meal_id, description, order_index)
               VALUES ($1, $2, $3)`,
              [mealId, alt.description.trim(), alt.order_index ?? 0]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: patientId,
      eventType: 'nutri.plan.created',
      eventPayload: { planId: plan.id, title: data.title },
    });
    return plan;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getActivePlan(nutriId: number, patientId: number) {
  const planResult = await pool.query(
    `SELECT np.*,
            u.name AS nutri_name,
            u2.name AS patient_name
     FROM nutrition_plans np
     JOIN users u  ON u.id  = np.nutri_id
     JOIN users u2 ON u2.id = np.patient_id
     WHERE np.nutri_id = $1 AND np.patient_id = $2 AND np.status = 'active'
     LIMIT 1`,
    [nutriId, patientId]
  );
  if (planResult.rows.length === 0) return null;
  const plan = planResult.rows[0];

  const mealsResult = await pool.query(
    `SELECT npm.*,
            COALESCE(
              json_agg(nma ORDER BY nma.order_index, nma.id) FILTER (WHERE nma.id IS NOT NULL),
              '[]'
            ) AS alternatives
     FROM nutrition_plan_meals npm
     LEFT JOIN nutrition_meal_alternatives nma ON nma.meal_id = npm.id
     WHERE npm.plan_id = $1
     GROUP BY npm.id
     ORDER BY npm.order_index, npm.id`,
    [plan.id]
  );
  return { ...plan, meals: mealsResult.rows };
}

export async function getPlanHistory(nutriId: number, patientId: number) {
  const result = await pool.query(
    `SELECT id, title, objective, status, started_at, ended_at
     FROM nutrition_plans
     WHERE nutri_id = $1 AND patient_id = $2 AND status = 'ended'
     ORDER BY started_at DESC
     LIMIT 20`,
    [nutriId, patientId]
  );
  return result.rows;
}

export async function endPlan(nutriId: number, planId: number, patientId: number) {
  const result = await pool.query(
    `UPDATE nutrition_plans
     SET status = 'ended', ended_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND nutri_id = $2 AND status = 'active'
     RETURNING *`,
    [planId, nutriId]
  );
  if (result.rows[0]) {
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: patientId,
      eventType: 'nutri.plan.ended',
      eventPayload: { planId },
    });
  }
  return result.rows[0] ?? null;
}

export async function updatePlan(
  nutriId: number,
  planId: number,
  patientId: number,
  payload: {
    title?: string;
    objective?: string;
    general_notes?: string;
    meals?: MealInput[];
  }
) {
  const { title, objective, general_notes, meals } = payload;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE nutrition_plans
          SET title         = COALESCE(NULLIF(TRIM($3), ''), title),
              objective     = COALESCE($4, objective),
              general_notes = COALESCE($5, general_notes),
              updated_at    = NOW()
        WHERE id = $1 AND nutri_id = $2 AND status = 'active'
        RETURNING *`,
      [planId, nutriId, title ?? null, objective ?? null, general_notes ?? null]
    );

    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    if (meals !== undefined) {
      await client.query(`DELETE FROM nutrition_plan_meals WHERE plan_id = $1`, [planId]);
      for (const meal of meals) {
        const mealRes = await client.query(
          `INSERT INTO nutrition_plan_meals
             (plan_id, name, orientation, order_index,
              meal_time, tolerance_minutes, reminder_minutes,
              metabolic_goal, workout_relation, hydration_note, supplement_note,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
           RETURNING id`,
          [
            planId,
            meal.name.trim(),
            meal.orientation.trim(),
            meal.order_index,
            meal.meal_time ?? null,
            meal.tolerance_minutes ?? null,
            meal.reminder_minutes ?? null,
            meal.metabolic_goal ?? null,
            meal.workout_relation ?? null,
            meal.hydration_note?.trim().slice(0, 200) ?? null,
            meal.supplement_note?.trim().slice(0, 200) ?? null,
          ]
        );
        const mealId = mealRes.rows[0].id;
        if (Array.isArray(meal.alternatives) && meal.alternatives.length > 0) {
          for (const alt of meal.alternatives) {
            await client.query(
              `INSERT INTO nutrition_meal_alternatives (meal_id, description, order_index)
               VALUES ($1, $2, $3)`,
              [mealId, alt.description.trim(), alt.order_index ?? 0]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: patientId,
      eventType: 'nutri.plan.updated',
      eventPayload: { planId },
    });

    const mealsResult = await pool.query(
      `SELECT npm.*,
              COALESCE(
                json_agg(nma ORDER BY nma.order_index, nma.id) FILTER (WHERE nma.id IS NOT NULL),
                '[]'
              ) AS alternatives
       FROM nutrition_plan_meals npm
       LEFT JOIN nutrition_meal_alternatives nma ON nma.meal_id = npm.id
       WHERE npm.plan_id = $1
       GROUP BY npm.id
       ORDER BY npm.order_index, npm.id`,
      [planId]
    );
    return { ...updated.rows[0], meals: mealsResult.rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listAdherenceHistory(patientId: number, days = 30) {
  const result = await pool.query(
    `SELECT nac.check_date, nac.adherence, nac.note, nac.created_at,
            np.title AS plan_title
       FROM nutrition_adherence_checkins nac
       JOIN nutrition_plans np ON np.id = nac.plan_id
      WHERE nac.patient_id = $1
        AND nac.check_date >= CURRENT_DATE - ($2 - 1)
      ORDER BY nac.check_date DESC`,
    [patientId, days]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Adherence check-ins (aluno)
// ---------------------------------------------------------------------------

export async function createAdherenceCheckin(
  patientId: number,
  planId: number,
  adherence: Adherence,
  note: string | null
) {
  // Verify the plan belongs to this patient and is active
  const planCheck = await pool.query(
    `SELECT id FROM nutrition_plans WHERE id = $1 AND patient_id = $2 AND status = 'active'`,
    [planId, patientId]
  );
  if (planCheck.rows.length === 0) {
    return { error: 'plan_not_found', status: 404 };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const result = await pool.query(
      `INSERT INTO nutrition_adherence_checkins
         (patient_id, plan_id, check_date, adherence, note, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [patientId, planId, today, adherence, note?.trim().slice(0, 200) ?? null]
    );
    return { data: result.rows[0] };
  } catch (err: any) {
    if (err.code === '23505') {
      return { error: 'already_checked_in', status: 409 };
    }
    throw err;
  }
}

export async function getAdherenceForPeriod(
  patientId: number,
  planId: number,
  days = 7,
  nutriId?: number
) {
  const result = await pool.query(
    `SELECT check_date, adherence, note
     FROM nutrition_adherence_checkins
     WHERE patient_id = $1 AND plan_id = $2
       AND check_date >= CURRENT_DATE - ($3 - 1)
     ORDER BY check_date DESC`,
    [patientId, planId, days]
  );
  if (nutriId) {
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: patientId,
      eventType: 'nutri.adherence.read',
      eventPayload: { planId, days },
    });
  }
  return result.rows;
}

// ---------------------------------------------------------------------------
// Observations (nutri only)
// ---------------------------------------------------------------------------

export async function createObservation(nutriId: number, patientId: number, body: string) {
  const result = await pool.query(
    `INSERT INTO nutrition_observations (nutri_id, patient_id, body, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     RETURNING *`,
    [nutriId, patientId, body.trim()]
  );
  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'nutri.observation.created',
    eventPayload: { observationId: result.rows[0].id },
  });
  return result.rows[0];
}

export async function getObservations(
  nutriId: number,
  patientId: number,
  limit = 10,
  offset = 0
) {
  const result = await pool.query(
    `SELECT id, body, created_at, updated_at
     FROM nutrition_observations
     WHERE nutri_id = $1 AND patient_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [nutriId, patientId, limit, offset]
  );
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM nutrition_observations WHERE nutri_id = $1 AND patient_id = $2`,
    [nutriId, patientId]
  );
  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'nutri.observation.read',
    eventPayload: { limit, offset },
  });
  return { rows: result.rows, total: Number(countResult.rows[0].count) };
}

// ---------------------------------------------------------------------------
// Context (metabolic + daily checkins) — consent-gated per scope
// ---------------------------------------------------------------------------

export async function getPatientContext(nutriId: number, patientId: number) {
  const [hasMetabolicConsent, hasDailyConsent] = await Promise.all([
    hasActiveConsent(patientId, nutriId, 'nutri', 'metabolic'),
    hasActiveConsent(patientId, nutriId, 'nutri', 'daily_checkins'),
  ]);

  const context: Record<string, unknown> = {};

  if (hasMetabolicConsent) {
    try {
      context.metabolism = await getMetabolismForUser(patientId, null);
    } catch {
      context.metabolism = null;
    }
  }

  if (hasDailyConsent) {
    const checkins = await pool.query(
      `SELECT date_key AS check_date, feeling, slept_well, in_pain, stressed, notes
       FROM user_daily_checkins
       WHERE user_id = $1 AND date_key >= CURRENT_DATE - 6
       ORDER BY date_key DESC`,
      [patientId]
    );
    context.dailyCheckins = checkins.rows;
  }

  const accessedScopes = [
    hasMetabolicConsent ? 'metabolic' : null,
    hasDailyConsent ? 'daily_checkins' : null,
  ].filter(Boolean);
  if (accessedScopes.length > 0) {
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: patientId,
      eventType: 'nutri.context.read',
      eventPayload: { scopes: accessedScopes },
    });
  }

  return {
    hasMetabolicConsent,
    hasDailyConsent,
    ...context,
  };
}

// ---------------------------------------------------------------------------
// Meal timeline — GET /user/meals/today
// ---------------------------------------------------------------------------

function computeMealStatus(
  mealTime: string | null,
  toleranceMinutes: number,
  checkin: { status: string } | null,
  nowMinutes: number // minutes since midnight
): MealStatus {
  if (checkin) {
    return checkin.status as MealStatus;
  }
  if (!mealTime) return 'no_time';

  const [h, m] = mealTime.split(':').map(Number);
  const mealMinutes = h * 60 + m;
  const windowStart = mealMinutes - toleranceMinutes;
  const windowEnd   = mealMinutes + toleranceMinutes;
  const afterEnd    = nowMinutes > windowEnd + 4 * 60; // 4h grace before missed_window

  if (nowMinutes < windowStart) return 'upcoming';
  if (nowMinutes <= windowEnd)  return 'due_now';
  if (afterEnd)                 return 'missed_window';
  return 'upcoming'; // passed window but inside 4h grace — keep upcoming
}

function computeStreak(checkinDates: string[]): number {
  const dateSet = new Set(checkinDates);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  // Start from today if it has a checkin, else from yesterday
  const startOffset = dateSet.has(todayStr) ? 0 : 1;
  let streak = 0;
  for (let i = startOffset; i < 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (!dateSet.has(d.toISOString().slice(0, 10))) break;
    streak++;
  }
  return streak;
}

export async function getMealTimeline(userId: number) {
  const planResult = await pool.query(
    `SELECT np.id AS plan_id, np.title, np.objective, np.general_notes,
            np.nutri_id, u.name AS nutri_name
     FROM nutrition_plans np
     JOIN users u ON u.id = np.nutri_id
     WHERE np.patient_id = $1 AND np.status = 'active'
     ORDER BY np.started_at DESC
     LIMIT 1`,
    [userId]
  );
  if (planResult.rows.length === 0) return null;
  const plan = planResult.rows[0];
  const today = new Date().toISOString().slice(0, 10);

  const [mealsResult, workoutResult, streakResult] = await Promise.all([
    pool.query(
      `SELECT npm.*,
              COALESCE(
                json_agg(nma ORDER BY nma.order_index, nma.id) FILTER (WHERE nma.id IS NOT NULL),
                '[]'
              ) AS alternatives
       FROM nutrition_plan_meals npm
       LEFT JOIN nutrition_meal_alternatives nma ON nma.meal_id = npm.id
       WHERE npm.plan_id = $1
       GROUP BY npm.id
       ORDER BY npm.meal_time NULLS LAST, npm.order_index, npm.id`,
      [plan.plan_id]
    ),
    // Workout logged today — drives pre/post meal context
    pool.query(
      `SELECT title, muscle_groups
       FROM user_workout_logs
       WHERE user_id = $1 AND DATE(completed_at) = CURRENT_DATE
       ORDER BY completed_at DESC
       LIMIT 1`,
      [userId]
    ),
    // Distinct dates with non-skip checkin for streak (last 60 days)
    pool.query(
      `SELECT DISTINCT check_date::text
       FROM nutrition_meal_checkins
       WHERE patient_id = $1
         AND check_date >= CURRENT_DATE - 59
         AND status IN ('done', 'partial', 'substituted')
       ORDER BY check_date DESC`,
      [userId]
    ),
  ]);

  const mealIds = mealsResult.rows.map((r) => r.id);
  let checkinsMap = new Map<number, { status: string }>();

  if (mealIds.length > 0) {
    const checkinsResult = await pool.query(
      `SELECT meal_id, status, satiety, hunger, energy, note
       FROM nutrition_meal_checkins
       WHERE patient_id = $1 AND check_date = $2 AND meal_id = ANY($3)`,
      [userId, today, mealIds]
    );
    checkinsMap = new Map(checkinsResult.rows.map((r) => [r.meal_id, r]));
  }

  const workoutToday = workoutResult.rows[0]
    ? { title: workoutResult.rows[0].title as string, muscleGroups: workoutResult.rows[0].muscle_groups as string[] }
    : null;

  const streak = computeStreak(streakResult.rows.map((r) => r.check_date as string));

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const meals = mealsResult.rows.map((m) => {
    const checkin = checkinsMap.get(m.id) ?? null;
    const status = computeMealStatus(
      m.meal_time,
      m.tolerance_minutes ?? 60,
      checkin,
      nowMinutes
    );
    return { ...m, status, checkin };
  });

  return { ...plan, today, meals, workoutToday, streak };
}

// ---------------------------------------------------------------------------
// Meal check-in — POST /user/meals/:mealId/checkins
// ---------------------------------------------------------------------------

export async function createMealCheckin(
  userId: number,
  mealId: number,
  data: {
    status: MealCheckinStatus;
    satiety?: number | null;
    hunger?: number | null;
    energy?: number | null;
    note?: string | null;
    substitutedAlternativeId?: number | null;
  }
) {
  // Validate meal belongs to user's active plan
  const mealCheck = await pool.query(
    `SELECT npm.id, npm.plan_id
     FROM nutrition_plan_meals npm
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE npm.id = $1 AND np.patient_id = $2 AND np.status = 'active'`,
    [mealId, userId]
  );
  if (mealCheck.rows.length === 0) {
    return { error: 'meal_not_found', status: 404 as const };
  }
  const planId = mealCheck.rows[0].plan_id;

  // Validate alternative belongs to this meal
  const altId = data.status === 'substituted' && data.substitutedAlternativeId
    ? data.substitutedAlternativeId
    : null;
  if (altId) {
    const altCheck = await pool.query(
      `SELECT 1 FROM nutrition_meal_alternatives WHERE id = $1 AND meal_id = $2`,
      [altId, mealId]
    );
    if (altCheck.rows.length === 0) {
      return { error: 'alternative_not_found', status: 400 as const };
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `INSERT INTO nutrition_meal_checkins
         (patient_id, plan_id, meal_id, check_date, status, satiety, hunger, energy, note,
          substituted_alternative_id, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       RETURNING *`,
      [
        userId, planId, mealId, today, data.status,
        data.satiety ?? null, data.hunger ?? null, data.energy ?? null,
        data.note?.trim().slice(0, 500) ?? null,
        altId,
      ]
    );
    return { data: result.rows[0] };
  } catch (err: any) {
    if (err.code === '23505') {
      const result = await pool.query(
        `UPDATE nutrition_meal_checkins
         SET status = $1, satiety = $2, hunger = $3, energy = $4, note = $5,
             substituted_alternative_id = $6, recorded_at = NOW()
         WHERE patient_id = $7 AND meal_id = $8 AND check_date = $9
         RETURNING *`,
        [
          data.status,
          data.satiety ?? null, data.hunger ?? null, data.energy ?? null,
          data.note?.trim().slice(0, 500) ?? null,
          altId,
          userId, mealId, today,
        ]
      );
      return { data: result.rows[0], updated: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Meal heatmap — GET /nutri/patients/:id/meal-heatmap (nutri view)
// ---------------------------------------------------------------------------

export async function getMealHeatmap(
  nutriId: number,
  patientId: number,
  days = 14
) {
  const planResult = await pool.query(
    `SELECT np.id AS plan_id, np.title
     FROM nutrition_plans np
     WHERE np.nutri_id = $1 AND np.patient_id = $2 AND np.status = 'active'
     LIMIT 1`,
    [nutriId, patientId]
  );
  if (planResult.rows.length === 0) return { plan: null, meals: [], checkins: [] };
  const plan = planResult.rows[0];

  const mealsResult = await pool.query(
    `SELECT id, name, meal_time, order_index
     FROM nutrition_plan_meals
     WHERE plan_id = $1
     ORDER BY meal_time NULLS LAST, order_index, id`,
    [plan.plan_id]
  );

  const checkinsResult = await pool.query(
    `SELECT meal_id, check_date, status
     FROM nutrition_meal_checkins
     WHERE patient_id = $1 AND plan_id = $2
       AND check_date >= CURRENT_DATE - ($3 - 1)
     ORDER BY check_date DESC, meal_id`,
    [patientId, plan.plan_id, days]
  );

  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'nutri.meal_heatmap.read',
    eventPayload: { days },
  });
  return {
    plan: { id: plan.plan_id, title: plan.title },
    meals: mealsResult.rows,
    checkins: checkinsResult.rows,
  };
}

// ---------------------------------------------------------------------------
// Enriched patients list (nutri dashboard)
// ---------------------------------------------------------------------------

export async function getPatientsWithSummary(nutriId: number) {
  const patientsResult = await pool.query(
    `SELECT u.id, u.name, u.email, u.photo_url,
            npa.status AS assignment_status, npa.started_at, npa.academy_id
     FROM nutri_patient_assignments npa
     JOIN users u ON u.id = npa.patient_id
     WHERE npa.nutri_id = $1 AND npa.status = 'active'
     ORDER BY u.name`,
    [nutriId]
  );

  if (patientsResult.rows.length === 0) return [];

  const patientIds = patientsResult.rows.map((r) => r.id);

  // Active plans per patient
  const plansResult = await pool.query(
    `SELECT patient_id, id AS plan_id, title, started_at
     FROM nutrition_plans
     WHERE nutri_id = $1 AND patient_id = ANY($2) AND status = 'active'`,
    [nutriId, patientIds]
  );
  const plansByPatient = new Map(plansResult.rows.map((r) => [r.patient_id, r]));

  // Adherence per patient: 7d + 30d
  const adherenceResult = await pool.query(
    `SELECT nac.patient_id,
            COUNT(*) FILTER (WHERE nac.check_date >= CURRENT_DATE - 6)  AS checkins_7d,
            COUNT(*) FILTER (WHERE nac.check_date >= CURRENT_DATE - 29) AS checkins_30d,
            MAX(nac.check_date) AS last_checkin_date
     FROM nutrition_adherence_checkins nac
     WHERE nac.patient_id = ANY($1)
     GROUP BY nac.patient_id`,
    [patientIds]
  );
  const adherenceByPatient = new Map(adherenceResult.rows.map((r) => [r.patient_id, r]));

  // Aderência REAL por refeição (P1-6): sobre nutrition_meal_checkins (granular),
  // não sobre o modelo diário legado nutrition_adherence_checkins (que só mede
  // "apareceu no dia"). Aderente = done+substituted (=1), partial = 0.5, resto = 0.
  // Denominador = refeições do plano × dias da janela. Só computa quando há dado
  // granular na janela; senão fica null e o frontend cai no proxy legado.
  const activePlanIds = plansResult.rows.map((r) => r.plan_id);
  const mealCountByPlan = new Map<number, number>();
  if (activePlanIds.length > 0) {
    const mealCountRes = await pool.query(
      `SELECT plan_id, COUNT(*)::int AS meal_count
         FROM nutrition_plan_meals WHERE plan_id = ANY($1) GROUP BY plan_id`,
      [activePlanIds]
    );
    for (const r of mealCountRes.rows) mealCountByPlan.set(r.plan_id, Number(r.meal_count));
  }
  const mealAdherenceRes = await pool.query(
    `SELECT patient_id,
            SUM(CASE WHEN status IN ('done','substituted') THEN 1 WHEN status = 'partial' THEN 0.5 ELSE 0 END)
              FILTER (WHERE check_date >= CURRENT_DATE - 6)  AS adherent_7d,
            COUNT(*) FILTER (WHERE check_date >= CURRENT_DATE - 6)  AS n_7d,
            SUM(CASE WHEN status IN ('done','substituted') THEN 1 WHEN status = 'partial' THEN 0.5 ELSE 0 END)
              FILTER (WHERE check_date >= CURRENT_DATE - 29) AS adherent_30d,
            COUNT(*) FILTER (WHERE check_date >= CURRENT_DATE - 29) AS n_30d
       FROM nutrition_meal_checkins
      WHERE patient_id = ANY($1)
      GROUP BY patient_id`,
    [patientIds]
  );
  const mealAdherenceByPatient = new Map(mealAdherenceRes.rows.map((r) => [r.patient_id, r]));

  return patientsResult.rows.map((p) => {
    const plan = plansByPatient.get(p.id) ?? null;
    const adherence = adherenceByPatient.get(p.id) ?? null;
    const checkins7d  = Number(adherence?.checkins_7d  ?? 0);
    const checkins30d = Number(adherence?.checkins_30d ?? 0);
    const lastCheckin = adherence?.last_checkin_date ?? null;

    const daysSinceLastCheckin = lastCheckin
      ? Math.floor((Date.now() - new Date(lastCheckin).getTime()) / 86400000)
      : null;

    const pct7d  = Math.round((checkins7d  / 7)  * 100);
    const pct30d = Math.round((checkins30d / 30) * 100);
    // adherenceDropFlag: 7d adherence fell ≥20pp vs 30d average
    const adherenceDropFlag = checkins30d >= 5 && pct7d < pct30d - 20;

    // Aderência real por refeição — null quando não há plano/refeições ou nenhum
    // check-in granular na janela (frontend cai no proxy legado).
    const mealsPerDay = plan ? mealCountByPlan.get(plan.plan_id) ?? 0 : 0;
    const ma = mealAdherenceByPatient.get(p.id);
    const mealPct = (adherent: unknown, n: unknown, days: number): number | null => {
      if (mealsPerDay <= 0 || Number(n ?? 0) <= 0) return null;
      return Math.min(100, Math.round((Number(adherent ?? 0) / (mealsPerDay * days)) * 100));
    };
    const mealAdherence7dPct = mealPct(ma?.adherent_7d, ma?.n_7d, 7);
    const mealAdherence30dPct = mealPct(ma?.adherent_30d, ma?.n_30d, 30);

    // riskFlag: sem plano ativo, OU sem check-in há >3 dias, OU aderência real às
    // refeições baixa (<40% na semana). O último critério dá utilidade ao sinal
    // do P1-6: um paciente que faz check-in mas NÃO segue o plano também está em
    // risco — antes passava despercebido (o proxy legado só via "apareceu").
    const riskFlag =
      !plan ||
      daysSinceLastCheckin === null ||
      daysSinceLastCheckin > 3 ||
      (mealAdherence7dPct !== null && mealAdherence7dPct < 40);

    return {
      id: p.id,
      name: p.name,
      email: p.email,
      photo_url: p.photo_url,
      academy_id: p.academy_id,
      activePlan: plan ?? null,
      adherence7d: checkins7d,
      adherence30d: checkins30d,
      mealAdherence7dPct,
      mealAdherence30dPct,
      lastCheckinDate: lastCheckin,
      riskFlag,
      adherenceDropFlag,
    };
  });
}

// ---------------------------------------------------------------------------
// User (aluno) — active plan view
// ---------------------------------------------------------------------------

export async function getUserActivePlan(userId: number) {
  const planResult = await pool.query(
    `SELECT np.*,
            u.name AS nutri_name,
            u.email AS nutri_email
     FROM nutrition_plans np
     JOIN users u ON u.id = np.nutri_id
     WHERE np.patient_id = $1 AND np.status = 'active'
     ORDER BY np.started_at DESC
     LIMIT 1`,
    [userId]
  );
  if (planResult.rows.length === 0) return null;
  const plan = planResult.rows[0];

  const mealsResult = await pool.query(
    `SELECT npm.*,
            COALESCE(
              json_agg(nma ORDER BY nma.order_index, nma.id) FILTER (WHERE nma.id IS NOT NULL),
              '[]'
            ) AS alternatives
     FROM nutrition_plan_meals npm
     LEFT JOIN nutrition_meal_alternatives nma ON nma.meal_id = npm.id
     WHERE npm.plan_id = $1
     GROUP BY npm.id
     ORDER BY npm.order_index, npm.id`,
    [plan.id]
  );

  // Today's checkin
  const today = new Date().toISOString().slice(0, 10);
  const checkinResult = await pool.query(
    `SELECT id, adherence, note, created_at
     FROM nutrition_adherence_checkins
     WHERE patient_id = $1 AND plan_id = $2 AND check_date = $3
     LIMIT 1`,
    [userId, plan.id, today]
  );

  return {
    ...plan,
    meals: mealsResult.rows,
    todayCheckin: checkinResult.rows[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// LGPD — patient requests deletion of their own nutritional data
// ---------------------------------------------------------------------------

export interface NutritionDeletionResult {
  mealCheckins: number;
  adherenceCheckins: number;
  voiceNotes: number;
  observations: number;
  plans: number;
}

export async function deletePatientNutritionData(
  patientId: number,
): Promise<NutritionDeletionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [mealCheckins, adherenceCheckins, voiceNotes, observations, plans] = await Promise.all([
      client.query(
        `DELETE FROM nutrition_meal_checkins WHERE patient_id = $1`,
        [patientId],
      ),
      client.query(
        `DELETE FROM nutrition_adherence_checkins WHERE patient_id = $1`,
        [patientId],
      ),
      client.query(
        `DELETE FROM nutrition_voice_notes WHERE patient_id = $1`,
        [patientId],
      ),
      client.query(
        `DELETE FROM nutrition_observations WHERE patient_id = $1`,
        [patientId],
      ),
      // Cascades to nutrition_plan_meals → nutrition_meal_alternatives
      client.query(
        `DELETE FROM nutrition_plans WHERE patient_id = $1`,
        [patientId],
      ),
    ]);

    await client.query('COMMIT');

    await logDataAccessEvent({
      actorId: patientId,
      subjectUserId: patientId,
      eventType: 'nutri.data.patient_deletion',
      eventPayload: {
        mealCheckins: mealCheckins.rowCount,
        adherenceCheckins: adherenceCheckins.rowCount,
        voiceNotes: voiceNotes.rowCount,
        observations: observations.rowCount,
        plans: plans.rowCount,
      },
    });

    return {
      mealCheckins: mealCheckins.rowCount ?? 0,
      adherenceCheckins: adherenceCheckins.rowCount ?? 0,
      voiceNotes: voiceNotes.rowCount ?? 0,
      observations: observations.rowCount ?? 0,
      plans: plans.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
