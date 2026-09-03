/**
 * Lógica central de seed da biblioteca de exercícios CoreFit.
 * Reutilizada tanto pelo script CLI (seedExercisesLibrary.ts)
 * quanto pelo boot automático (seedExercisesIfEmpty.ts).
 *
 * Estratégia: ON CONFLICT (normalized_name, source) DO UPDATE — idempotente.
 * O índice-alvo é PARCIAL desde a Sprint P1 (migration 1837000000000), então
 * o ON CONFLICT precisa do predicado WHERE owner_personal_id IS NULL AND
 * status = 'active' — sem ele o Postgres não acha índice para mirar.
 * Mídia: free-exercise-db snapshot para GIFs, youtubeId para YouTube.
 */

import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { EXERCISES_SEED, type ExerciseSeed } from '../seeds/exercisesLibrary.seed';
import {
  COMMON_GYM_EXERCISES_SEED,
  COMMON_GYM_EXERCISE_ALIASES,
} from '../seeds/commonGymExerciseCoverage.seed';
import { gifDoTreinoUrl } from '../seeds/gifDoTreino.map';
import logger from '../lib/logger';

const FREE_DB_BASE_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

function resolveFreeDbSnapshotPath(): string {
  // Funciona tanto em src/scripts/__dirname (dev) quanto dist/scripts/__dirname (prod)
  // Sobe dois níveis para chegar em src/ ou dist/ e encontrar seeds/
  const candidates = [
    path.resolve(__dirname, '../seeds/freeExerciseDb.snapshot.json'),
    path.resolve(__dirname, '../../src/seeds/freeExerciseDb.snapshot.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // will trigger the warn below
}

export function buildFreeDbImageMap(): Map<string, string> {
  const map = new Map<string, string>();
  const snapshotPath = resolveFreeDbSnapshotPath();
  if (!fs.existsSync(snapshotPath)) {
    logger.warn(
      { path: snapshotPath },
      '[seed:exercises] Snapshot free-exercise-db não encontrado. Nenhum GIF automático.'
    );
    return map;
  }
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const data = JSON.parse(raw) as Array<{ id: string; images?: string[] }>;
    for (const entry of data) {
      if (entry.images && entry.images.length > 0) {
        map.set(entry.id, `${FREE_DB_BASE_URL}/${entry.id}/0.jpg`);
      }
    }
    logger.info({ count: map.size }, '[seed:exercises] Snapshot free-exercise-db carregado');
  } catch (err) {
    logger.error({ err }, '[seed:exercises] Falha ao carregar snapshot free-exercise-db');
  }
  return map;
}

function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withCommonGymAliases(seed: ExerciseSeed): ExerciseSeed {
  const aliases = COMMON_GYM_EXERCISE_ALIASES[seed.name] ?? [];
  if (!aliases.length) return seed;

  const mergedTags = new Set<string>();
  for (const tag of [...seed.tags, ...aliases]) {
    if (tag.trim()) mergedTags.add(tag.toLowerCase());
    const normalizedTag = normalizeTag(tag);
    if (normalizedTag) mergedTags.add(normalizedTag);
  }

  return { ...seed, tags: [...mergedTags] };
}

async function upsertExercise(
  pool: Pool,
  seed: ExerciseSeed
): Promise<{ id: string; created: boolean }> {
  const normalizedName = normalizeExerciseName(seed.name);
  const externalId = seed.externalId ?? null;

  const res = await pool.query(
    `INSERT INTO exercises (
       source, external_id, name, normalized_name,
       body_part, target_muscle, secondary_muscles,
       equipment, tags, instructions, tips
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     -- O índice único de (normalized_name, source) virou PARCIAL na Sprint P1
     -- (migration 1837000000000, WHERE owner_personal_id IS NULL AND status =
     -- 'active') — o seed só escreve no catálogo global, então o predicado
     -- precisa repetir exatamente o do índice (ver exerciseLibraryService.ts).
     ON CONFLICT (normalized_name, source) WHERE owner_personal_id IS NULL AND status = 'active'
     DO UPDATE SET
       name        = EXCLUDED.name,
       body_part   = EXCLUDED.body_part,
       target_muscle  = EXCLUDED.target_muscle,
       secondary_muscles = EXCLUDED.secondary_muscles,
       equipment   = EXCLUDED.equipment,
       tags        = EXCLUDED.tags,
       instructions = EXCLUDED.instructions,
       tips        = EXCLUDED.tips,
       updated_at  = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [
      seed.source,
      externalId,
      seed.name,
      normalizedName,
      seed.bodyPart,
      seed.targetMuscle,
      seed.secondaryMuscles,
      seed.equipment,
      seed.tags,
      JSON.stringify(seed.instructions),
      JSON.stringify(seed.tips),
    ]
  );

  const row = res.rows[0];
  return { id: String(row.id), created: Boolean(row.created) };
}

async function upsertExerciseMedia(
  pool: Pool,
  exerciseId: string,
  url: string,
  mediaType: 'youtube' | 'image' | 'gif' | 'video',
  isPrimary: boolean,
  source: string = 'corefit'
): Promise<void> {
  if (isPrimary) {
    await pool.query(
      `UPDATE exercise_media
       SET is_primary = false,
           updated_at = NOW()
       WHERE exercise_id = $1
         AND url <> $2
         AND is_primary = true`,
      [exerciseId, url]
    );
  }

  await pool.query(
    `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (exercise_id, url) DO UPDATE
       SET is_primary = EXCLUDED.is_primary,
           source     = EXCLUDED.source,
           updated_at = NOW()`,
    [exerciseId, mediaType, url, source, isPrimary]
  );
}

export interface RunSeedResult {
  total: number;
  created: number;
  updated: number;
  mediaInserted: number;
  errors: number;
}

/**
 * Executa o seed completo da biblioteca de exercícios.
 * Recebe o `pool` já aberto — não fecha a conexão ao terminar.
 */
export async function runExercisesSeed(pool: Pool): Promise<RunSeedResult> {
  logger.info('[seed:exercises] Iniciando seed da biblioteca CoreFit...');

  const freeDbMap = buildFreeDbImageMap();
  const seeds = [...EXERCISES_SEED.map(withCommonGymAliases), ...COMMON_GYM_EXERCISES_SEED];
  let created = 0;
  let updated = 0;
  let mediaInserted = 0;
  let errors = 0;

  for (const seed of seeds) {
    try {
      const { id, created: wasCreated } = await upsertExercise(pool, seed);
      if (wasCreated) {
        created++;
      } else {
        updated++;
      }

      // GIF animado do gifdotreino (fonte preferida) — só quando o exercício tem
      // match no mapa E EXERCISE_MEDIA_BASE_URL está configurada. Vira a mídia
      // primária; free-exercise-db abaixo entra como fallback estático não-primário.
      const gdtUrl = gifDoTreinoUrl(seed.name);
      if (gdtUrl) {
        await upsertExerciseMedia(pool, id, gdtUrl, 'gif', true, 'gifdotreino');
        mediaInserted++;
      }

      if (seed.freeDbId) {
        const gifUrl = freeDbMap.get(seed.freeDbId);
        if (gifUrl) {
          await upsertExerciseMedia(pool, id, gifUrl, 'image', !gdtUrl, 'free-exercise-db');
          mediaInserted++;
        } else {
          logger.warn(
            { freeDbId: seed.freeDbId, exercise: seed.name },
            '[seed:exercises] freeDbId não encontrado no snapshot'
          );
        }
      }

      if (seed.youtubeId) {
        const ytUrl = `https://www.youtube.com/watch?v=${seed.youtubeId}`;
        const isPrimary = !gdtUrl && !seed.freeDbId;
        await upsertExerciseMedia(pool, id, ytUrl, 'youtube', isPrimary);
        mediaInserted++;
      }

      if (seed.imageUrl) {
        await upsertExerciseMedia(
          pool, id, seed.imageUrl, 'image',
          !gdtUrl && !seed.freeDbId && !seed.youtubeId
        );
      }
      if (seed.videoUrl) {
        await upsertExerciseMedia(pool, id, seed.videoUrl, 'youtube', false);
      }
    } catch (err: unknown) {
      errors++;
      logger.error(
        { err: err instanceof Error ? err.message : err, exercise: seed.name },
        '[seed:exercises] Erro ao inserir exercício'
      );
    }
  }

  const result: RunSeedResult = { total: seeds.length, created, updated, mediaInserted, errors };
  logger.info(result, '[seed:exercises] Seed concluído');
  return result;
}
