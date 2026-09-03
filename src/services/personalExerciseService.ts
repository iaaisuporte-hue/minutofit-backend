/**
 * Biblioteca de Exercícios Personalizados do Personal (Sprint P1).
 *
 * O domínio de AUTORIA fica separado do domínio de CATÁLOGO/BUSCA
 * (`exerciseLibraryService.ts`) — mesma divisão que `personalFinanceService.ts`
 * tem de `personalDashboardService.ts`. Este arquivo é o único caminho de
 * escrita para exercícios com `owner_personal_id`; leitura/dedup/visibilidade
 * continuam em `exerciseLibraryService.ts`.
 *
 * Três invariantes valem para tudo abaixo:
 *
 * 1. **`owner_personal_id` sai sempre do token** (`req.user!.id` na rota),
 *    nunca do corpo ou do path — um personal jamais edita ou arquiva
 *    exercício de outro.
 * 2. **Erro de posse é 404**, nunca 403 — não vaza se o id existe e é de
 *    outro dono (D7 do plano da sprint; mesmo padrão de
 *    `personalFinanceService.ts`).
 * 3. **`status='archived'` nunca é DELETE físico** — histórico, ficha ativa e
 *    PR tracking resolvem por id direto (`getExerciseById`/`getExercisesBatch`
 *    em `exerciseLibraryService.ts`, que não filtram por status).
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import pool from '../config/database';
import { assertStorageConfigured, getStorage } from '../lib/storage';
import {
  getExerciseById,
  normalizeExerciseName,
  searchExercises,
  type Exercise,
  type ExerciseSummary,
} from './exerciseLibraryService';

// ---------------------------------------------------------------------------
// Erros — mesmo padrão de personalFinanceService.ts: `fail` carrega `status`,
// a rota só repassa (sendError), nada de mapeamento de código espalhado.
// ---------------------------------------------------------------------------

function fail(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

const NAME_MAX = 255;
const BODY_PART_MAX = 100;
const TARGET_MUSCLE_MAX = 200;
const EQUIPMENT_MAX = 100;
const LIST_MAX_ITEMS = 30;
const LIST_ITEM_MAX = 500;

function sanitizeStringArray(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().slice(0, maxLen))
    .slice(0, maxItems);
}

/**
 * Verifica posse ANTES de qualquer mutação — SELECT + comparação, nunca no
 * middleware (mesmo padrão de `workout_protocols`, ver CURRENT_ARCHITECTURE).
 */
async function requireOwnedExercise(personalId: number, exerciseId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM exercises WHERE id = $1 AND owner_personal_id = $2 LIMIT 1`,
    [exerciseId, personalId],
  );
  if (!rows.length) throw fail('exercise_not_found', 404);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type PersonalExerciseInput = {
  name: string;
  /** "Grupo muscular principal" — obrigatório (spec §12); demais campos são opcionais. */
  bodyPart: string;
  targetMuscle?: string;
  secondaryMuscles?: string[];
  equipment?: string;
  tags?: string[];
  instructions?: string[];
  tips?: string[];
};

export type PersonalExercisePatch = Partial<PersonalExerciseInput>;

/** Erro de violação da UNIQUE parcial por-dono (migration 1837000000000). */
function isOwnerNameConflict(err: any): boolean {
  return err?.code === '23505' && err?.constraint === 'exercises_personal_owner_name_uq';
}

export async function createPersonalExercise(
  personalId: number,
  input: PersonalExerciseInput,
): Promise<Exercise> {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, NAME_MAX) : '';
  if (!name) throw fail('invalid_name', 400);
  const normalizedName = normalizeExerciseName(name);
  if (!normalizedName) throw fail('invalid_name', 400);

  const bodyPart = typeof input.bodyPart === 'string' ? input.bodyPart.trim().slice(0, BODY_PART_MAX) : '';
  if (!bodyPart) throw fail('invalid_body_part', 400);

  const targetMuscle = typeof input.targetMuscle === 'string' ? input.targetMuscle.trim().slice(0, TARGET_MUSCLE_MAX) : '';
  const equipment = typeof input.equipment === 'string' ? input.equipment.trim().slice(0, EQUIPMENT_MAX) : '';
  const secondaryMuscles = sanitizeStringArray(input.secondaryMuscles, LIST_MAX_ITEMS, 100);
  const tags = sanitizeStringArray(input.tags, LIST_MAX_ITEMS, 50);
  const instructions = sanitizeStringArray(input.instructions, LIST_MAX_ITEMS, LIST_ITEM_MAX);
  const tips = sanitizeStringArray(input.tips, LIST_MAX_ITEMS, LIST_ITEM_MAX);

  let insertedId: string;
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO exercises (
         source, owner_personal_id, status, name, normalized_name,
         body_part, target_muscle, secondary_muscles, equipment, tags, instructions, tips
       )
       VALUES ('personal', $1, 'active', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       RETURNING id`,
      [personalId, name, normalizedName, bodyPart, targetMuscle, secondaryMuscles, equipment, tags, JSON.stringify(instructions), JSON.stringify(tips)],
    );
    insertedId = result.rows[0].id;
  } catch (err: any) {
    // Nome duplicado NA BIBLIOTECA DESTE personal — diferente do aviso
    // não-bloqueante de "parecido com o catálogo global" (D11, client-side).
    if (isOwnerNameConflict(err)) throw fail('DUPLICATE_NAME', 409);
    throw err;
  }

  const created = await getExerciseById(insertedId);
  // Não deveria acontecer (acabamos de inserir na mesma conexão), mas o tipo
  // de retorno de getExerciseById é nullable — cobrir explicitamente evita
  // `as` silencioso.
  if (!created) throw fail('exercise_not_found', 404);
  return created;
}

export async function updatePersonalExercise(
  personalId: number,
  exerciseId: string,
  patch: PersonalExercisePatch,
): Promise<Exercise> {
  await requireOwnedExercise(personalId, exerciseId);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, NAME_MAX) : '';
    if (!name) throw fail('invalid_name', 400);
    const normalizedName = normalizeExerciseName(name);
    if (!normalizedName) throw fail('invalid_name', 400);
    params.push(name);
    sets.push(`name = $${params.length}`);
    params.push(normalizedName);
    sets.push(`normalized_name = $${params.length}`);
  }
  if (patch.bodyPart !== undefined) {
    const bodyPart = typeof patch.bodyPart === 'string' ? patch.bodyPart.trim().slice(0, BODY_PART_MAX) : '';
    if (!bodyPart) throw fail('invalid_body_part', 400);
    params.push(bodyPart);
    sets.push(`body_part = $${params.length}`);
  }
  if (patch.targetMuscle !== undefined) {
    params.push(String(patch.targetMuscle ?? '').trim().slice(0, TARGET_MUSCLE_MAX));
    sets.push(`target_muscle = $${params.length}`);
  }
  if (patch.equipment !== undefined) {
    params.push(String(patch.equipment ?? '').trim().slice(0, EQUIPMENT_MAX));
    sets.push(`equipment = $${params.length}`);
  }
  if (patch.secondaryMuscles !== undefined) {
    params.push(sanitizeStringArray(patch.secondaryMuscles, LIST_MAX_ITEMS, 100));
    sets.push(`secondary_muscles = $${params.length}`);
  }
  if (patch.tags !== undefined) {
    params.push(sanitizeStringArray(patch.tags, LIST_MAX_ITEMS, 50));
    sets.push(`tags = $${params.length}`);
  }
  if (patch.instructions !== undefined) {
    params.push(JSON.stringify(sanitizeStringArray(patch.instructions, LIST_MAX_ITEMS, LIST_ITEM_MAX)));
    sets.push(`instructions = $${params.length}::jsonb`);
  }
  if (patch.tips !== undefined) {
    params.push(JSON.stringify(sanitizeStringArray(patch.tips, LIST_MAX_ITEMS, LIST_ITEM_MAX)));
    sets.push(`tips = $${params.length}::jsonb`);
  }

  if (!sets.length) throw fail('empty_patch', 400);

  sets.push(`updated_at = NOW()`);
  params.push(exerciseId);
  // Posse já foi confirmada acima — o WHERE aqui é só a chave primária.
  const sql = `UPDATE exercises SET ${sets.join(', ')} WHERE id = $${params.length}`;

  try {
    await pool.query(sql, params);
  } catch (err: any) {
    if (isOwnerNameConflict(err)) throw fail('DUPLICATE_NAME', 409);
    throw err;
  }

  const updated = await getExerciseById(exerciseId);
  if (!updated) throw fail('exercise_not_found', 404);
  return updated;
}

export async function archivePersonalExercise(personalId: number, exerciseId: string): Promise<Exercise> {
  const result = await pool.query(
    `UPDATE exercises SET status = 'archived', updated_at = NOW()
      WHERE id = $1 AND owner_personal_id = $2
      RETURNING id`,
    [exerciseId, personalId],
  );
  if (!result.rowCount) throw fail('exercise_not_found', 404);
  const archived = await getExerciseById(exerciseId);
  if (!archived) throw fail('exercise_not_found', 404);
  return archived;
}

export async function restorePersonalExercise(personalId: number, exerciseId: string): Promise<Exercise> {
  let result;
  try {
    result = await pool.query(
      `UPDATE exercises SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND owner_personal_id = $2
        RETURNING id`,
      [exerciseId, personalId],
    );
  } catch (err: any) {
    // D12, caminho real: a UNIQUE parcial por-dono é escopada a
    // `status = 'active'` (migration 1837000000000) — dois exercícios ATIVOS
    // do mesmo personal não podem ter o mesmo nome, mas um nome ARQUIVADO
    // libera para reuso imediato. Se o personal criou outro exercício com o
    // mesmo nome enquanto o original estava arquivado, restaurar o original
    // volta a colidir com esse homônimo ativo — 409 claro, não 500 cru.
    if (isOwnerNameConflict(err)) throw fail('DUPLICATE_NAME', 409);
    throw err;
  }
  if (!result.rowCount) throw fail('exercise_not_found', 404);
  const restored = await getExerciseById(exerciseId);
  if (!restored) throw fail('exercise_not_found', 404);
  return restored;
}

export type ListPersonalExercisesFilter = {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  offset?: number;
};

/** Tela de gestão "Meus Exercícios" — só a própria biblioteca, ativa e/ou arquivada. */
export async function listPersonalExercises(
  personalId: number,
  filter: ListPersonalExercisesFilter = {},
): Promise<ExerciseSummary[]> {
  return searchExercises({
    q: filter.q,
    ownerOnly: personalId,
    includeArchived: filter.status !== 'active',
    limit: filter.limit,
    offset: filter.offset,
  }).then((rows) =>
    filter.status === 'archived' ? rows.filter((r) => r.status === 'archived') : rows,
  );
}

// ---------------------------------------------------------------------------
// Mídia — mesmo fluxo presigned de 2 passos de `progressPhotoService.ts`,
// adaptado para o prefixo do exercício em vez do prefixo do usuário.
// Sem vídeo binário nesta sprint (streaming/transcodificação é fora de
// escopo) — vídeo é coberto por link do YouTube.
// ---------------------------------------------------------------------------

const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10MB — mesmo limite de progressPhotoService.ts
const UPLOAD_URL_TTL = 300; // s

const MEDIA_EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const YOUTUBE_URL_RE = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i;

function mediaKeyPrefix(personalId: number, exerciseId: string): string {
  return `exercise-media/${personalId}/${exerciseId}/`;
}

export async function createExerciseMediaUploadTarget(
  personalId: number,
  exerciseId: string,
  contentType: string,
  byteSize: number,
): Promise<{ uploadUrl: string; storageKey: string; expiresIn: number }> {
  await requireOwnedExercise(personalId, exerciseId);
  assertStorageConfigured();

  const ext = MEDIA_EXT_BY_TYPE[contentType];
  if (!ext) throw fail('unsupported_content_type', 400);
  if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MEDIA_MAX_BYTES) {
    throw fail('invalid_byte_size', 400);
  }

  const storageKey = `${mediaKeyPrefix(personalId, exerciseId)}${randomUUID()}.${ext}`;
  const { uploadUrl, expiresIn } = await getStorage().createUploadUrl(storageKey, contentType, UPLOAD_URL_TTL);
  return { uploadUrl, storageKey, expiresIn };
}

async function insertMediaRow(
  exerciseId: string,
  input: { mediaType: 'image' | 'youtube'; url: string; isPrimary: boolean },
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.isPrimary) {
      await client.query(`UPDATE exercise_media SET is_primary = false WHERE exercise_id = $1`, [exerciseId]);
    }
    await client.query(
      `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
       VALUES ($1, $2, $3, 'personal', $4)`,
      [exerciseId, input.mediaType, input.url, input.isPrimary],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function registerExerciseMedia(
  personalId: number,
  exerciseId: string,
  input: { storageKey: string; isPrimary?: boolean },
): Promise<void> {
  await requireOwnedExercise(personalId, exerciseId);
  assertStorageConfigured();

  // Posse da CHAVE: precisa estar sob o prefixo deste personal + este exercício.
  if (typeof input.storageKey !== 'string' || !input.storageKey.startsWith(mediaKeyPrefix(personalId, exerciseId))) {
    throw fail('forbidden_storage_key', 403);
  }
  const head = await getStorage().headObject(input.storageKey);
  if (!head) throw fail('object_not_found', 404);
  if (head.byteSize && head.byteSize > MEDIA_MAX_BYTES) {
    await getStorage().deleteObject(input.storageKey).catch(() => {});
    throw fail('object_too_large', 400);
  }

  await insertMediaRow(exerciseId, { mediaType: 'image', url: input.storageKey, isPrimary: input.isPrimary === true });
}

export async function registerExerciseYoutubeLink(
  personalId: number,
  exerciseId: string,
  input: { url: string; isPrimary?: boolean },
): Promise<void> {
  await requireOwnedExercise(personalId, exerciseId);

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!YOUTUBE_URL_RE.test(url)) throw fail('invalid_youtube_url', 400);

  await insertMediaRow(exerciseId, { mediaType: 'youtube', url, isPrimary: input.isPrimary === true });
}

export async function deleteExerciseMedia(personalId: number, exerciseId: string, mediaId: string): Promise<void> {
  const result = await pool.query(
    `DELETE FROM exercise_media
      WHERE id = $1 AND exercise_id = $2
        AND exercise_id IN (SELECT id FROM exercises WHERE owner_personal_id = $3)`,
    [mediaId, exerciseId, personalId],
  );
  if (!result.rowCount) throw fail('media_not_found', 404);
}
