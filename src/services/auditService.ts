import pool from '../config/database';

export type AuditAction =
  | 'branding.update'
  | 'academy.status'
  | 'student.enroll'
  | 'student.pause'
  | 'student.cancel'
  | 'student.reactivate'
  | 'team.role_update'
  | 'team.add_member'
  | 'team.remove_member'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept'
  | 'auth.switch_academy';

export interface AuditEntry {
  academyId: number;
  userId?: number | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: number | null;
  meta?: Record<string, unknown> | null;
  ipAddress?: string | null;
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
