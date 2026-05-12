import pool from '../config/database';

export type AuditAction =
  | 'branding.update'
  | 'academy.status'
  | 'student.enroll'
  | 'student.pause'
  | 'student.cancel'
  | 'student.reactivate'
  | 'student.password_reset'
  | 'team.role_update'
  | 'team.add_member'
  | 'team.remove_member'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept'
  | 'auth.switch_academy'
  | 'product.grant'
  | 'product.revoke';

export interface AuditEntry {
  academyId: number | null;
  userId?: number | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: number | null;
  meta?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export interface AuditLogRow {
  id: number;
  academy_id: number | null;
  user_id: number | null;
  actor_name: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: number | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Retorna as últimas N ações de audit de uma academia.
 * Faz JOIN com users para incluir o nome do ator.
 */
export async function listAcademyAudit(
  academyId: number,
  limit = 50,
  offset = 0
): Promise<AuditLogRow[]> {
  const result = await pool.query<AuditLogRow>(
    `SELECT
       aal.id,
       aal.academy_id,
       aal.user_id,
       u.name AS actor_name,
       aal.action,
       aal.entity_type,
       aal.entity_id,
       aal.meta,
       aal.created_at
     FROM academy_audit_log aal
     LEFT JOIN users u ON u.id = aal.user_id
     WHERE aal.academy_id = $1
     ORDER BY aal.created_at DESC
     LIMIT $2 OFFSET $3`,
    [academyId, limit, offset]
  );
  return result.rows;
}

/**
 * Logs an administrative action to academy_audit_log.
 *
 * Non-blocking: errors are caught and logged to console but never propagate
 * to the caller. Safe to fire-and-forget in route handlers.
 */
export function logAcademyAction(entry: AuditEntry): void {
  pool
    .query(
      `INSERT INTO academy_audit_log
         (academy_id, user_id, action, entity_type, entity_id, meta, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
      [
        entry.academyId,
        entry.userId ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null,
        entry.ipAddress ?? null,
      ]
    )
    .catch((err) => {
      console.error('[audit] logAcademyAction failed:', err?.message ?? err);
    });
}
