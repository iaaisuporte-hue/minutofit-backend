import { Pool, PoolClient } from 'pg';
import logger from '../lib/logger';

/**
 * Grava uma entrada na academy_audit_log.
 * Nunca lança — erros são apenas logados para não quebrar a transação principal.
 */
export async function auditLog(
  db: Pool | PoolClient,
  params: {
    academyId: number;
    userId?: number | null;
    action: string;
    entityType?: string;
    entityId?: number;
    meta?: Record<string, unknown>;
    ipAddress?: string;
  }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO academy_audit_log
         (academy_id, user_id, action, entity_type, entity_id, meta, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.academyId,
        params.userId ?? null,
        params.action,
        params.entityType ?? null,
        params.entityId ?? null,
        params.meta ? JSON.stringify(params.meta) : null,
        params.ipAddress ?? null,
      ]
    );
  } catch (err) {
    logger.error({ err }, '[auditLog] failed to write');
  }
}
