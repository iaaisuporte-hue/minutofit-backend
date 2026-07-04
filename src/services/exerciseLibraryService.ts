/**
 * Serviço de acesso à biblioteca global de exercícios CoreFit.
 * Exercícios são globais (sem academy_id) e cacheados em memória por 5 minutos.
 */

import pool from '../config/database';
import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type ExerciseMedia = {
  id: string;
  exerciseId: string;
  mediaType: 'gif' | 'image' | 'video' | 'youtube';
  url: string;
  source: string | null;
  isPrimary: boolean;
};

export type Exercise = {
  id: string;
  externalId: string | null;
  source: string;
  name: string;
  normalizedName: string;
  bodyPart: string;
  targetMuscle: string;
  secondaryMuscles: string[];
  equipment: string;
  tags: string[];
  instructions: string[];
  tips: string[];
  media: ExerciseMedia[];
  /** Perfil de captura do Lab de Movimento (Spec 022); null quando não mapeado. */
  movementLabExerciseId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExerciseSummary = Omit<Exercise, 'instructions' | 'tips' | 'media'> & {
  primaryMediaUrl: string | null;
  primaryMediaType: string | null;
};

// ---------------------------------------------------------------------------
// Helpers de mapeamento
// ---------------------------------------------------------------------------

function mapMediaRow(r: Record<string, unknown>): ExerciseMedia {
  return {
    id: String(r.id),
    exerciseId: String(r.exercise_id),
    mediaType: String(r.media_type) as ExerciseMedia['mediaType'],
    url: String(r.url),
    source: r.source != null ? String(r.source) : null,
    isPrimary: Boolean(r.is_primary),
  };
}

function mapExerciseRow(r: Record<string, unknown>, media: ExerciseMedia[] = []): Exercise {
  return {
    id: String(r.id),
    externalId: r.external_id != null ? String(r.external_id) : null,
    source: String(r.source),
    name: String(r.name),
    normalizedName: String(r.normalized_name),
    bodyPart: String(r.body_part),
    targetMuscle: String(r.target_muscle),
    secondaryMuscles: Array.isArray(r.secondary_muscles) ? (r.secondary_muscles as string[]) : [],
    equipment: String(r.equipment),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    instructions: Array.isArray(r.instructions)
      ? (r.instructions as string[])
      : [],
    tips: Array.isArray(r.tips) ? (r.tips as string[]) : [],
    media,
    movementLabExerciseId: r.movement_lab_exercise_id != null ? String(r.movement_lab_exercise_id) : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function mapSummaryRow(r: Record<string, unknown>): ExerciseSummary {
  return {
    id: String(r.id),
    externalId: r.external_id != null ? String(r.external_id) : null,
    source: String(r.source),
    name: String(r.name),
    normalizedName: String(r.normalized_name),
    bodyPart: String(r.body_part),
    targetMuscle: String(r.target_muscle),
    secondaryMuscles: Array.isArray(r.secondary_muscles) ? (r.secondary_muscles as string[]) : [],
    equipment: String(r.equipment),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    primaryMediaUrl: r.primary_media_url != null ? String(r.primary_media_url) : null,
    primaryMediaType: r.primary_media_type != null ? String(r.primary_media_type) : null,
    movementLabExerciseId: r.movement_lab_exercise_id != null ? String(r.movement_lab_exercise_id) : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cache em memória (5 minutos) para listagem completa usada pela IA
// ---------------------------------------------------------------------------

type CacheEntry = { data: ExerciseSummary[]; expiresAt: number };
let _allExercisesCache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getAllExercisesCached(): Promise<ExerciseSummary[]> {
  if (_allExercisesCache && Date.now() < _allExercisesCache.expiresAt) {
    return _allExercisesCache.data;
  }
  const data = await searchExercises({ limit: 500 });
  _allExercisesCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

export function invalidateExercisesCache(): void {
  _allExercisesCache = null;
}

// ---------------------------------------------------------------------------
// Queries públicas
// ---------------------------------------------------------------------------

export async function searchExercises(opts: {
  q?: string;
  bodyPart?: string;
  equipment?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
} = {}): Promise<ExerciseSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (opts.q?.trim()) {
    const normalizedQuery = opts.q.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const rawQuery = opts.q.trim().toLowerCase();
    params.push(`%${normalizedQuery}%`, `%${rawQuery}%`);
    conditions.push(`(
      e.normalized_name ILIKE $${params.length - 1}
      OR EXISTS (
        SELECT 1 FROM unnest(e.tags) AS tag
        WHERE LOWER(tag) ILIKE $${params.length - 1}
           OR LOWER(tag) ILIKE $${params.length}
      )
    )`);
  }
  if (opts.bodyPart?.trim()) {
    params.push(opts.bodyPart.trim().toLowerCase());
    conditions.push(`LOWER(e.body_part) = $${params.length}`);
  }
  if (opts.equipment?.trim()) {
    params.push(opts.equipment.trim().toLowerCase());
    conditions.push(`LOWER(e.equipment) = $${params.length}`);
  }
  if (opts.tags?.length) {
    params.push(opts.tags);
    conditions.push(`e.tags && $${params.length}::text[]`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await pool.query(
    `SELECT e.*,
            m.url  AS primary_media_url,
            m.media_type AS primary_media_type
     FROM exercises e
     LEFT JOIN LATERAL (
       SELECT url, media_type
       FROM exercise_media
       WHERE exercise_id = e.id AND is_primary = true
       LIMIT 1
     ) m ON true
     ${where}
     ORDER BY e.name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return result.rows.map((r) => mapSummaryRow(r as Record<string, unknown>));
}

export async function getExerciseById(id: string): Promise<Exercise | null> {
  const exResult = await pool.query(
    `SELECT * FROM exercises WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!exResult.rows.length) return null;

  const mediaResult = await pool.query(
    `SELECT * FROM exercise_media WHERE exercise_id = $1 ORDER BY is_primary DESC, created_at ASC`,
    [id]
  );

  const media = mediaResult.rows.map((r) => mapMediaRow(r as Record<string, unknown>));
  return mapExerciseRow(exResult.rows[0] as Record<string, unknown>, media);
}

export async function getExercisesBatch(ids: string[]): Promise<Exercise[]> {
  if (!ids.length) return [];
  const safeIds = ids.slice(0, 100);

  const exResult = await pool.query(
    `SELECT * FROM exercises WHERE id = ANY($1::uuid[])`,
    [safeIds]
  );
  if (!exResult.rows.length) return [];

  const mediaResult = await pool.query(
    `SELECT * FROM exercise_media WHERE exercise_id = ANY($1::uuid[]) ORDER BY is_primary DESC`,
    [safeIds]
  );

  const mediaByEx = new Map<string, ExerciseMedia[]>();
  for (const mRow of mediaResult.rows) {
    const exId = String(mRow.exercise_id);
    if (!mediaByEx.has(exId)) mediaByEx.set(exId, []);
    mediaByEx.get(exId)!.push(mapMediaRow(mRow as Record<string, unknown>));
  }

  return exResult.rows.map((r) => {
    const id = String(r.id);
    return mapExerciseRow(r as Record<string, unknown>, mediaByEx.get(id) ?? []);
  });
}

/**
 * Busca heurística por nome — usada no backfill e no fallback da IA.
 * Retorna o primeiro match por normalized_name exato, depois prefix, depois contains.
 */
export async function findExerciseByName(name: string): Promise<ExerciseSummary | null> {
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  // Exact match
  const exact = await pool.query(
    `SELECT e.*, m.url AS primary_media_url, m.media_type AS primary_media_type
     FROM exercises e
     LEFT JOIN LATERAL (
       SELECT url, media_type FROM exercise_media WHERE exercise_id = e.id AND is_primary = true LIMIT 1
     ) m ON true
     WHERE e.normalized_name = $1
     LIMIT 1`,
    [normalized]
  );
  if (exact.rows.length) return mapSummaryRow(exact.rows[0] as Record<string, unknown>);

  // Contains match
  const contains = await pool.query(
    `SELECT e.*, m.url AS primary_media_url, m.media_type AS primary_media_type
     FROM exercises e
     LEFT JOIN LATERAL (
       SELECT url, media_type FROM exercise_media WHERE exercise_id = e.id AND is_primary = true LIMIT 1
     ) m ON true
     WHERE e.normalized_name ILIKE $1
     ORDER BY length(e.normalized_name) ASC
     LIMIT 1`,
    [`%${normalized}%`]
  );
  if (contains.rows.length) return mapSummaryRow(contains.rows[0] as Record<string, unknown>);

  return null;
}

/**
 * Retorna lista resumida de todos os exercícios para uso da IA (cacheada).
 */
export async function getExerciseCatalogForAI(): Promise<{ id: string; name: string; bodyPart: string; equipment: string }[]> {
  const all = await getAllExercisesCached();
  return all.map((e) => ({
    id: e.id,
    name: e.name,
    bodyPart: e.bodyPart,
    equipment: e.equipment,
  }));
}

/**
 * Valida se uma lista de IDs são UUIDs existentes na tabela exercises.
 * Retorna array de IDs inválidos (não encontrados).
 */
export async function validateExerciseIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalidFormat = ids.filter((id) => !uuidPattern.test(id));
  if (invalidFormat.length) return invalidFormat;

  const result = await pool.query(
    `SELECT id FROM exercises WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const found = new Set(result.rows.map((r) => String(r.id)));
  return ids.filter((id) => !found.has(id));
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export async function adminCreateExercise(input: {
  name: string;
  bodyPart: string;
  targetMuscle: string;
  secondaryMuscles?: string[];
  equipment: string;
  tags?: string[];
  instructions?: string[];
  tips?: string[];
  externalId?: string | null;
  source?: string;
}): Promise<Exercise> {
  const normalized = input.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const result = await pool.query(
    `INSERT INTO exercises (
       source, external_id, name, normalized_name,
       body_part, target_muscle, secondary_muscles,
       equipment, tags, instructions, tips
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     ON CONFLICT (normalized_name, source)
     DO UPDATE SET
       name = EXCLUDED.name,
       body_part = EXCLUDED.body_part,
       target_muscle = EXCLUDED.target_muscle,
       secondary_muscles = EXCLUDED.secondary_muscles,
       equipment = EXCLUDED.equipment,
       tags = EXCLUDED.tags,
       instructions = EXCLUDED.instructions,
       tips = EXCLUDED.tips,
       updated_at = NOW()
     RETURNING *`,
    [
      input.source ?? 'corefit',
      input.externalId ?? null,
      input.name,
      normalized,
      input.bodyPart,
      input.targetMuscle,
      input.secondaryMuscles ?? [],
      input.equipment,
      input.tags ?? [],
      JSON.stringify(input.instructions ?? []),
      JSON.stringify(input.tips ?? []),
    ]
  );

  invalidateExercisesCache();
  logger.info({ name: input.name }, '[exercises] Exercise created/updated');
  return mapExerciseRow(result.rows[0] as Record<string, unknown>, []);
}

export async function adminPatchExercise(
  id: string,
  input: Partial<{
    name: string;
    bodyPart: string;
    targetMuscle: string;
    secondaryMuscles: string[];
    equipment: string;
    tags: string[];
    instructions: string[];
    tips: string[];
  }>
): Promise<Exercise | null> {
  const existing = await pool.query(`SELECT * FROM exercises WHERE id = $1 LIMIT 1`, [id]);
  if (!existing.rows.length) return null;

  const cur = existing.rows[0] as Record<string, unknown>;
  const name = input.name ?? String(cur.name);
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const result = await pool.query(
    `UPDATE exercises
     SET name = $1, normalized_name = $2, body_part = $3, target_muscle = $4,
         secondary_muscles = $5, equipment = $6, tags = $7,
         instructions = $8::jsonb, tips = $9::jsonb, updated_at = NOW()
     WHERE id = $10
     RETURNING *`,
    [
      name,
      normalized,
      input.bodyPart ?? String(cur.body_part),
      input.targetMuscle ?? String(cur.target_muscle),
      input.secondaryMuscles ?? (cur.secondary_muscles as string[]),
      input.equipment ?? String(cur.equipment),
      input.tags ?? (cur.tags as string[]),
      JSON.stringify(input.instructions ?? (cur.instructions as string[])),
      JSON.stringify(input.tips ?? (cur.tips as string[])),
      id,
    ]
  );

  invalidateExercisesCache();
  return mapExerciseRow(result.rows[0] as Record<string, unknown>, []);
}
