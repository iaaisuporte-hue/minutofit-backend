import pool from '../config/database';
import logger from '../lib/logger';

export type DataAccessEventType =
  | 'request.created'
  | 'request.accepted'
  | 'request.rejected'
  | 'request.cancelled'
  | 'request.expired'
  | 'consent.granted'
  | 'consent.revoked'
  | 'connection.revoked'
  | 'academy_policy.changed'
  | 'professional_network.reviewed'
  | 'offering.created'
  | 'offering.updated'
  | 'offering.archived'
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.cancelled'
  | 'subscription.paused'
  | 'subscription.expired'
  | 'subscription.payment_failed'
  | 'voice_note.published'
  | 'voice_note.read'
  | 'sport.profile.upserted'
  | 'sport.profile.deactivated'
  | 'sport.checkin.created'
  | 'sport.camp.created'
  | 'sport.post_checkin.created'
  | 'personal.sport.read'
  | 'personal.snapshot.read'
  | 'personal.ai_summary.read'
  | 'nutri.plan.created'
  | 'nutri.plan.updated'
  | 'nutri.plan.ended'
  | 'nutri.observation.created'
  | 'nutri.observation.read'
  | 'nutri.context.read'
  | 'nutri.meal_heatmap.read'
  | 'nutri.adherence.read'
  | 'nutri.data.patient_deletion'
  | 'parq.signed'
  | 'training.adaptation.applied'
  | 'training.adaptation.viewed'
  | 'training.policy.updated'
  | 'push.checkin_reminder'
  | 'student.session_touchpoint.viewed';

export interface DataAccessAuditEntry {
  actorId: number;
  subjectUserId: number;
  eventType: DataAccessEventType;
  eventPayload?: Record<string, unknown>;
  ip?: string;
}

export async function logDataAccessEvent(
  entry: DataAccessAuditEntry,
  client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> }
): Promise<void> {
  const q = client ?? pool;
  try {
    await q.query(
      `INSERT INTO data_access_audit (actor_id, subject_user_id, event_type, event_payload, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.actorId,
        entry.subjectUserId,
        entry.eventType,
        JSON.stringify(entry.eventPayload ?? {}),
        entry.ip ?? null,
      ]
    );
  } catch (err) {
    logger.error({ err, entry }, '[dataAccessAudit] failed to write audit entry');
  }
}

export async function getAuditTrailForUser(
  subjectUserId: number,
  limit = 50
): Promise<Array<{
  id: string;
  actorId: number;
  eventType: string;
  eventPayload: Record<string, unknown>;
  createdAt: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, actor_id, event_type, event_payload, created_at
     FROM data_access_audit
     WHERE subject_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [subjectUserId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    eventType: r.event_type,
    eventPayload: r.event_payload,
    createdAt: r.created_at,
  }));
}
