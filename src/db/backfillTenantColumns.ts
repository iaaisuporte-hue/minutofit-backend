import pool from '../config/database';

const DEFAULT_ACADEMY_SLUG = 'minutofit-direto';

/**
 * Preenche academy_id = <id da academia padrão> em todos os registros
 * que ainda não possuem academy_id.
 *
 * Idempotente: usa WHERE academy_id IS NULL.
 * Decisão operacional registrada: todos os dados históricos pertencem
 * à academia padrão "MinutoFit Direto" enquanto o modelo multi-tenant
 * não está 100% estabilizado. Refinar por academia real é uma tarefa
 * futura de saneamento (ver plano_2026-05-12_1.md).
 *
 * Deve rodar APÓS ensureTenantColumnsPhase2.
 */
export async function backfillTenantColumns(): Promise<void> {
  const result = await pool.query(
    `SELECT id FROM academies WHERE slug = $1`,
    [DEFAULT_ACADEMY_SLUG]
  );

  if (result.rows.length === 0) {
    console.warn('[db] backfillTenantColumns: academia padrão não encontrada, pulando backfill.');
    return;
  }

  const defaultAcademyId: number = result.rows[0].id;

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

  let total = 0;
  for (const table of tables) {
    try {
      const r = await pool.query(
        `UPDATE ${table} SET academy_id = $1 WHERE academy_id IS NULL`,
        [defaultAcademyId]
      );
      if (r.rowCount && r.rowCount > 0) {
        console.log(`[db] backfillTenantColumns: ${table} → ${r.rowCount} rows updated`);
        total += r.rowCount;
      }
    } catch (err: any) {
      // Column may not exist yet if phase2 wasn't run — skip gracefully
      if (err?.code === '42703') {
        console.warn(`[db] backfillTenantColumns: ${table}.academy_id does not exist, skipping`);
      } else {
        throw err;
      }
    }
  }

  if (total === 0) {
    console.log('[db] backfillTenantColumns: nada a atualizar (todas as linhas já têm academy_id)');
  } else {
    console.log(`[db] backfillTenantColumns: total ${total} linhas atualizadas com academy_id=${defaultAcademyId}`);
  }
}
