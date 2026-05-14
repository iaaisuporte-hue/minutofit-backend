import pool from '../config/database';
import logger from '../lib/logger';
import { runExercisesSeed } from './seedExercisesLibrary.core';

/**
 * Popula ou atualiza a biblioteca de exercícios no boot.
 * - Se a tabela estiver vazia: seed completo.
 * - Se houver exercícios sem mídia (> GAP_THRESHOLD): re-seed para preencher gaps.
 * - Caso contrário: skip.
 *
 * O re-seed usa ON CONFLICT DO UPDATE/DO NOTHING, portanto é idempotente.
 */
const GAP_THRESHOLD = 5; // exercícios sem mídia que disparam re-seed

export async function seedExercisesIfEmpty(): Promise<void> {
  const countRes = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM exercises`);
  const total = parseInt(countRes.rows[0].count, 10);

  if (total === 0) {
    logger.info('[seed:exercises] Tabela vazia — executando seed completo...');
    await _runAndLog();
    return;
  }

  // Detect exercises without any media (gaps caused by new freeDbId mappings)
  const gapRes = await pool.query<{ count: string }>(`
    SELECT COUNT(*) FROM exercises e
    LEFT JOIN exercise_media m ON e.id = m.exercise_id
    WHERE m.id IS NULL
  `);
  const withoutMedia = parseInt(gapRes.rows[0].count, 10);

  if (withoutMedia > GAP_THRESHOLD) {
    logger.info(
      { withoutMedia, total },
      '[seed:exercises] Exercícios sem mídia detectados — preenchendo gaps...'
    );
    await _runAndLog();
    return;
  }

  logger.info(
    { total, withoutMedia },
    '[seed:exercises] Biblioteca OK — pulando seed automático.'
  );
}

async function _runAndLog(): Promise<void> {
  const result = await runExercisesSeed(pool);
  if (result.errors > 0) {
    logger.warn(
      { errors: result.errors, total: result.total },
      '[seed:exercises] Seed concluído com erros parciais'
    );
  } else {
    logger.info(result, '[seed:exercises] Seed/gap-fill concluído com sucesso');
  }
}
