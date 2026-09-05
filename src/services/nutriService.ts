import type { PoolClient } from 'pg';
import pool from '../config/database';
import { hasActiveConsent, listActiveConsentScopesForProfessional } from './consentService';
import { getMetabolismForUser } from '../modules/metabolism/metabolic.service';
import { logDataAccessEvent } from './dataAccessAuditService';
import { dayKey, dayKeyDiff, minutesSinceMidnight } from '../utils/appDay';
import {
  type MealCheckinStatus as CanonicalMealCheckinStatus,
  weightedAdherenceSum,
  computeAdherence,
  computeStreak as computeCanonicalStreak,
  buildCanonicalAdherenceBlock,
} from './nutriAdherence';

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
  /**
   * Identidade da refeição já existente no plano (SPEC 035 / P1A.1). Presente
   * → reconcilia por UPDATE, preservando `id` e portanto todo histórico de
   * check-in e as notas de voz ancoradas nela. Ausente → INSERT (refeição
   * nova). Uma refeição existente que sai da lista sem seu `id` presente é
   * tratada como removida (soft-delete se tiver histórico, hard-delete se
   * nunca teve check-in).
   */
  id?: number;
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
  alternatives?: Array<{ id?: number; description: string; order_index: number }>;
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
     WHERE npm.plan_id = $1 AND npm.deleted_at IS NULL
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
  // SPEC 035 / NUTRI-02 (IDOR): o filtro precisa cruzar o recurso com o
  // PACIENTE, não só com o nutri. Sem `patient_id` aqui, um nutri conseguia
  // encerrar/ler o plano de um paciente qualquer roteando pelo `:patientId`
  // de outro paciente ainda vinculado — o `planId` nunca era confirmado como
  // pertencente ao titular que os gates de vínculo/consent validaram.
  const result = await pool.query(
    `UPDATE nutrition_plans
     SET status = 'ended', ended_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND nutri_id = $2 AND patient_id = $3 AND status = 'active'
     RETURNING *`,
    [planId, nutriId, patientId]
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

/**
 * Reconcilia as alternativas de UMA refeição contra o payload da nutri
 * (SPEC 035 / P1A.1). Nunca apaga uma alternativa referenciada por um
 * check-in "substituted" — perder essa linha perderia o registro de QUAL
 * alternativa o paciente escolheu, mesmo com o check-in em si preservado.
 */
async function reconcileMealAlternatives(
  client: PoolClient,
  mealId: number,
  alternatives: Array<{ id?: number; description: string; order_index: number }> | undefined,
): Promise<void> {
  const incoming = Array.isArray(alternatives) ? alternatives : [];
  const existingRes = await client.query<{ id: number }>(
    `SELECT id FROM nutrition_meal_alternatives WHERE meal_id = $1`,
    [mealId]
  );
  const existingIds = new Set(existingRes.rows.map((r) => r.id));
  const incomingIds = new Set(incoming.filter((a) => a.id != null).map((a) => a.id as number));

  for (const existingId of existingIds) {
    if (incomingIds.has(existingId)) continue;
    const used = await client.query(
      `SELECT 1 FROM nutrition_meal_checkins WHERE substituted_alternative_id = $1 LIMIT 1`,
      [existingId]
    );
    if (used.rows.length === 0) {
      await client.query(`DELETE FROM nutrition_meal_alternatives WHERE id = $1`, [existingId]);
    }
  }

  for (const alt of incoming) {
    if (alt.id != null && existingIds.has(alt.id)) {
      await client.query(
        `UPDATE nutrition_meal_alternatives SET description = $2, order_index = $3 WHERE id = $1`,
        [alt.id, alt.description.trim(), alt.order_index ?? 0]
      );
    } else {
      await client.query(
        `INSERT INTO nutrition_meal_alternatives (meal_id, description, order_index)
         VALUES ($1, $2, $3)`,
        [mealId, alt.description.trim(), alt.order_index ?? 0]
      );
    }
  }
}

/**
 * Reconcilia as refeições do plano contra o payload da nutri (SPEC 035 /
 * P1A.1 — a correção do BLOCKER NUTRI-01).
 *
 * O padrão anterior era `DELETE FROM nutrition_plan_meals WHERE plan_id = $1`
 * seguido de reinserção completa. Como `nutrition_meal_checkins.meal_id` é
 * `ON DELETE CASCADE`, editar QUALQUER campo do plano — inclusive só o título
 * — apagava todo o histórico de adesão do paciente. Reproduzido em navegador
 * real na P0: 97 check-ins → 0.
 *
 * Regra: refeição com `id` presente no payload → UPDATE (preserva a
 * identidade, e com ela o histórico e as alternativas). Sem `id` → INSERT
 * (refeição nova). Existente que sai do payload → soft-delete
 * (`deleted_at`) se tem check-in histórico; hard-delete só se nunca teve
 * nenhum (nada a preservar).
 */
async function reconcileMeals(
  client: PoolClient,
  planId: number,
  meals: MealInput[]
): Promise<void> {
  const existingRes = await client.query<{ id: number }>(
    `SELECT id FROM nutrition_plan_meals WHERE plan_id = $1 AND deleted_at IS NULL`,
    [planId]
  );
  const existingIds = new Set(existingRes.rows.map((r) => r.id));
  const incomingIds = new Set(meals.filter((m) => m.id != null).map((m) => m.id as number));

  for (const existingId of existingIds) {
    if (incomingIds.has(existingId)) continue;
    const used = await client.query(
      `SELECT 1 FROM nutrition_meal_checkins WHERE meal_id = $1 LIMIT 1`,
      [existingId]
    );
    if (used.rows.length > 0) {
      await client.query(
        `UPDATE nutrition_plan_meals SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [existingId]
      );
    } else {
      await client.query(`DELETE FROM nutrition_plan_meals WHERE id = $1`, [existingId]);
    }
  }

  for (const meal of meals) {
    let mealId: number;
    if (meal.id != null && existingIds.has(meal.id)) {
      await client.query(
        `UPDATE nutrition_plan_meals
            SET name = $2, orientation = $3, order_index = $4,
                meal_time = $5, tolerance_minutes = $6, reminder_minutes = $7,
                metabolic_goal = $8, workout_relation = $9,
                hydration_note = $10, supplement_note = $11,
                updated_at = NOW()
          WHERE id = $1 AND plan_id = $12`,
        [
          meal.id,
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
          planId,
        ]
      );
      mealId = meal.id;
    } else {
      const inserted = await client.query<{ id: number }>(
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
      mealId = inserted.rows[0].id;
    }
    await reconcileMealAlternatives(client, mealId, meal.alternatives);
  }
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

    // SPEC 035 / NUTRI-02 (IDOR): `AND patient_id = $6` é o que impede um
    // nutri de reescrever/encerrar o plano de um paciente diferente do
    // `:patientId` já validado pelos gates de vínculo/consent da rota,
    // roteando pelo `planId` de outro paciente ainda em sua carteira.
    const updated = await client.query(
      `UPDATE nutrition_plans
          SET title         = COALESCE(NULLIF(TRIM($3), ''), title),
              objective     = COALESCE($4, objective),
              general_notes = COALESCE($5, general_notes),
              updated_at    = NOW()
        WHERE id = $1 AND nutri_id = $2 AND patient_id = $6 AND status = 'active'
        RETURNING *`,
      [planId, nutriId, title ?? null, objective ?? null, general_notes ?? null, patientId]
    );

    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    if (meals !== undefined) {
      await reconcileMeals(client, planId, meals);
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
       WHERE npm.plan_id = $1 AND npm.deleted_at IS NULL
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
        AND nac.check_date >= $3::date - ($2 - 1)
      ORDER BY nac.check_date DESC`,
    [patientId, days, dayKey()]
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

  // SPEC 035 / NUTRI-07: dia do ALUNO (BRT), não o dia UTC do processo — um
  // check-in às 21h30 não pode cair no dia seguinte e sobrescrever/perder o
  // registro daquele dia.
  const today = dayKey();

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
       AND check_date >= $4::date - ($3 - 1)
     ORDER BY check_date DESC`,
    [patientId, planId, days, dayKey()]
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
       WHERE user_id = $1 AND date_key >= $2::date - 6
       ORDER BY date_key DESC`,
      [patientId, dayKey()]
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
  nowMinutes: number // minutes since midnight, no fuso do ALUNO — ver minutesSinceMidnight()
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
  // SPEC 035 / NUTRI-07: dia do aluno (BRT), não o dia UTC do processo.
  const today = dayKey();

  const [mealsResult, workoutResult, streakResult] = await Promise.all([
    pool.query(
      `SELECT npm.*,
              COALESCE(
                json_agg(nma ORDER BY nma.order_index, nma.id) FILTER (WHERE nma.id IS NOT NULL),
                '[]'
              ) AS alternatives
       FROM nutrition_plan_meals npm
       LEFT JOIN nutrition_meal_alternatives nma ON nma.meal_id = npm.id
       WHERE npm.plan_id = $1 AND npm.deleted_at IS NULL
       GROUP BY npm.id
       ORDER BY npm.meal_time NULLS LAST, npm.order_index, npm.id`,
      [plan.plan_id]
    ),
    // Workout logged today (no fuso do aluno) — drives pre/post meal context
    pool.query(
      `SELECT title, muscle_groups
       FROM user_workout_logs
       WHERE user_id = $1 AND (completed_at AT TIME ZONE $2)::date = $3::date
       ORDER BY completed_at DESC
       LIMIT 1`,
      [userId, 'America/Sao_Paulo', today]
    ),
    // Status por dia dos últimos 60 dias — insumo do streak canônico
    // (SPEC 035 / NUTRI-15: única definição, compartilhada com a tela da nutri).
    pool.query(
      `SELECT check_date::text AS check_date, status
       FROM nutrition_meal_checkins
       WHERE patient_id = $1 AND check_date >= $2::date - 59
       ORDER BY check_date DESC`,
      [userId, today]
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

  const statusesByDay = new Map<string, CanonicalMealCheckinStatus[]>();
  for (const row of streakResult.rows) {
    const list = statusesByDay.get(row.check_date) ?? [];
    list.push(row.status as CanonicalMealCheckinStatus);
    statusesByDay.set(row.check_date, list);
  }
  const streak = computeCanonicalStreak(statusesByDay, today);

  const nowMinutes = minutesSinceMidnight(new Date());

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
  // Validate meal belongs to user's active plan (e não foi removida — SPEC 035)
  const mealCheck = await pool.query(
    `SELECT npm.id, npm.plan_id
     FROM nutrition_plan_meals npm
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE npm.id = $1 AND np.patient_id = $2 AND np.status = 'active' AND npm.deleted_at IS NULL`,
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

  // SPEC 035 / NUTRI-07: dia do aluno (BRT). Antes, um check-in às 21h30
  // caía no dia UTC seguinte e, por causa do UNIQUE(patient_id, meal_id,
  // check_date), o UPDATE-on-conflict abaixo SOBRESCREVIA o registro de outro
  // dia real — o jantar de segunda virava o de terça, apagando o de segunda.
  const today = dayKey();

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
  const today = dayKey();

  // SPEC 035 / NUTRI-34: `ORDER BY started_at DESC, id DESC` — sem isso, se
  // algum dia existirem dois planos 'active' para o mesmo par (nada no schema
  // impedia), o `LIMIT 1` escolhia uma linha indefinida a critério do
  // planejador, podendo variar entre chamadas.
  const planResult = await pool.query(
    `SELECT np.id AS plan_id, np.title, np.started_at
     FROM nutrition_plans np
     WHERE np.nutri_id = $1 AND np.patient_id = $2 AND np.status = 'active'
     ORDER BY np.started_at DESC, np.id DESC
     LIMIT 1`,
    [nutriId, patientId]
  );
  if (planResult.rows.length === 0) return { plan: null, meals: [], checkins: [], adherence: null };
  const plan = planResult.rows[0];

  const mealsResult = await pool.query(
    `SELECT id, name, meal_time, order_index
     FROM nutrition_plan_meals
     WHERE plan_id = $1 AND deleted_at IS NULL
     ORDER BY meal_time NULLS LAST, order_index, id`,
    [plan.plan_id]
  );
  const mealsPerDay = mealsResult.rows.length;

  // `checkins` (janela pedida pelo cliente, para o grid visual) e o par de
  // janelas CANÔNICAS de 14/60 dias (para o bloco de verdade — sempre fixo,
  // independente do `days` que a UI pediu) são consultas separadas de
  // propósito: a UI pode pedir 7 no mobile, mas o cálculo de verdade nunca
  // pode variar com o viewport (SPEC 035 / NUTRI-04 — 46% no desktop, 93% no
  // celular, mesmo paciente, mesmo instante).
  const [checkinsResult, canonical14dResult, canonical60dResult] = await Promise.all([
    pool.query(
      `SELECT meal_id, check_date, status
       FROM nutrition_meal_checkins
       WHERE patient_id = $1 AND plan_id = $2
         AND check_date >= $4::date - ($3 - 1)
       ORDER BY check_date DESC, meal_id`,
      [patientId, plan.plan_id, days, today]
    ),
    pool.query(
      `SELECT check_date::text AS check_date, status
       FROM nutrition_meal_checkins
       WHERE patient_id = $1 AND plan_id = $2 AND check_date >= $3::date - 13
       ORDER BY check_date DESC`,
      [patientId, plan.plan_id, today]
    ),
    pool.query(
      `SELECT check_date::text AS check_date, status
       FROM nutrition_meal_checkins
       WHERE patient_id = $1 AND plan_id = $2 AND check_date >= $3::date - 59
       ORDER BY check_date DESC`,
      [patientId, plan.plan_id, today]
    ),
  ]);

  const daysSincePlanStart = dayKeyDiff(dayKey(new Date(plan.started_at)), today);
  const statusesByDay60d = new Map<string, CanonicalMealCheckinStatus[]>();
  for (const row of canonical60dResult.rows) {
    const list = statusesByDay60d.get(row.check_date) ?? [];
    list.push(row.status);
    statusesByDay60d.set(row.check_date, list);
  }

  const adherence = mealsPerDay > 0
    ? buildCanonicalAdherenceBlock({
        checkins14d: canonical14dResult.rows.map((r) => ({ checkDate: r.check_date, status: r.status })),
        mealsPerDay,
        daysSincePlanStart,
        todayKey: today,
        statusesByDay60d,
      })
    : null;

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
    adherence,
  };
}

// ---------------------------------------------------------------------------
// Enriched patients list (nutri dashboard)
// ---------------------------------------------------------------------------

/**
 * Carteira enriquecida do nutri — SPEC 035 / P1A.4 (definição canônica de
 * aderência, streak, tendência e risco).
 *
 * Antes: SEIS definições de "aderência" coexistiam no módulo, com denominador
 * fixo (÷7, ÷30) que ignorava quando o plano/vínculo começou — um paciente de
 * 2 dias com 100% de adesão real lia "29%" e nascia marcado "Atenção". Esta
 * versão usa `nutriAdherence.ts` (mesma função que `getMealHeatmap` usa no
 * detalhe) para que a carteira e a tela do paciente NUNCA mais divirjam.
 */
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
  const today = dayKey();

  // SPEC 035 / NUTRI-SEC-02: a listagem agregada é a única leitura do módulo
  // fora do gate de consent do prefixo `/patients/:patientId` — sem isso, um
  // paciente com TODOS os escopos revogados continuava aparecendo com plano,
  // e-mail e aderência visíveis. `profile` cobre identidade/plano; `nutrition`
  // cobre o conteúdo nutricional propriamente dito.
  const consentByPatient = await listActiveConsentScopesForProfessional(nutriId, 'nutri');
  const consentedPatientIds: number[] = [];
  for (const id of patientIds) {
    const scopes = consentByPatient.get(id);
    if (scopes?.has('profile')) consentedPatientIds.push(id);
  }
  if (consentedPatientIds.length > 0) {
    await Promise.all(
      consentedPatientIds.map((id) =>
        logDataAccessEvent({
          actorId: nutriId,
          subjectUserId: id,
          eventType: 'nutri.patients_list.read',
          eventPayload: {},
        })
      )
    );
  }

  // Plano ativo por paciente — precisa de `started_at` para o denominador
  // proporcional (SPEC 035 / NUTRI-13).
  const plansResult = await pool.query(
    `SELECT patient_id, id AS plan_id, title, started_at
     FROM nutrition_plans
     WHERE nutri_id = $1 AND patient_id = ANY($2) AND status = 'active'`,
    [nutriId, patientIds]
  );
  const plansByPatient = new Map(plansResult.rows.map((r) => [r.patient_id, r]));
  const activePlanIds = plansResult.rows.map((r) => r.plan_id);

  const mealCountByPlan = new Map<number, number>();
  if (activePlanIds.length > 0) {
    const mealCountRes = await pool.query(
      `SELECT plan_id, COUNT(*)::int AS meal_count
         FROM nutrition_plan_meals WHERE plan_id = ANY($1) AND deleted_at IS NULL GROUP BY plan_id`,
      [activePlanIds]
    );
    for (const r of mealCountRes.rows) mealCountByPlan.set(r.plan_id, Number(r.meal_count));
  }

  // Check-ins LEGADOS (modelo diário) — SPEC 035 / NUTRI-32: filtrados por
  // `plan_id = ANY(activePlanIds)`, não só `patient_id`, para não misturar
  // check-ins de um plano encerrado/trocado com a métrica do plano vigente.
  // Contagens mantidas (não só a última data) porque o frontend usa
  // `adherence7d`/`adherence30d` como proxy legado quando não há dado
  // granular ainda.
  const legacyRes = activePlanIds.length > 0
    ? await pool.query<{ patient_id: number; checkins_7d: string; checkins_30d: string; last_checkin_date: string | null }>(
        `SELECT patient_id,
                COUNT(*) FILTER (WHERE check_date >= $3::date - 6)  AS checkins_7d,
                COUNT(*) FILTER (WHERE check_date >= $3::date - 29) AS checkins_30d,
                MAX(check_date)::text AS last_checkin_date
           FROM nutrition_adherence_checkins
          WHERE patient_id = ANY($1) AND plan_id = ANY($2)
          GROUP BY patient_id`,
        [patientIds, activePlanIds, today]
      )
    : { rows: [] as Array<{ patient_id: number; checkins_7d: string; checkins_30d: string; last_checkin_date: string | null }> };
  const legacyByPatient = new Map(legacyRes.rows.map((r) => [r.patient_id, r]));

  // Check-ins granulares dos últimos 30 dias — cobre a janela de 7d (pct e
  // trend) e a de 30d (campo legado, hoje não exibido em tela nenhuma —
  // NUTRI-46), tudo restrito ao plano ATIVO de cada paciente (NUTRI-32).
  const granular30dRes = activePlanIds.length > 0
    ? await pool.query<{ patient_id: number; check_date: string; status: CanonicalMealCheckinStatus }>(
        `SELECT patient_id, check_date::text AS check_date, status
           FROM nutrition_meal_checkins
          WHERE patient_id = ANY($1) AND plan_id = ANY($2) AND check_date >= $3::date - 29
          ORDER BY check_date DESC`,
        [patientIds, activePlanIds, today]
      )
    : { rows: [] as Array<{ patient_id: number; check_date: string; status: CanonicalMealCheckinStatus }> };

  const checkins30dByPatient = new Map<number, Array<{ checkDate: string; status: CanonicalMealCheckinStatus }>>();
  const statusesByDay60dByPatient = new Map<number, Map<string, CanonicalMealCheckinStatus[]>>();
  const granularLastByPatient = new Map<number, string>();
  for (const row of granular30dRes.rows) {
    const list = checkins30dByPatient.get(row.patient_id) ?? [];
    list.push({ checkDate: row.check_date, status: row.status });
    checkins30dByPatient.set(row.patient_id, list);

    const byDay = statusesByDay60dByPatient.get(row.patient_id) ?? new Map<string, CanonicalMealCheckinStatus[]>();
    const dayList = byDay.get(row.check_date) ?? [];
    dayList.push(row.status);
    byDay.set(row.check_date, dayList);
    statusesByDay60dByPatient.set(row.patient_id, byDay);

    const prevMax = granularLastByPatient.get(row.patient_id);
    if (!prevMax || row.check_date > prevMax) granularLastByPatient.set(row.patient_id, row.check_date);
  }

  return patientsResult.rows.map((p) => {
    const scopes = consentByPatient.get(p.id);
    const hasProfileConsent = scopes?.has('profile') ?? false;
    const hasNutritionConsent = scopes?.has('nutrition') ?? false;

    // Sem `profile`: o paciente aparece na carteira (o vínculo é real e o
    // nutri precisa saber quem tem), mas nada de identidade/plano/aderência
    // é exposto. Antes deste fix, revogar TODO o consentimento não mudava
    // nada nesta rota (SPEC 035 / NUTRI-SEC-02).
    if (!hasProfileConsent) {
      return {
        id: p.id,
        name: p.name,
        email: null,
        photo_url: null,
        academy_id: p.academy_id,
        activePlan: null,
        adherence7d: 0,
        adherence30d: 0,
        mealAdherence7dPct: null,
        mealAdherence30dPct: null,
        lastCheckinDate: null,
        riskFlag: false,
        adherenceDropFlag: false,
        adherenceState: null,
        streakDays: 0,
        trend: null,
        consentRevoked: true,
      };
    }

    const plan = plansByPatient.get(p.id) ?? null;

    // Perfil concedido, mas nutrição não: mantém identidade, redige plano e
    // aderência — mesma fronteira que `requireActiveConsent('nutrition')`
    // aplica nas rotas individuais de plano/heatmap.
    if (!hasNutritionConsent) {
      return {
        id: p.id,
        name: p.name,
        email: p.email,
        photo_url: p.photo_url,
        academy_id: p.academy_id,
        activePlan: null,
        adherence7d: 0,
        adherence30d: 0,
        mealAdherence7dPct: null,
        mealAdherence30dPct: null,
        lastCheckinDate: null,
        riskFlag: false,
        adherenceDropFlag: false,
        adherenceState: null,
        streakDays: 0,
        trend: null,
        consentRevoked: true,
      };
    }

    const mealsPerDay = plan ? mealCountByPlan.get(plan.plan_id) ?? 0 : 0;
    const daysSincePlanStart = plan ? dayKeyDiff(dayKey(new Date(plan.started_at)), today) : null;

    const checkins30d = checkins30dByPatient.get(p.id) ?? [];
    const statusesByDay60d = statusesByDay60dByPatient.get(p.id) ?? new Map();

    const canonical = mealsPerDay > 0
      ? buildCanonicalAdherenceBlock({
          checkins14d: checkins30d, // superset de 30d — a função só olha as janelas de 7/14 que precisa
          mealsPerDay,
          daysSincePlanStart,
          todayKey: today,
          statusesByDay60d,
        })
      : null;

    const sum30d = weightedAdherenceSum(checkins30d.map((c) => c.status));
    const a30 = mealsPerDay > 0 ? computeAdherence(sum30d, mealsPerDay, 30, daysSincePlanStart) : null;

    // Última atividade REAL do paciente — combina os dois modelos de
    // check-in (SPEC 035 / NUTRI-14: antes, um paciente que só usava a
    // timeline granular tinha `lastCheckinDate: null` e nascia com risco
    // permanente mesmo com 100% de adesão real no mesmo card).
    const legacy = legacyByPatient.get(p.id) ?? null;
    const legacyLast = legacy?.last_checkin_date ?? null;
    const granularLast = granularLastByPatient.get(p.id) ?? null;
    const lastActivity = [legacyLast, granularLast].filter((d): d is string => !!d).sort().pop() ?? null;
    const daysSinceLastActivity = lastActivity ? dayKeyDiff(lastActivity, today) : null;

    // riskFlag: sem plano ativo é sempre digno de atenção, independente de
    // calibração. Com plano, os demais critérios só valem depois que o
    // vínculo tem sinal suficiente para significar algo (SPEC 035 / NUTRI-13
    // e NUTRI-14) — um paciente de 1-2 dias, por definição, não tem "3 dias
    // sem check-in" nem "adesão baixa" que façam sentido.
    const calibrating = canonical?.adherenceState === 'calibrating';
    const riskFlag =
      !plan ||
      (!calibrating && (
        daysSinceLastActivity === null ||
        daysSinceLastActivity > 3 ||
        (canonical?.adherencePct !== null && canonical !== null && canonical.adherencePct! < 40)
      ));

    // adherenceDropFlag agora É a tendência canônica — mesma função que a
    // aba Adesão do detalhe, nunca mais um segundo cálculo (SPEC 035 / NUTRI-09/33).
    const adherenceDropFlag = canonical?.trend === 'down';

    return {
      id: p.id,
      name: p.name,
      email: p.email,
      photo_url: p.photo_url,
      academy_id: p.academy_id,
      activePlan: plan ?? null,
      // Campos legados mantidos por compatibilidade de contrato com o
      // frontend atual (fallback quando não há dado granular) — não usados
      // para cálculo interno de risco/tendência, que agora vêm 100% de
      // `canonical`.
      adherence7d: Number(legacy?.checkins_7d ?? 0),
      adherence30d: Number(legacy?.checkins_30d ?? 0),
      mealAdherence7dPct: canonical?.adherencePct ?? null,
      mealAdherence30dPct: a30?.pct ?? null,
      lastCheckinDate: lastActivity,
      riskFlag,
      adherenceDropFlag,
      // Campos canônicos novos (SPEC 035) — a UI deve migrar para eles;
      // ver relatório de conclusão P1A para o plano de descontinuação dos
      // campos legados acima.
      adherenceState: canonical?.adherenceState ?? (plan ? 'calibrating' : null),
      streakDays: canonical?.streakDays ?? 0,
      trend: canonical?.trend ?? null,
      consentRevoked: false,
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
     ORDER BY np.started_at DESC, np.id DESC
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
     WHERE npm.plan_id = $1 AND npm.deleted_at IS NULL
     GROUP BY npm.id
     ORDER BY npm.order_index, npm.id`,
    [plan.id]
  );

  // Today's checkin — SPEC 035 / NUTRI-07: dia do aluno (BRT).
  const today = dayKey();
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
