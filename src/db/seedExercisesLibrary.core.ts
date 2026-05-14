/**
 * Lógica central de seed da biblioteca de exercícios MetaCore.
 * Reutilizada tanto pelo script CLI (seedExercisesLibrary.ts)
 * quanto pelo boot automático (seedExercisesIfEmpty.ts).
 *
 * Estratégia: ON CONFLICT (normalized_name, source) DO UPDATE — idempotente.
 * Mídia: free-exercise-db snapshot para GIFs, youtubeId para YouTube.
 */

import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { EXERCISES_SEED, type ExerciseSeed } from '../seeds/exercisesLibrary.seed';
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
     ON CONFLICT (normalized_name, source)
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
  source: string = 'metacore'
): Promise<void> {
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
  logger.info('[seed:exercises] Iniciando seed da biblioteca MetaCore...');

  const freeDbMap = buildFreeDbImageMap();
  let created = 0;
  let updated = 0;
  let mediaInserted = 0;
  let errors = 0;

  for (const seed of EXERCISES_SEED) {
    try {
      const { id, created: wasCreated } = await upsertExercise(pool, seed);
      if (wasCreated) {
        created++;
      } else {
        updated++;
      }

      if (seed.freeDbId) {
        const gifUrl = freeDbMap.get(seed.freeDbId);
        if (gifUrl) {
          await upsertExerciseMedia(pool, id, gifUrl, 'image', true, 'free-exercise-db');
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
        const isPrimary = !seed.freeDbId;
        await upsertExerciseMedia(pool, id, ytUrl, 'youtube', isPrimary);
        mediaInserted++;
      }

      if (seed.imageUrl) {
        await upsertExerciseMedia(
          pool, id, seed.imageUrl, 'image',
          !seed.freeDbId && !seed.youtubeId
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

  const result: RunSeedResult = { total: EXERCISES_SEED.length, created, updated, mediaInserted, errors };
  logger.info(result, '[seed:exercises] Seed concluído');
  return result;
}
