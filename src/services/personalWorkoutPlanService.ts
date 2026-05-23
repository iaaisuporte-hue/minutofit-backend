import pool from '../config/database';
import type { PoolClient } from 'pg';

export type TechniqueType = 'none' | 'drop_set' | 'rest_pause' | 'bi_set';

export type TechniqueConfig = {
  type: TechniqueType;
  drops?: number;
  dropPercent?: number;
  pauseSeconds?: number;
  miniSets?: number;
  biSetGroupId?: string;
};

export type WorkoutPlanItemPayload = {
  exerciseId: string;
  name: string;
  sets: string;
  reps: string;
  rest: string;
  rpe?: string;
  cadence?: string;
  restPause?: boolean;
  technique?: TechniqueConfig;
  notes?: string;
};

export type WorkoutPlanDay = {
  index: number;
  name: string;
  focus: string | null;
  items: WorkoutPlanItemPayload[];
};

type WorkoutProtocolDayInput = {
  name: string;
  focus?: string | null;
  items: WorkoutPlanItemPayload[];
};

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TECHNIQUE_TYPES: ReadonlySet<TechniqueType> = new Set([
  'none',
  'drop_set',
  'rest_pause',
  'bi_set',
]);

function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n);
}

export type SanitizeTechniqueResult =
  | { ok: true; technique: TechniqueConfig | undefined }
  | { ok: false; reason: string };

export function sanitizeTechniqueConfig(raw: unknown): SanitizeTechniqueResult {
  if (raw == null) return { ok: true, technique: undefined };
  if (typeof raw !== 'object') return { ok: false, reason: 'technique deve ser objeto' };
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? (r.type as TechniqueType) : 'none';
  if (!TECHNIQUE_TYPES.has(type)) {
    return { ok: false, reason: `technique.type inválido: "${type}"` };
  }
  if (type === 'none') return { ok: true, technique: undefined };

  const technique: TechniqueConfig = { type };

  if (type === 'drop_set') {
    if (r.drops !== undefined) {
      const drops = clampNumber(r.drops, 1, 3);
      if (drops === null) return { ok: false, reason: 'technique.drops deve estar entre 1 e 3' };
      technique.drops = drops;
    }
    if (r.dropPercent !== undefined) {
      const pct = clampNumber(r.dropPercent, 10, 50);
      if (pct === null) return { ok: false, reason: 'technique.dropPercent deve estar entre 10 e 50' };
      technique.dropPercent = pct;
    }
  }

  if (type === 'rest_pause') {
    if (r.pauseSeconds !== undefined) {
      const pause = clampNumber(r.pauseSeconds, 10, 30);
      if (pause === null) return { ok: false, reason: 'technique.pauseSeconds deve estar entre 10 e 30' };
      technique.pauseSeconds = pause;
    }
    if (r.miniSets !== undefined) {
      const mini = clampNumber(r.miniSets, 1, 4);
      if (mini === null) return { ok: false, reason: 'technique.miniSets deve estar entre 1 e 4' };
      technique.miniSets = mini;
    }
  }

  if (type === 'bi_set') {
    if (typeof r.biSetGroupId !== 'string' || !UUID_V4_RE.test(r.biSetGroupId)) {
      return { ok: false, reason: 'technique.biSetGroupId deve ser UUID v4' };
    }
    technique.biSetGroupId = r.biSetGroupId;
  }

  return { ok: true, technique };
}

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

  const techniqueResult = sanitizeTechniqueConfig(r.technique);
  if (!techniqueResult.ok) {
    return { ok: false, reason: techniqueResult.reason };
  }
  if (techniqueResult.technique) {
    item.technique = techniqueResult.technique;
  } else if (item.restPause === true && r.technique === undefined) {
    item.technique = { type: 'rest_pause' };
  }

  const notes = sanitizeString(r.notes, 500);
  if (notes) item.notes = notes;

  return { ok: true, item };
}

export function validateBiSetPairs(items: WorkoutPlanItemPayload[]): string[] {
  const groupCounts = new Map<string, number>();
  for (const it of items) {
    if (it.technique?.type === 'bi_set' && it.technique.biSetGroupId) {
      const id = it.technique.biSetGroupId;
      groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1);
    }
  }
  const errors: string[] = [];
  groupCounts.forEach((count, id) => {
    if (count !== 2) {
      errors.push(`bi-set group ${id} tem ${count} exercício(s); deve ter exatamente 2 no mesmo dia`);
    }
  });
  return errors;
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


function buildProtocolItemsFromDays(days: WorkoutProtocolDayInput[]): WorkoutPlanItemPayload[] {
  const firstNonEmpty = days.find((day) => day.items.length > 0);
  return firstNonEmpty?.items ?? [];
}

async function assertProtocolVisibleToPersonal(
  client: PoolClient,
  personalId: number,
  academyId: number | null,
  protocolId: number
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM workout_protocols
     WHERE id = $1
       AND (
         (scope = 'platform' AND academy_id IS NULL)
         OR (scope = 'academy' AND academy_id = $3)
         OR (scope = 'personal' AND owner_personal_id = $2 AND ($3::int IS NULL AND academy_id IS NULL OR academy_id = $3))
       )
     LIMIT 1`,
    [protocolId, personalId, academyId]
  );
  if (!result.rows.length) {
    const err = new Error('Protocol not found');
    (err as { code?: string }).code = 'PROTOCOL_NOT_FOUND';
    throw err;
  }
}

async function createPersonalProtocolSnapshot(
  client: PoolClient,
  personalId: number,
  academyId: number | null,
  input: {
    title: string;
    weekPreset: string;
    selectedGroup: string | null;
    days: WorkoutProtocolDayInput[];
  }
): Promise<number> {
  const days = input.days.map((day, idx) => ({
    index: idx + 1,
    name: sanitizeString(day.name, 120) || `Dia ${idx + 1}`,
    focus: day.focus ? sanitizeString(day.focus, 120) : null,
    items: day.items,
  }));
  const items = buildProtocolItemsFromDays(days);
  if (!items.length) throw new Error('At least one valid exercise item is required');

  const result = await client.query(
    `INSERT INTO workout_protocols
       (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json, days_json, updated_at)
     VALUES ('personal', $1, $2, $3, NULL, '{}'::jsonb, $4, $5, $6::jsonb, $7::jsonb, NOW())
     RETURNING id`,
    [
      academyId,
      personalId,
      input.title,
      input.weekPreset,
      input.selectedGroup,
      JSON.stringify(items),
      JSON.stringify(days),
    ]
  );
  return Number(result.rows[0].id);
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
    source_protocol_id: row.source_protocol_id ?? null,
    title: row.title,
    week_preset: row.week_preset,
    selected_group: row.selected_group,
    payload_json: Array.isArray(row.payload_json) ? row.payload_json : [],
    days,
    created_at: row.created_at,
    updated_at: row.updated_at,
    abandoned_at: row.abandoned_at ?? null,
  };
}

/** Shared SELECT with days aggregated as JSON. */
const SELECT_WITH_DAYS = `
  SELECT
    p.id,
    p.personal_id,
    p.student_id,
    p.academy_id,
    p.source_protocol_id,
    p.title,
    p.week_preset,
    p.selected_group,
    p.payload_json,
    p.created_at,
    p.updated_at,
    p.abandoned_at,
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
    sourceProtocolId?: number | null;
  }
) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const days: WorkoutPlanDay[] = [];
    for (let i = 0; i < input.days.length; i++) {
      const d = input.days[i];
      const dayName = sanitizeString(d.name, 120) || `Dia ${i + 1}`;
      const dayFocus = d.focus ? sanitizeString(d.focus, 120) : null;
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = validateWorkoutItems(rawItems);
      const biSetErrors = validateBiSetPairs(items);
      if (biSetErrors.length > 0) {
        const err = new Error('Bi-set inválido no plano');
        (err as any).code = 'INVALID_EXERCISES';
        (err as any).details = biSetErrors.map((e) => `day[${i + 1}]: ${e}`);
        throw err;
      }
      days.push({ index: i + 1, name: dayName, focus: dayFocus, items });
    }

    const requestedProtocolId = Number(input.sourceProtocolId);
    const sourceProtocolId = Number.isFinite(requestedProtocolId) && requestedProtocolId > 0
      ? requestedProtocolId
      : await createPersonalProtocolSnapshot(client, personalId, academyId, {
          title,
          weekPreset,
          selectedGroup: null,
          days,
        });

    if (Number.isFinite(requestedProtocolId) && requestedProtocolId > 0) {
      await assertProtocolVisibleToPersonal(client, personalId, academyId, sourceProtocolId);
    }

    const parentResult = await client.query(
      `INSERT INTO personal_workout_plans
         (personal_id, student_id, academy_id, source_protocol_id, title, week_preset, selected_group, payload_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, CURRENT_TIMESTAMP)
       RETURNING id, personal_id, student_id, academy_id, source_protocol_id, title, week_preset, selected_group, payload_json, created_at, updated_at`,
      [personalId, studentId, academyId, sourceProtocolId, title, weekPreset, null]
    );
    const parent = parentResult.rows[0];
    const planId = parent.id;

    for (const day of days) {
      await client.query(
        `INSERT INTO personal_workout_plan_days
           (plan_id, day_index, name, focus, payload_json, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
        [planId, day.index, day.name, day.focus, JSON.stringify(day.items)]
      );
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
    sourceProtocolId?: number | null;
  }
) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);
  const selectedGroup = input.selectedGroup ? String(input.selectedGroup).slice(0, 64) : null;
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = validateWorkoutItems(rawItems);
  const biSetErrors = validateBiSetPairs(items);
  if (biSetErrors.length > 0) {
    const err = new Error('Bi-set inválido no plano');
    (err as any).code = 'INVALID_EXERCISES';
    (err as any).details = biSetErrors;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const requestedProtocolId = Number(input.sourceProtocolId);
    const sourceProtocolId = Number.isFinite(requestedProtocolId) && requestedProtocolId > 0
      ? requestedProtocolId
      : await createPersonalProtocolSnapshot(client, personalId, academyId, {
          title,
          weekPreset,
          selectedGroup,
          days: [{ name: 'Único', focus: selectedGroup, items }],
        });

    if (Number.isFinite(requestedProtocolId) && requestedProtocolId > 0) {
      await assertProtocolVisibleToPersonal(client, personalId, academyId, sourceProtocolId);
    }

    const insert = await client.query(
      `INSERT INTO personal_workout_plans (
         personal_id, student_id, academy_id, source_protocol_id, title, week_preset, selected_group, payload_json, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)
       RETURNING id, personal_id, student_id, academy_id, source_protocol_id, title, week_preset, selected_group, payload_json, created_at, updated_at`,
      [personalId, studentId, academyId, sourceProtocolId, title, weekPreset, selectedGroup, JSON.stringify(items)]
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

/**
 * Updates an existing multi-day workout plan (replaces days entirely).
 * Verifies plan belongs to this personal + student before updating.
 */
export async function updatePersonalWorkoutPlanWithDays(
  personalId: number,
  planId: number,
  studentId: number,
  academyId: number | null,
  input: {
    title: string;
    weekPreset: string;
    days: Array<{ name: string; focus?: string | null; items: unknown[] }>;
  }
) {
  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership check — plan must belong to this personal + student
    const own = await client.query(
      `SELECT id FROM personal_workout_plans
       WHERE id = $1 AND personal_id = $2 AND student_id = $3
       LIMIT 1`,
      [planId, personalId, studentId]
    );
    if (!own.rows.length) {
      const err = new Error('Plan not found or access denied');
      (err as { code?: string }).code = 'PLAN_NOT_FOUND';
      throw err;
    }

    const days: WorkoutPlanDay[] = [];
    for (let i = 0; i < input.days.length; i++) {
      const d = input.days[i];
      const dayName = sanitizeString(d.name, 120) || `Dia ${i + 1}`;
      const dayFocus = d.focus ? sanitizeString(d.focus, 120) : null;
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = validateWorkoutItems(rawItems);
      const biSetErrors = validateBiSetPairs(items);
      if (biSetErrors.length > 0) {
        const err = new Error('Bi-set inválido no plano');
        (err as any).code = 'INVALID_EXERCISES';
        (err as any).details = biSetErrors.map((e) => `day[${i + 1}]: ${e}`);
        throw err;
      }
      days.push({ index: i + 1, name: dayName, focus: dayFocus, items });
    }

    // Update parent
    await client.query(
      `UPDATE personal_workout_plans
       SET title = $1, week_preset = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [title, weekPreset, planId]
    );

    // Replace days
    await client.query(`DELETE FROM personal_workout_plan_days WHERE plan_id = $1`, [planId]);
    for (const day of days) {
      await client.query(
        `INSERT INTO personal_workout_plan_days
           (plan_id, day_index, name, focus, payload_json, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
        [planId, day.index, day.name, day.focus, JSON.stringify(day.items)]
      );
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `${SELECT_WITH_DAYS} WHERE p.id = $1 GROUP BY p.id`,
      [planId]
    );
    return shapeRow(result.rows[0]);
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

  // Aluno NÃO vê fichas abandonadas — só o personal vê (e pode reativar)
  const result = await pool.query(
    `${SELECT_WITH_DAYS}
     WHERE p.student_id = $1 AND p.abandoned_at IS NULL
     GROUP BY p.id
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [studentId, safeLimit]
  );

  return result.rows.map(shapeRow);
}

/**
 * Aluno abandona uma ficha. A ficha não é apagada (apenas o personal pode
 * apagar) — fica oculta na listagem do aluno até o personal reativar.
 */
export async function abandonWorkoutPlan(studentId: number, planId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE personal_workout_plans
     SET abandoned_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND student_id = $2 AND abandoned_at IS NULL
     RETURNING id`,
    [planId, studentId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Personal reativa uma ficha abandonada pelo aluno.
 */
export async function reactivateWorkoutPlan(
  personalId: number,
  studentId: number,
  planId: number
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE personal_workout_plans
     SET abandoned_at = NULL, updated_at = NOW()
     WHERE id = $1 AND personal_id = $2 AND student_id = $3 AND abandoned_at IS NOT NULL
     RETURNING id`,
    [planId, personalId, studentId]
  );
  return (result.rowCount ?? 0) > 0;
}
