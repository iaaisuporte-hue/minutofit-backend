import { Pool, PoolClient } from 'pg';

/**
 * Helper de query escopada por academia.
 *
 * Em desenvolvimento, lança erro se a query não contiver 'academy_id'
 * para prevenir queries sem filtro de tenant nas tabelas operacionais.
 *
 * Uso:
 *   const rows = await withTenant(pool, req.tenant.academyId,
 *     'SELECT * FROM user_metabolism_snapshots WHERE user_id = $1 AND academy_id = $2',
 *     [userId, TENANT_PLACEHOLDER]
 *   );
 *
 * Use TENANT_PLACEHOLDER como valor de academy_id nos params —
 * a função o substitui pelo academyId real antes de executar.
 */

export const TENANT_PLACEHOLDER = '__TENANT__';

export async function withTenant(
  db: Pool | PoolClient,
  academyId: number,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: any[] }> {
  if (process.env.NODE_ENV !== 'production') {
    const sqlNorm = sql.toLowerCase().replace(/\s+/g, ' ');
    if (!sqlNorm.includes('academy_id')) {
      throw new Error(
        `[tenantQuery] Query does not contain academy_id filter. ` +
        `This is required for tenant-scoped queries.\nSQL: ${sql}`
      );
    }
  }

  const resolvedParams = params.map((p) => (p === TENANT_PLACEHOLDER ? academyId : p));
  return db.query(sql, resolvedParams);
}
