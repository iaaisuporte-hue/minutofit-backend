import pool from '../config/database';
import logger from '../lib/logger';
import { runExercisesSeed } from './seedExercisesLibrary.core';

/**
 * Popula a biblioteca de exercícios no primeiro boot quando a tabela estiver vazia.
 * Idempotente: se já houver linhas em `exercises`, retorna imediatamente.
 * Chamado pelo runBootChain logo após ensureExercisesSchema.
 */
export async function seedExercisesIfEmpty(): Promise<void> {
  const check = await pool.query(`SELECT 1 FROM exercises LIMIT 1`);
  if (check.rows.length > 0) {
    logger.info('[seed:exercises] Biblioteca já populada — pulando seed automático.');
    return;
  }

  logger.info('[seed:exercises] Tabela vazia — executando seed automático...');
  const result = await runExercisesSeed(pool);
  if (result.errors > 0) {
    logger.warn(
      { errors: result.errors, total: result.total },
      '[seed:exercises] Seed concluído com erros parciais'
    );
  }
}
