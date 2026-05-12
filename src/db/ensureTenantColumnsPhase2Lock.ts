import pool from '../config/database';

/**
 * Marca academy_id como NOT NULL nas tabelas operacionais.
 *
 * Deve rodar SOMENTE APÓS backfillTenantColumns completar com sucesso.
 * Idempotente: verifica se a constraint já foi aplicada consultando
 * information_schema antes de tentar o ALTER.
 *
 * Segurança: se ainda existir algum NULL (backfill falhou parcialmente),
 * o ALTER falhará com constraint violation — isso é intencional e deve
 * ser investigado antes de continuar.
 */
export async function ensureTenantColumnsPhase2Lock(): Promise<void> {
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
    // Check if the column is already NOT NULL
    const check = await pool.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = $1
         AND column_name = 'academy_id'`,
      [table]
    );

    if (check.rows.length === 0) {
      console.warn(`[db] ensureTenantColumnsPhase2Lock: ${table}.academy_id column not found, skipping`);
      continue;
    }

    if (check.rows[0].is_nullable === 'NO') {
      // Already NOT NULL — nothing to do
      continue;
    }

    // Ensure no NULLs remain before locking
    const nullCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE academy_id IS NULL`
    );
    const nullCount = Number(nullCheck.rows[0].cnt);
    if (nullCount > 0) {
      console.error(
        `[db] ensureTenantColumnsPhase2Lock: ${table} still has ${nullCount} NULL academy_id rows. ` +
        `Run backfillTenantColumns first.`
      );
      continue;
    }

    await pool.query(`ALTER TABLE ${table} ALTER COLUMN academy_id SET NOT NULL`);
    console.log(`[db] ensureTenantColumnsPhase2Lock: ${table}.academy_id → NOT NULL`);
  }

  console.log('[db] ensureTenantColumnsPhase2Lock: done');
}
