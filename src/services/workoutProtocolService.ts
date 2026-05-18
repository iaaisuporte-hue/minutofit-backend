import pool from '../config/database';
import {
  sanitizeWorkoutPlanItem,
  validateWorkoutItems,
  type WorkoutPlanDay,
  type WorkoutPlanItemPayload,
} from './personalWorkoutPlanService';
import { getPersonalStudentSnapshot } from './personalDashboardService';

export type ProtocolScope = 'personal' | 'academy' | 'platform';

export type ProtocolTags = Record<string, unknown>;

export type WorkoutProtocolRow = {
  id: number;
  scope: ProtocolScope;
  academyId: number | null;
  ownerPersonalId: number | null;
  title: string;
  description: string | null;
  tags: ProtocolTags;
  weekPreset: string;
  selectedGroup: string | null;
  items: WorkoutPlanItemPayload[];
  days: WorkoutPlanDay[];
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  isFavorite?: boolean;
};

function tolerantItems(raw: unknown): WorkoutPlanItemPayload[] {
  const rawItems = Array.isArray(raw) ? raw : [];
  // GET path: tolerant — legacy items pass through with their flag intact
  return rawItems
    .map((x) => {
      const result = sanitizeWorkoutPlanItem(x);
      if (result.ok) return result.item;
      // Keep legacy items visible in GET; they just can't be saved again
      if (x && typeof x === 'object' && (x as Record<string, unknown>).legacy === true) {
        return x as WorkoutPlanItemPayload;
      }
      return null;
    })
    .filter((x): x is WorkoutPlanItemPayload => x !== null);
}

function mapProtocolDays(r: Record<string, unknown>, fallbackItems: WorkoutPlanItemPayload[]): WorkoutPlanDay[] {
  const rawDays = Array.isArray(r.days_json) ? r.days_json : [];
  const days = rawDays
    .map((raw, idx) => {
      if (!raw || typeof raw !== 'object') return null;
      const d = raw as Record<string, unknown>;
      const items = tolerantItems(d.items);
      return {
        index: Number(d.index) || idx + 1,
        name: String(d.name || `Dia ${idx + 1}`),
        focus: d.focus != null ? String(d.focus) : null,
        items,
      };
    })
    .filter((day): day is WorkoutPlanDay => day !== null);

  if (days.length > 0) return days;
  return [{ index: 1, name: 'Único', focus: r.selected_group != null ? String(r.selected_group) : null, items: fallbackItems }];
}

function normalizeProtocolDays(rawDays: unknown[], fallbackFocus: string | null): WorkoutPlanDay[] {
  return rawDays.map((raw, idx) => {
    const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const rawItems = Array.isArray(d.items) ? d.items : [];
    return {
      index: idx + 1,
      name: String(d.name || `Dia ${idx + 1}`).slice(0, 120),
      focus: d.focus != null ? String(d.focus).slice(0, 120) : fallbackFocus,
      items: validateWorkoutItems(rawItems),
    };
  });
}

function mapProtocolRow(r: Record<string, unknown>, isFavorite?: boolean): WorkoutProtocolRow {
  const items = tolerantItems(r.payload_json);
  const days = mapProtocolDays(r, items);
  return {
    id: Number(r.id),
    scope: r.scope as ProtocolScope,
    academyId: r.academy_id != null ? Number(r.academy_id) : null,
    ownerPersonalId: r.owner_personal_id != null ? Number(r.owner_personal_id) : null,
    title: String(r.title || ''),
    description: r.description != null ? String(r.description) : null,
    tags: (r.tags && typeof r.tags === 'object' ? r.tags : {}) as ProtocolTags,
    weekPreset: String(r.week_preset || '5'),
    selectedGroup: r.selected_group != null ? String(r.selected_group) : null,
    items,
    days,
    usageCount: Number(r.usage_count ?? 0),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    isFavorite,
  };
}

function sanitizeTags(raw: unknown): ProtocolTags {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ProtocolTags = {};
  const allow = ['goal', 'level', 'location', 'metabolicFocus', 'injurySafe', 'gender', 'ageBand'];
  for (const k of allow) {
    if (o[k] === undefined) continue;
    if (k === 'injurySafe' && typeof o[k] === 'boolean') out[k] = o[k];
    else if (typeof o[k] === 'string' && String(o[k]).length <= 64) out[k] = String(o[k]).slice(0, 64);
  }
  return out;
}

export async function listWorkoutProtocolsForPersonal(
  personalId: number,
  academyId: number,
  options: {
    q?: string;
    scope?: ProtocolScope | 'all';
    tagGoal?: string;
    limit?: number;
  } = {}
): Promise<WorkoutProtocolRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 80, 1), 120);
  const params: unknown[] = [personalId, academyId];
  let where = `WHERE (
    (p.scope = 'platform' AND p.academy_id IS NULL)
    OR (p.scope = 'academy' AND p.academy_id = $2)
    OR (p.scope = 'personal' AND p.academy_id = $2 AND p.owner_personal_id = $1)
  )`;

  if (options.scope && options.scope !== 'all') {
    params.push(options.scope);
    where += ` AND p.scope = $${params.length}`;
  }

  if (options.tagGoal) {
    params.push(JSON.stringify({ goal: String(options.tagGoal).slice(0, 32) }));
    where += ` AND p.tags @> $${params.length}::jsonb`;
  }

  if (options.q?.trim()) {
    params.push(`%${options.q.trim().slice(0, 80).replace(/%/g, '')}%`);
    where += ` AND (p.title ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
  }

  params.push(limit);
  const limIdx = params.length;

  const result = await pool.query(
    `SELECT p.*,
            (
              SELECT COUNT(*)::int FROM personal_workout_plans pwp
              WHERE pwp.source_protocol_id = p.id AND pwp.personal_id = $1
            ) AS usage_count,
            EXISTS (
              SELECT 1 FROM personal_protocol_favorites f
              WHERE f.personal_id = $1 AND f.protocol_id = p.id
            ) AS is_favorite
     FROM workout_protocols p
     ${where}
     ORDER BY is_favorite DESC, p.updated_at DESC
     LIMIT $${limIdx}`,
    params
  );

  return result.rows.map((r) => mapProtocolRow(r as Record<string, unknown>, Boolean(r.is_favorite)));
}

export async function getWorkoutProtocolById(
  personalId: number,
  academyId: number,
  protocolId: number
): Promise<WorkoutProtocolRow | null> {
  const result = await pool.query(
    `SELECT p.*,
            (
              SELECT COUNT(*)::int FROM personal_workout_plans pwp
              WHERE pwp.source_protocol_id = p.id AND pwp.personal_id = $1
            ) AS usage_count,
            EXISTS (
              SELECT 1 FROM personal_protocol_favorites f
              WHERE f.personal_id = $1 AND f.protocol_id = p.id
            ) AS is_favorite
     FROM workout_protocols p
     WHERE p.id = $3
       AND (
         (p.scope = 'platform' AND p.academy_id IS NULL)
         OR (p.scope = 'academy' AND p.academy_id = $2)
         OR (p.scope = 'personal' AND p.academy_id = $2 AND p.owner_personal_id = $1)
       )
     LIMIT 1`,
    [personalId, academyId, protocolId]
  );
  if (!result.rows.length) return null;
  const r = result.rows[0] as Record<string, unknown>;
  return mapProtocolRow(r, Boolean(r.is_favorite));
}

export async function createWorkoutProtocol(
  personalId: number,
  academyId: number,
  input: {
    scope: 'personal' | 'academy';
    title: string;
    description?: string | null;
    tags?: ProtocolTags;
    weekPreset?: string;
    selectedGroup?: string | null;
    items: unknown[];
    days?: Array<{ name?: string; focus?: string | null; items?: unknown[] }>;
  }
) {
  if (input.scope !== 'personal' && input.scope !== 'academy') {
    throw new Error('Invalid scope for personal create');
  }
  const title = String(input.title || '').trim().slice(0, 255);
  if (!title) throw new Error('title is required');

  const selectedGroup = input.selectedGroup ? String(input.selectedGroup).slice(0, 64) : null;
  const days = Array.isArray(input.days) && input.days.length > 0
    ? normalizeProtocolDays(input.days, selectedGroup)
    : [{ index: 1, name: 'Único', focus: selectedGroup, items: validateWorkoutItems(Array.isArray(input.items) ? input.items : []) }];
  const items = days.find((day) => day.items.length > 0)?.items ?? [];
  if (!items.length) throw new Error('At least one valid exercise item is required');

  const tags = sanitizeTags(input.tags);
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);
  const description = input.description != null ? String(input.description).slice(0, 4000) : null;

  const result = await pool.query(
    `INSERT INTO workout_protocols
      (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json, days_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, NOW())
     RETURNING *`,
    [
      input.scope,
      academyId,
      personalId,
      title,
      description,
      JSON.stringify(tags),
      weekPreset,
      selectedGroup,
      JSON.stringify(items),
      JSON.stringify(days),
    ]
  );
  return mapProtocolRow(result.rows[0] as Record<string, unknown>, false);
}

export async function updateWorkoutProtocol(
  personalId: number,
  academyId: number,
  protocolId: number,
  input: Partial<{
    title: string;
    description: string | null;
    tags: ProtocolTags;
    weekPreset: string;
    selectedGroup: string | null;
    items: unknown[];
  }>
) {
  const existing = await pool.query(
    `SELECT * FROM workout_protocols WHERE id = $1 AND scope <> 'platform' LIMIT 1`,
    [protocolId]
  );
  if (!existing.rows.length) {
    const err = new Error('Protocol not found');
    (err as { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
  const row = existing.rows[0] as Record<string, unknown>;
  if (Number(row.owner_personal_id) !== personalId) {
    const err = new Error('Forbidden');
    (err as any).code = 'FORBIDDEN';
    throw err;
  }
  if (Number(row.academy_id) !== academyId) {
    const err = new Error('Forbidden');
    (err as any).code = 'FORBIDDEN';
    throw err;
  }

  const title =
    input.title !== undefined ? String(input.title || '').trim().slice(0, 255) : String(row.title);
  if (!title) throw new Error('title is required');

  const description =
    input.description !== undefined
      ? input.description != null
        ? String(input.description).slice(0, 4000)
        : null
      : row.description != null
        ? String(row.description)
        : null;

  const tags =
    input.tags !== undefined ? sanitizeTags(input.tags) : (row.tags as ProtocolTags) || {};

  const weekPreset =
    input.weekPreset !== undefined
      ? String(input.weekPreset).slice(0, 32)
      : String(row.week_preset || '5');

  const selectedGroup =
    input.selectedGroup !== undefined
      ? input.selectedGroup != null
        ? String(input.selectedGroup).slice(0, 64)
        : null
      : row.selected_group != null
        ? String(row.selected_group)
        : null;

  let items: WorkoutPlanItemPayload[];
  if (input.items !== undefined) {
    items = validateWorkoutItems(Array.isArray(input.items) ? input.items : []);
    if (!items.length) throw new Error('At least one valid exercise item is required');
  } else {
    items = mapProtocolRow(row as Record<string, unknown>).items;
  }

  const result = await pool.query(
    `UPDATE workout_protocols
     SET title = $1, description = $2, tags = $3::jsonb, week_preset = $4, selected_group = $5,
         payload_json = $6::jsonb, updated_at = NOW()
     WHERE id = $7 AND owner_personal_id = $8 AND academy_id = $9 AND scope <> 'platform'
     RETURNING *`,
    [title, description, JSON.stringify(tags), weekPreset, selectedGroup, JSON.stringify(items), protocolId, personalId, academyId]
  );
  if (!result.rows.length) {
    const err = new Error('Protocol not found');
    (err as { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
  return mapProtocolRow(result.rows[0] as Record<string, unknown>, false);
}

export async function deleteWorkoutProtocol(personalId: number, academyId: number | null, protocolId: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM workout_protocols
     WHERE id = $1
       AND owner_personal_id = $2
       AND ($3::int IS NULL AND academy_id IS NULL OR academy_id = $3)
       AND scope <> 'platform'`,
    [protocolId, personalId, academyId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setProtocolFavorite(personalId: number, protocolId: number, favorite: boolean): Promise<void> {
  if (favorite) {
    await pool.query(
      `INSERT INTO personal_protocol_favorites (personal_id, protocol_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [personalId, protocolId]
    );
  } else {
    await pool.query(`DELETE FROM personal_protocol_favorites WHERE personal_id = $1 AND protocol_id = $2`, [
      personalId,
      protocolId,
    ]);
  }
}


export type ProtocolUsageRow = {
  id: number;
  studentId: number;
  studentName: string;
  studentEmail: string;
  createdAt: string;
  updatedAt: string;
};

async function assertOwnedProtocol(personalId: number, academyId: number | null, protocolId: number): Promise<void> {
  const result = await pool.query(
    `SELECT 1
     FROM workout_protocols
     WHERE id = $1
       AND owner_personal_id = $2
       AND ($3::int IS NULL AND academy_id IS NULL OR academy_id = $3)
       AND scope = 'personal'
     LIMIT 1`,
    [protocolId, personalId, academyId]
  );
  if (!result.rows.length) {
    const err = new Error('Protocol not found');
    (err as { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
}

export async function listProtocolUsages(
  personalId: number,
  academyId: number | null,
  protocolId: number
): Promise<{ count: number; students: ProtocolUsageRow[] }> {
  await assertOwnedProtocol(personalId, academyId, protocolId);
  const result = await pool.query(
    `SELECT pwp.id,
            pwp.student_id,
            pwp.created_at,
            pwp.updated_at,
            u.name AS student_name,
            u.email AS student_email
     FROM personal_workout_plans pwp
     JOIN users u ON u.id = pwp.student_id
     WHERE pwp.source_protocol_id = $1
       AND pwp.personal_id = $2
       AND ($3::int IS NULL AND pwp.academy_id IS NULL OR pwp.academy_id = $3)
     ORDER BY pwp.updated_at DESC`,
    [protocolId, personalId, academyId]
  );
  const students = result.rows.map((row) => ({
    id: Number(row.id),
    studentId: Number(row.student_id),
    studentName: String(row.student_name || ''),
    studentEmail: String(row.student_email || ''),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
  return { count: students.length, students };
}

export async function deleteProtocolUsage(
  personalId: number,
  academyId: number | null,
  protocolId: number,
  planId: number
): Promise<boolean> {
  await assertOwnedProtocol(personalId, academyId, protocolId);
  const result = await pool.query(
    `DELETE FROM personal_workout_plans
     WHERE id = $1
       AND source_protocol_id = $2
       AND personal_id = $3
       AND ($4::int IS NULL AND academy_id IS NULL OR academy_id = $4)`,
    [planId, protocolId, personalId, academyId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Admin: list platform protocols */
export async function listPlatformProtocols(limit = 100) {
  const lim = Math.min(Math.max(limit, 1), 200);
  const result = await pool.query(
    `SELECT * FROM workout_protocols WHERE scope = 'platform' ORDER BY updated_at DESC LIMIT $1`,
    [lim]
  );
  return result.rows.map((r) => mapProtocolRow(r as Record<string, unknown>, false));
}

export async function createPlatformProtocol(input: {
  title: string;
  description?: string | null;
  tags?: ProtocolTags;
  weekPreset?: string;
  selectedGroup?: string | null;
  items: unknown[];
}) {
  const title = String(input.title || '').trim().slice(0, 255);
  if (!title) throw new Error('title is required');
  const items = validateWorkoutItems(Array.isArray(input.items) ? input.items : []);
  if (!items.length) throw new Error('At least one valid exercise item is required');
  const tags = sanitizeTags(input.tags);
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);
  const selectedGroup = input.selectedGroup ? String(input.selectedGroup).slice(0, 64) : null;
  const description = input.description != null ? String(input.description).slice(0, 4000) : null;

  const result = await pool.query(
    `INSERT INTO workout_protocols
      (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json, updated_at)
     VALUES ('platform', NULL, NULL, $1, $2, $3::jsonb, $4, $5, $6::jsonb, NOW())
     RETURNING *`,
    [title, description, JSON.stringify(tags), weekPreset, selectedGroup, JSON.stringify(items)]
  );
  return mapProtocolRow(result.rows[0] as Record<string, unknown>, false);
}

export async function updatePlatformProtocol(
  protocolId: number,
  input: Partial<{
    title: string;
    description: string | null;
    tags: ProtocolTags;
    weekPreset: string;
    selectedGroup: string | null;
    items: unknown[];
  }>
) {
  const existing = await pool.query(`SELECT * FROM workout_protocols WHERE id = $1 AND scope = 'platform' LIMIT 1`, [
    protocolId,
  ]);
  if (!existing.rows.length) {
    const err = new Error('Protocol not found');
    (err as { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
  const row = existing.rows[0] as Record<string, unknown>;
  const cur = mapProtocolRow(row, false);

  const title = input.title !== undefined ? String(input.title || '').trim().slice(0, 255) : cur.title;
  if (!title) throw new Error('title is required');
  const description =
    input.description !== undefined
      ? input.description != null
        ? String(input.description).slice(0, 4000)
        : null
      : cur.description;
  const tags = input.tags !== undefined ? sanitizeTags(input.tags) : cur.tags;
  const weekPreset = input.weekPreset !== undefined ? String(input.weekPreset).slice(0, 32) : cur.weekPreset;
  const selectedGroup =
    input.selectedGroup !== undefined
      ? input.selectedGroup != null
        ? String(input.selectedGroup).slice(0, 64)
        : null
      : cur.selectedGroup;

  let items = cur.items;
  if (input.items !== undefined) {
    items = validateWorkoutItems(Array.isArray(input.items) ? input.items : []);
    if (!items.length) throw new Error('At least one valid exercise item is required');
  }

  const result = await pool.query(
    `UPDATE workout_protocols
     SET title = $1, description = $2, tags = $3::jsonb, week_preset = $4, selected_group = $5,
         payload_json = $6::jsonb, updated_at = NOW()
     WHERE id = $7 AND scope = 'platform'
     RETURNING *`,
    [title, description, JSON.stringify(tags), weekPreset, selectedGroup, JSON.stringify(items), protocolId]
  );
  return mapProtocolRow(result.rows[0] as Record<string, unknown>, false);
}

export async function deletePlatformProtocol(protocolId: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM workout_protocols WHERE id = $1 AND scope = 'platform'`, [protocolId]);
  return (result.rowCount ?? 0) > 0;
}

export type ProtocolSuggestion = {
  protocolId: number;
  title: string;
  scope: ProtocolScope;
  reason: string;
  score: number;
};

export async function suggestProtocolsForStudent(
  personalId: number,
  studentId: number,
  academyId: number | null
): Promise<ProtocolSuggestion[]> {
  if (!academyId) return [];
  const snap = await getPersonalStudentSnapshot(personalId, studentId, academyId);
  const protocols = await listWorkoutProtocolsForPersonal(personalId, academyId, { limit: 80 });

  const inPain = snap.today.wellbeing?.inPain === true;
  const stressed = snap.today.wellbeing?.stressed === true;
  const trendDown = snap.today.metabolism?.trend === 'down';
  const painHighlights = (snap.technical?.highlights ?? []).some((h) => h.kind === 'pain');

  const scored = protocols.map((p) => {
    let score = 0;
    const reasons: string[] = [];
    const tags = p.tags as Record<string, string | boolean | undefined>;
    const focus = String(tags.metabolicFocus || '');
    const goal = String(tags.goal || '');
    const injury = tags.injurySafe === true;

    if ((inPain || painHighlights) && (injury || focus === 'regenerativo' || goal === 'recuperacao')) {
      score += 40;
      reasons.push('Sinais de dor ou notas técnicas de dor — priorizar protocolo seguro/regenerativo.');
    }
    if (trendDown && (focus === 'regenerativo' || goal === 'recuperacao')) {
      score += 25;
      reasons.push('Metabolismo em queda — favorecer recuperação antes de volume intenso.');
    }
    if (stressed && goal === 'recuperacao') {
      score += 15;
      reasons.push('Estresse elevado — encaixar descarga.');
    }
    if (!inPain && !trendDown && goal === 'hipertrofia') {
      score += 20;
      reasons.push('Janela favorável para progressão de volume moderado.');
    }
    if (p.scope === 'platform') score += 5;

    return {
      protocolId: p.id,
      title: p.title,
      scope: p.scope,
      reason: reasons[0] || 'Protocolo alinhado às tags do catálogo.',
      score,
    };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
