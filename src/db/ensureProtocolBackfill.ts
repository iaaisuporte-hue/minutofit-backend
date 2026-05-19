/**
 * Boot-time: relinks orphan personal_workout_plans (source_protocol_id IS NULL)
 * to their corresponding workout_protocols row. Idempotent: short-circuits when
 * there are no orphans, and the underlying backfill only touches rows with
 * source_protocol_id IS NULL.
 *
 * Runs after ensureWorkoutProtocolsSchema. Same logic as the CLI script
 * `npm run script:backfill-protocols`, so a manual run remains valid.
 */

import pool from '../config/database';
import logger from '../lib/logger';
import { backfillProtocolFromPlans } from '../scripts/backfillProtocolFromPlans';

export async function ensureProtocolBackfill(): Promise<void> {
  const probe = await pool.query(
    `SELECT COUNT(*)::int AS n FROM personal_workout_plans WHERE source_protocol_id IS NULL`
  );
  const orphans = Number(probe.rows[0].n);
  if (orphans === 0) {
    logger.info('[ensureProtocolBackfill] sem órfãos — nada a vincular');
    return;
  }
  logger.info({ orphans }, '[ensureProtocolBackfill] vinculando fichas órfãs');
  const result = await backfillProtocolFromPlans(pool);
  logger.info(result, '[ensureProtocolBackfill] concluído');
}
