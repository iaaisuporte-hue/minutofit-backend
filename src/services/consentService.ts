import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';

export type ConsentScope =
  | 'profile'
  | 'workouts'
  | 'daily_checkins'
  | 'metabolic'
  | 'sleep'
  | 'body_metrics'
  | 'body_photos'
  | 'nutrition'
  | 'parq_anamnese'
  | 'activity_logs'
  | 'chat_history';

export type ProfessionalRole = 'personal' | 'nutri';

export const DEFAULT_SCOPES_PERSONAL: ConsentScope[] = ['profile', 'workouts', 'daily_checkins'];
export const DEFAULT_SCOPES_NUTRI: ConsentScope[] = ['profile', 'daily_checkins', 'nutrition'];

export interface ConsentEntry {
  id: string;
  scope: ConsentScope;
  status: 'granted' | 'revoked' | 'expired';
  grantedAt: string;
  revokedAt: string | null;
}

export async function grantConsents(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scopes: ConsentScope[],
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> }
): Promise<void> {
  for (const scope of scopes) {
    await client.query(
      `INSERT INTO user_data_consents
         (user_id, professional_id, professional_role, scope, status, granted_at)
       VALUES ($1, $2, $3, $4, 'granted', NOW())
       ON CONFLICT (user_id, professional_id, professional_role, scope)
       DO UPDATE SET status = 'granted', granted_at = NOW(), revoked_at = NULL`,
      [userId, professionalId, professionalRole, scope]
    );
    await logDataAccessEvent(
      {
        actorId: userId,
        subjectUserId: userId,
        eventType: 'consent.granted',
        eventPayload: { professionalId, professionalRole, scope },
      },
      client as never
    );
  }
}

export async function revokeConsent(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scope: ConsentScope,
  ip?: string
): Promise<void> {
  await pool.query(
    `UPDATE user_data_consents
     SET status = 'revoked', revoked_at = NOW()
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND scope = $4 AND status = 'granted'`,
    [userId, professionalId, professionalRole, scope]
  );
  await logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'consent.revoked',
    eventPayload: { professionalId, professionalRole, scope },
    ip,
  });
}

export async function revokeAllConsents(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  actorId: number,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ scope: string }> }> },
  ip?: string
): Promise<void> {
  const { rows } = await client.query(
    `UPDATE user_data_consents
     SET status = 'revoked', revoked_at = NOW()
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND status = 'granted'
     RETURNING scope`,
    [userId, professionalId, professionalRole]
  );
  for (const row of rows) {
    await logDataAccessEvent(
      {
        actorId,
        subjectUserId: userId,
        eventType: 'consent.revoked',
        eventPayload: { professionalId, professionalRole, scope: row.scope, bulk: true },
        ip,
      },
      client as never
    );
  }
}

export async function hasActiveConsent(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scope: ConsentScope
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_data_consents
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND scope = $4 AND status = 'granted'
     LIMIT 1`,
    [userId, professionalId, professionalRole, scope]
  );
  return rows.length > 0;
}

export async function listConsentsForUser(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole
): Promise<ConsentEntry[]> {
  const { rows } = await pool.query(
    `SELECT id, scope, status, granted_at, revoked_at
     FROM user_data_consents
     WHERE user_id = $1 AND professional_id = $2 AND professional_role = $3
     ORDER BY scope`,
    [userId, professionalId, professionalRole]
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    status: r.status,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
  }));
}
