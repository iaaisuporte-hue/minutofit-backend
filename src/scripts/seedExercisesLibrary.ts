/**
 * Script idempotente para popular a tabela exercises com o seed curado MetaCore.
 * Estratégia: ON CONFLICT (source, external_id) DO UPDATE — seguro para re-executar.
 * Exercícios sem external_id (native MetaCore) usam ON CONFLICT (source, name) — normalized.
 *
 * Uso: npm run seed:exercises
 */

import pool from '../config/database';
import { EXERCISES_SEED, type ExerciseSeed } from '../seeds/exercisesLibrary.seed';
import logger from '../lib/logger';

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
  isPrimary: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
     VALUES ($1, $2, $3, 'metacore', $4)
     ON CONFLICT DO NOTHING`,
    [exerciseId, mediaType, url, isPrimary]
  );
}

async function main() {
  logger.info('[seed:exercises] Iniciando seed da biblioteca MetaCore...');

  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const seed of EXERCISES_SEED) {
    try {
      const { id, created: wasCreated } = await upsertExercise(seed);

      if (wasCreated) {
        created++;
      } else {
        updated++;
      }

      if (seed.videoUrl) {
        await upsertExerciseMedia(id, seed.videoUrl, 'youtube', true);
      }
      if (seed.imageUrl) {
        await upsertExerciseMedia(id, seed.imageUrl, 'image', !seed.videoUrl);
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
    { total: EXERCISES_SEED.length, created, updated, errors },
    '[seed:exercises] Seed concluído'
  );

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[seed:exercises] Falha fatal');
  process.exit(1);
});
