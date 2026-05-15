import pool from '../config/database';

/**
 * Torna academy_id nullable nas tabelas operacionais que suportam
 * o caso "personal autônomo + aluno direto sem academia".
 *
 * Quando academy_id IS NULL o isolamento é por personal_id ou user_id.
 * Quando academy_id IS NOT NULL o isolamento por tenant continua intacto.
 *
 * Idempotente: DROP NOT NULL é no-op se a coluna já é nullable.
 * Deve rodar APÓS ensureTenantColumnsPhase2Lock.
 */
export async function relaxAcademyIdNullable(): Promise<void> {
  const tables = [
    'personal_student_assignments',
    'personal_workout_plans',
    'workout_reviews',
    'chat_conversations',
    'user_workout_logs',
    'user_activity_logs',
    'user_daily_checkins',
    'user_metabolism_snapshots',
    'user_gamification_stats',
    'activity_sessions',
    'movement_sessions',
    'nutri_patient_assignments',
    // Aluno vindo do Personal autônomo precisa de plano (mínimo Free) e
    // pode pagar sem vínculo com academia. Código de aplicação já passa
    // academy_id = null nessas tabelas; só o lock do schema bloqueava.
    'user_subscriptions',
    'payments',
  ];

  for (const table of tables) {
    const check = await pool.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = $1
         AND column_name = 'academy_id'`,
      [table]
    );
    if (check.rows.length === 0) {
      // Column doesn't exist yet — skip silently
      continue;
    }
    if (check.rows[0].is_nullable === 'YES') {
      // Already nullable
      continue;
    }
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN academy_id DROP NOT NULL`);
    console.log(`[db] relaxAcademyIdNullable: ${table}.academy_id → nullable`);
  }

  console.log('[db] relaxAcademyIdNullable: done');
}
