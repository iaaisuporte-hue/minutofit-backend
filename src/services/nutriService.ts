import pool from '../config/database';
import { hasActiveConsent } from './consentService';
import { getMetabolismForUser } from '../modules/metabolism/metabolic.service';

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

export interface MealInput {
  name: string;
  orientation: string;
  order_index: number;
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
      const mealValues = data.meals.map((m, i) =>
        `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
      ).join(', ');
      const mealParams = data.meals.flatMap((m) => [
        plan.id,
        m.name.trim().slice(0, 80),
        m.orientation.trim(),
        m.order_index ?? 0,
      ]);
      await client.query(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index)
         VALUES ${mealValues}`,
        mealParams
      );
    }

    await client.query('COMMIT');
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
    `SELECT * FROM nutrition_plan_meals
     WHERE plan_id = $1
     ORDER BY order_index, id`,
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

export async function endPlan(nutriId: number, planId: number) {
  const result = await pool.query(
    `UPDATE nutrition_plans
     SET status = 'ended', ended_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND nutri_id = $2 AND status = 'active'
     RETURNING *`,
    [planId, nutriId]
  );
  return result.rows[0] ?? null;
}

export async function updatePlan(
  nutriId: number,
  planId: number,
  payload: {
    title?: string;
    objective?: string;
    general_notes?: string;
    meals?: Array<{ name: string; orientation: string; order_index: number }>;
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
        await client.query(
          `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [planId, meal.name.trim(), meal.orientation.trim(), meal.order_index]
        );
      }
    }

    await client.query('COMMIT');

    const mealsResult = await pool.query(
      `SELECT id, name, orientation, order_index FROM nutrition_plan_meals WHERE plan_id = $1 ORDER BY order_index, id`,
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
  days = 7
) {
  const result = await pool.query(
    `SELECT check_date, adherence, note
     FROM nutrition_adherence_checkins
     WHERE patient_id = $1 AND plan_id = $2
       AND check_date >= CURRENT_DATE - ($3 - 1)
     ORDER BY check_date DESC`,
    [patientId, planId, days]
  );
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

  return {
    hasMetabolicConsent,
    hasDailyConsent,
    ...context,
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

  // Last 7 days adherence per patient
  const adherenceResult = await pool.query(
    `SELECT nac.patient_id,
            COUNT(*) FILTER (WHERE nac.check_date >= CURRENT_DATE - 6) AS checkins_7d,
            MAX(nac.check_date) AS last_checkin_date
     FROM nutrition_adherence_checkins nac
     WHERE nac.patient_id = ANY($1)
     GROUP BY nac.patient_id`,
    [patientIds]
  );
  const adherenceByPatient = new Map(adherenceResult.rows.map((r) => [r.patient_id, r]));

  return patientsResult.rows.map((p) => {
    const plan = plansByPatient.get(p.id) ?? null;
    const adherence = adherenceByPatient.get(p.id) ?? null;
    const checkins7d = Number(adherence?.checkins_7d ?? 0);
    const lastCheckin = adherence?.last_checkin_date ?? null;

    const daysSinceLastCheckin = lastCheckin
      ? Math.floor((Date.now() - new Date(lastCheckin).getTime()) / 86400000)
      : null;

    // riskFlag: no active plan OR no checkin in last 3 days
    const riskFlag = !plan || daysSinceLastCheckin === null || daysSinceLastCheckin > 3;

    return {
      id: p.id,
      name: p.name,
      email: p.email,
      photo_url: p.photo_url,
      academy_id: p.academy_id,
      activePlan: plan ?? null,
      adherence7d: checkins7d,
      lastCheckinDate: lastCheckin,
      riskFlag,
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
    `SELECT * FROM nutrition_plan_meals
     WHERE plan_id = $1
     ORDER BY order_index, id`,
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
