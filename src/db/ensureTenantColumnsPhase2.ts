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
    // Nem toda tabela desta lista pertence ao schema base: algumas nascem em
    // ensure* que rodam depois (personal_workout_plans, workout_reviews,
    // activity_sessions…). Num banco novo isso derrubava o passo inteiro com
    // 42P01, e com ele o boot/seed (QA 01/ago/2026, P0-3). Pular o que ainda
    // não existe é seguro: o boot chama este passo de novo depois dos
    // criadores, e ADD COLUMN IF NOT EXISTS é idempotente.
    const { rows } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass($1)::text AS reg`,
      [`public.${table}`]
    );
    if (rows[0]?.reg === null) {
      logger.info({ table }, '[db] ensureTenantColumnsPhase2: tabela ainda não existe, pulando');
      continue;
    }

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

  // Extra composite indexes for high-frequency queries. Mesma guarda: a tabela
  // pode ainda não existir na primeira passada de um banco novo.
  const extraIndexes: Array<[string, string]> = [
    ['user_daily_checkins', 'idx_user_daily_checkins_academy_user ON user_daily_checkins(academy_id, user_id)'],
    ['user_workout_logs', 'idx_user_workout_logs_academy_user ON user_workout_logs(academy_id, user_id)'],
    ['activity_sessions', 'idx_activity_sessions_academy_user ON activity_sessions(academy_id, user_id)'],
    ['chat_conversations', 'idx_chat_conversations_academy_id ON chat_conversations(academy_id)'],
    ['personal_student_assignments', 'idx_personal_student_assignments_academy_id ON personal_student_assignments(academy_id)'],
  ];
  for (const [table, indexDef] of extraIndexes) {
    const { rows } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass($1)::text AS reg`,
      [`public.${table}`]
    );
    if (rows[0]?.reg === null) continue;
    await pool.query(`CREATE INDEX IF NOT EXISTS ${indexDef}`);
  }

  logger.info('[db] ensureTenantColumnsPhase2: academy_id columns + indexes created');
}
