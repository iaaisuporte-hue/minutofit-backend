/**
 * Script CLI idempotente para popular exercises + exercise_media.
 * Uso: npm run seed:exercises
 *
 * A lógica central está em src/db/seedExercisesLibrary.core.ts
 * (reutilizada também no boot automático via seedExercisesIfEmpty).
 */

import pool from '../config/database';
import logger from '../lib/logger';
import { runExercisesSeed } from '../db/seedExercisesLibrary.core';

async function main() {
  try {
    await runExercisesSeed(pool);
  } catch (err: unknown) {
    logger.error({ err }, '[seed:exercises] Falha fatal');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
