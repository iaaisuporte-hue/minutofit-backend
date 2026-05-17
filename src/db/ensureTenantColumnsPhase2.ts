import pool from '../config/database';
import logger from '../lib/logger';

/**
 * Fase 2 — Adiciona academy_id (nullable) em todas as tabelas operacionais
 * que ainda não possuem isolamento de tenant.
 *
 * Idempotente: usa ADD COLUMN IF NOT EXISTS.
 * Deve rodar APÓS ensureAcademiesSchema + seedDefaultAcademy.
 * Após este script, executar backfillTenantColumns e depois
 * ensureTenantColumnsPhase2Lock para tornar academy_id NOT NULL.
 */
export async function ensureTenantColumnsPhase2(): Promise<void> {
  const tables: string[] = [
    'user_subscriptions',
    'payments',
    'videos',
    'personal_student_assignments',
    'personal_workout_plans',
    'workout_reviews',
    'chat_conversations',
    'user_metabolism_snapshots',
    'user_daily_checkins',
    'user_workout_logs',
    'user_activity_logs',
    'user_gamification_stats',
    'activity_sessions',
    'movement_sessions',
  ];

  for (const table of tables) {
    await pool.query(`
      ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS academy_id INTEGER REFERENCES academies(id)
    `);
    // Composite index: most tenant queries filter by (academy_id, user_id)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${table}_academy_id
        ON ${table}(academy_id)
    `);
  }

  // Extra composite indexes for high-frequency queries
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_daily_checkins_academy_user
      ON user_daily_checkins(academy_id, user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_workout_logs_academy_user
      ON user_workout_logs(academy_id, user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_academy_user
      ON activity_sessions(academy_id, user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_academy_id
      ON chat_conversations(academy_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_personal_student_assignments_academy_id
      ON personal_student_assignments(academy_id)
  `);

  logger.info('[db] ensureTenantColumnsPhase2: academy_id columns + indexes created');
}
