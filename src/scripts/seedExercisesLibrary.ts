/**
 * Script idempotente para popular as tabelas exercises + exercise_media com o
 * seed curado MetaCore.
 *
 * Estratégia: ON CONFLICT (normalized_name, source) DO UPDATE — seguro para re-executar.
 *
 * Mídia automática:
 *  - freeDbId → GIF/imagem do repositório yuhonas/free-exercise-db (zero dep runtime)
 *    URL: https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/{id}/0.jpg
 *  - youtubeId → media_type='youtube' (preenchido via PATCH /api/exercises/:id)
 *  - imageUrl / videoUrl → fallback manual (override direto)
 *
 * Uso: npm run seed:exercises
 */

import path from 'path';
import fs from 'fs';
import pool from '../config/database';
import { EXERCISES_SEED, type ExerciseSeed } from '../seeds/exercisesLibrary.seed';
import logger from '../lib/logger';

const FREE_DB_SNAPSHOT = path.resolve(__dirname, '../seeds/freeExerciseDb.snapshot.json');
const FREE_DB_BASE_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

/** Mapa de freeDbId -> URL da imagem primária */
function buildFreeDbImageMap(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(FREE_DB_SNAPSHOT)) {
    logger.warn('[seed:exercises] Snapshot free-exercise-db não encontrado. Nenhum GIF automático.');
    return map;
  }
  try {
    const raw = fs.readFileSync(FREE_DB_SNAPSHOT, 'utf8');
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

async function upsertExercise(seed: ExerciseSeed): Promise<{ id: string; created: boolean }> {
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
       name = EXCLUDED.name,
       body_part = EXCLUDED.body_part,
       target_muscle = EXCLUDED.target_muscle,
       secondary_muscles = EXCLUDED.secondary_muscles,
       equipment = EXCLUDED.equipment,
       tags = EXCLUDED.tags,
       instructions = EXCLUDED.instructions,
       tips = EXCLUDED.tips,
       updated_at = NOW()
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
  exerciseId: string,
  url: string,
  mediaType: 'youtube' | 'image' | 'gif' | 'video',
  isPrimary: boolean,
  source: string = 'metacore'
): Promise<void> {
  await pool.query(
    `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [exerciseId, mediaType, url, source, isPrimary]
  );
}

async function main() {
  logger.info('[seed:exercises] Iniciando seed da biblioteca MetaCore...');

  const freeDbMap = buildFreeDbImageMap();

  let created = 0;
  let updated = 0;
  let mediaInserted = 0;
  let errors = 0;

  for (const seed of EXERCISES_SEED) {
    try {
      const { id, created: wasCreated } = await upsertExercise(seed);

      if (wasCreated) {
        created++;
      } else {
        updated++;
      }

      // ── Mídia automática via free-exercise-db ───────────────────────────
      if (seed.freeDbId) {
        const gifUrl = freeDbMap.get(seed.freeDbId);
        if (gifUrl) {
          await upsertExerciseMedia(id, gifUrl, 'image', true, 'free-exercise-db');
          mediaInserted++;
        } else {
          logger.warn(
            { freeDbId: seed.freeDbId, exercise: seed.name },
            '[seed:exercises] freeDbId não encontrado no snapshot'
          );
        }
      }

      // ── YouTube (curadoria manual; não overwrite mídia primária) ────────
      if (seed.youtubeId) {
        const ytUrl = `https://www.youtube.com/watch?v=${seed.youtubeId}`;
        const isPrimary = !seed.freeDbId; // primária só se não tem GIF
        await upsertExerciseMedia(id, ytUrl, 'youtube', isPrimary);
        mediaInserted++;
      }

      // ── Override manual (imageUrl / videoUrl) ────────────────────────────
      if (seed.imageUrl) {
        await upsertExerciseMedia(id, seed.imageUrl, 'image', !seed.freeDbId && !seed.youtubeId);
      }
      if (seed.videoUrl) {
        await upsertExerciseMedia(id, seed.videoUrl, 'youtube', false);
      }
    } catch (err: unknown) {
      errors++;
      logger.error(
        { err: err instanceof Error ? err.message : err, exercise: seed.name },
        '[seed:exercises] Erro ao inserir exercício'
      );
    }
  }

  logger.info(
    { total: EXERCISES_SEED.length, created, updated, mediaInserted, errors },
    '[seed:exercises] Seed concluído'
  );

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[seed:exercises] Falha fatal');
  process.exit(1);
});
