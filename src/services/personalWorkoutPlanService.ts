import pool from '../config/database';

export type WorkoutPlanItemPayload = {
  exerciseId: string;
  name: string;
  sets: string;
  reps: string;
  rest: string;
  rpe?: string;
  cadence?: string;
  restPause?: boolean;
  notes?: string;
};

export type WorkoutPlanDay = {
  index: number;
  name: string;
  focus: string | null;
  items: WorkoutPlanItemPayload[];
};

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidExerciseId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

export type SanitizeItemResult =
  | { ok: true; item: WorkoutPlanItemPayload }
  | { ok: false; reason: string };

export function sanitizeWorkoutPlanItem(raw: unknown): SanitizeItemResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'item deve ser um objeto' };
  const r = raw as Record<string, unknown>;

  if (r.legacy === true) {
    return { ok: false, reason: 'exercício legado (legacy:true) não é permitido em novos planos' };
  }

  const exerciseId = sanitizeString(r.exerciseId, 64);
  if (!isValidExerciseId(exerciseId)) {
    return {
      ok: false,
      reason: `exerciseId inválido: "${exerciseId}" não é um UUID v4 da biblioteca de exercícios`,
    };
  }

  const name = sanitizeString(r.name, 200);
  if (!name) return { ok: false, reason: 'campo name é obrigatório' };

  const item: WorkoutPlanItemPayload = {
    exerciseId,
    name,
    sets: sanitizeString(r.sets, 32),
    reps: sanitizeString(r.reps, 32),
    rest: sanitizeString(r.rest, 32),
  };

  const rpe = sanitizeString(r.rpe, 16);
  if (rpe) item.rpe = rpe;

  const cadence = sanitizeString(r.cadence, 16);
  if (cadence) item.cadence = cadence;

  if (r.restPause === true) item.restPause = true;

  const notes = sanitizeString(r.notes, 500);
  if (notes) item.notes = notes;

  return { ok: true, item };
}

export function validateWorkoutItems(rawItems: unknown[]): WorkoutPlanItemPayload[] {
  const errors: string[] = [];
  const valid: WorkoutPlanItemPayload[] = [];

  rawItems.forEach((raw, idx) => {
    const result = sanitizeWorkoutPlanItem(raw);
    if (result.ok) {
      valid.push(result.item);
    } else {
      errors.push(`item[${idx}]: ${result.reason}`);
    }
  });

  if (errors.length > 0) {
    const err = new Error('Exercícios inválidos no plano');
    (err as any).code = 'INVALID_EXERCISES';
    (err as any).details = errors;
    throw err;
  }

  return valid;
}

export async function assertStudentAssignedToPersonal(personalId: number, studentId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM personal_student_assignments
     WHERE personal_id = $1
       AND student_id = $2
       AND status = 'active'
     LIMIT 1`,
    [personalId, studentId]
  );
  return result.rows.length > 0;
}

/** Shapes a raw row (from DB) into the wire format including days[]. */
function shapeRow(row: Record<string, any>): any {
  const rawDays: any[] = Array.isArray(row.days) ? row.days : [];
  const filteredDays = rawDays.filter((d: any) => d && d.index != null);

  let days: WorkoutPlanDay[];
  if (filteredDays.length > 0) {
    days = filteredDays.map((d: any) => ({
      index: d.index,
      name: d.name ?? 'Dia',
      focus: d.focus ?? null,
      items: Array.isArray(d.items) ? d.items : [],
    }));
  } else {
    // Legado: sintetiza um dia único a partir de payload_json
    const legacyItems: WorkoutPlanItemPayload[] = Array.isArray(row.payload_json) ? row.payload_json : [];
    days = [
      {
        index: 1,
        name: 'Único',
        focus: row.selected_group ?? null,
        items: legacyItems,
      },
    ];
  }

  return {
    id: row.id,
    personal_id: row.personal_id,
    student_id: row.student_id,
    academy_id: row.academy_id ?? null,
    title: row.title,
    week_preset: row.week_preset,
    selected_group: row.selected_group,
    payload_json: Array.isArray(row.payload_json) ? row.payload_json : [],
    days,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Shared SELECT with days aggregated as JSON. */
const SELECT_WITH_DAYS = `
  SELECT
    p.id,
    p.personal_id,
    p.student_id,
    p.academy_id,
    p.title,
    p.week_preset,
    p.selected_group,
    p.payload_json,
    p.created_at,
    p.updated_at,
    COALESCE(
      json_agg(
        json_build_object(
          'index', d.day_index,
          'name',  d.name,
          'focus', d.focus,
          'items', d.payload_json
        ) ORDER BY d.day_index
      ) FILTER (WHERE d.id IS NOT NULL),
      '[]'::json
    ) AS days
  FROM personal_workout_plans p
  LEFT JOIN personal_workout_plan_days d ON d.plan_id = p.id
`;

/**
 * Creates a multi-day workout plan in a single transaction.
 * Each element of `days` maps to a row in `personal_workout_plan_days`.
 */
export async function createPersonalWorkoutPlanWithDays(
  personalId: number,
  studentId: number,
  academyId: number | null,
  input: {
    title: string;
    weekPreset: string;
    days: Array<{ name: string; focus?: string | null; items: unknown[] }>;
  }
) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parentResult = await client.query(
      `INSERT INTO personal_workout_plans
         (personal_id, student_id, academy_id, title, week_preset, selected_group, payload_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, CURRENT_TIMESTAMP)
       RETURNING id, personal_id, student_id, academy_id, title, week_preset, selected_group, payload_json, created_at, updated_at`,
      [personalId, studentId, academyId, title, weekPreset, null]
    );
    const parent = parentResult.rows[0];
    const planId = parent.id;

    const days: WorkoutPlanDay[] = [];
    for (let i = 0; i < input.days.length; i++) {
      const d = input.days[i];
      const dayName = sanitizeString(d.name, 120) || `Dia ${i + 1}`;
      const dayFocus = d.focus ? sanitizeString(d.focus, 120) : null;
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = validateWorkoutItems(rawItems);

      await client.query(
        `INSERT INTO personal_workout_plan_days
           (plan_id, day_index, name, focus, payload_json, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
        [planId, i + 1, dayName, dayFocus, JSON.stringify(items)]
      );

      days.push({ index: i + 1, name: dayName, focus: dayFocus, items });
    }

    await client.query('COMMIT');

    return { ...parent, days };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Legacy single-list save — wraps items into a single day child row
 * so the response is consistent with the multi-day format.
 */
export async function createPersonalWorkoutPlan(
  personalId: number,
  studentId: number,
  academyId: number | null,
  input: {
    title: string;
    weekPreset: string;
    selectedGroup: string | null;
    items: WorkoutPlanItemPayload[];
  }
) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);
  const selectedGroup = input.selectedGroup ? String(input.selectedGroup).slice(0, 64) : null;
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = validateWorkoutItems(rawItems);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insert = await client.query(
      `INSERT INTO personal_workout_plans (
         personal_id, student_id, academy_id, title, week_preset, selected_group, payload_json, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
       RETURNING id, personal_id, student_id, academy_id, title, week_preset, selected_group, payload_json, created_at, updated_at`,
      [personalId, studentId, academyId, title, weekPreset, selectedGroup, JSON.stringify(items)]
    );
    const parent = insert.rows[0];

    await client.query(
      `INSERT INTO personal_workout_plan_days
         (plan_id, day_index, name, focus, payload_json, updated_at)
       VALUES ($1, 1, 'Único', $2, $3::jsonb, CURRENT_TIMESTAMP)`,
      [parent.id, selectedGroup, JSON.stringify(items)]
    );

    await client.query('COMMIT');

    return shapeRow({
      ...parent,
      days: [{ index: 1, name: 'Único', focus: selectedGroup, items }],
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listPersonalWorkoutPlans(personalId: number, studentId: number, limit = 50) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const result = await pool.query(
    `${SELECT_WITH_DAYS}
     WHERE p.personal_id = $1 AND p.student_id = $2
     GROUP BY p.id
     ORDER BY p.updated_at DESC
     LIMIT $3`,
    [personalId, studentId, safeLimit]
  );

  return result.rows.map(shapeRow);
}

export async function listWorkoutPlansForStudent(studentId: number, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await pool.query(
    `${SELECT_WITH_DAYS}
     WHERE p.student_id = $1
     GROUP BY p.id
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [studentId, safeLimit]
  );

  return result.rows.map(shapeRow);
}
