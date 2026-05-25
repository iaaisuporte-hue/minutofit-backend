import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';
import {
  grantConsents,
  revokeAllConsents,
  DEFAULT_SCOPES_PERSONAL,
  DEFAULT_SCOPES_NUTRI,
  type ConsentScope,
  type ProfessionalRole,
} from './consentService';
import { assertProfessionalCanReceiveDiscoveryRequest } from './professionalNetworkService';

export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
export type RequestedVia = 'email' | 'code' | 'link' | 'discovery';

export interface ProfessionalRequest {
  id: string;
  studentId: number;
  professionalId: number;
  professionalRole: ProfessionalRole;
  requestedVia: RequestedVia;
  message: string | null;
  status: RequestStatus;
  requestedScopes: ConsentScope[];
  expiresAt: string;
  respondedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

const MAX_PENDING_PER_STUDENT = 3;
const MAX_REQUESTS_PER_DAY = 5;

export async function createConnectionRequest(opts: {
  studentId: number;
  professionalId: number;
  professionalRole: ProfessionalRole;
  requestedVia: RequestedVia;
  message?: string;
  scopes?: ConsentScope[];
  academyId?: number | null;
  ip?: string;
}): Promise<ProfessionalRequest> {
  const {
    studentId,
    professionalId,
    professionalRole,
    requestedVia,
    message,
    ip,
  } = opts;

  const scopes = opts.scopes?.length
    ? opts.scopes
    : professionalRole === 'personal'
      ? DEFAULT_SCOPES_PERSONAL
      : DEFAULT_SCOPES_NUTRI;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assignmentTable =
      professionalRole === 'personal' ? 'personal_student_assignments' : 'nutri_patient_assignments';
    const studentCol = professionalRole === 'personal' ? 'student_id' : 'patient_id';

    const { rows: roleRows } = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role = $2 LIMIT 1`,
      [professionalId, professionalRole]
    );
    if (!roleRows[0]) {
      throw Object.assign(new Error('professional_not_found'), { status: 404 });
    }

    if (requestedVia === 'discovery') {
      await assertProfessionalCanReceiveDiscoveryRequest({
        academyId: opts.academyId ?? null,
        professionalId,
        professionalRole,
      });
    }

    const { rows: activeRows } = await client.query(
      `SELECT id FROM ${assignmentTable}
       WHERE ${studentCol} = $1 AND status = 'active'
       LIMIT 1`,
      [studentId]
    );
    if (activeRows[0]) {
      throw Object.assign(new Error('conflict_active_link'), { status: 409 });
    }

    // Rate limit: pendentes por aluno
    const { rows: pendingRows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM student_professional_requests
       WHERE student_id = $1 AND status = 'pending'`,
      [studentId]
    );
    if (parseInt(pendingRows[0].cnt, 10) >= MAX_PENDING_PER_STUDENT) {
      throw Object.assign(new Error('too_many_pending'), { status: 429 });
    }

    // Rate limit: requests criados hoje
    const { rows: dailyRows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM student_professional_requests
       WHERE student_id = $1 AND created_at >= NOW() - INTERVAL '1 day'`,
      [studentId]
    );
    if (parseInt(dailyRows[0].cnt, 10) >= MAX_REQUESTS_PER_DAY) {
      throw Object.assign(new Error('daily_limit_exceeded'), { status: 429 });
    }

    const { rows } = await client.query(
      `INSERT INTO student_professional_requests
         (student_id, professional_id, professional_role, requested_via, message,
          status, requested_scopes)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING *`,
      [studentId, professionalId, professionalRole, requestedVia, message ?? null, JSON.stringify(scopes)]
    );
    const req = rows[0];

    await logDataAccessEvent(
      {
        actorId: studentId,
        subjectUserId: studentId,
        eventType: 'request.created',
        eventPayload: { requestId: req.id, professionalId, professionalRole, requestedVia },
        ip,
      },
      client as never
    );

    await client.query('COMMIT');
    return mapRow(req);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function acceptConnectionRequest(opts: {
  requestId: string;
  professionalId: number;
  professionalRole: ProfessionalRole;
  ip?: string;
}): Promise<void> {
  const { requestId, professionalId, professionalRole, ip } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Casa professional_role: personal só aceita request de personal, nutri só de nutri
    const { rows } = await client.query(
      `UPDATE student_professional_requests
       SET status = 'accepted', responded_at = NOW()
       WHERE id = $1 AND professional_id = $2 AND professional_role = $3 AND status = 'pending'
       RETURNING *`,
      [requestId, professionalId, professionalRole]
    );
    if (!rows[0]) throw Object.assign(new Error('not_found_or_not_pending'), { status: 404 });
    const req = rows[0];

    // Cria assignment
    const assignmentTable =
      req.professional_role === 'personal' ? 'personal_student_assignments' : 'nutri_patient_assignments';
    const professionalCol =
      req.professional_role === 'personal' ? 'personal_id' : 'nutri_id';
    const studentCol =
      req.professional_role === 'personal' ? 'student_id' : 'patient_id';

    const { rows: activeRows } = await client.query(
      `SELECT id FROM ${assignmentTable}
       WHERE ${studentCol} = $1 AND status = 'active'
       LIMIT 1`,
      [req.student_id]
    );
    if (activeRows[0]) {
      throw Object.assign(new Error('conflict_active_link'), { status: 409 });
    }

    await client.query(
      `INSERT INTO ${assignmentTable} (${professionalCol}, ${studentCol}, status, initiated_by)
       VALUES ($1, $2, 'active', 'student')
       ON CONFLICT (${professionalCol}, ${studentCol}) DO UPDATE
         SET status = 'active', initiated_by = 'student', updated_at = NOW()`,
      [professionalId, req.student_id]
    );

    // Cria consentimentos
    const scopes: ConsentScope[] = Array.isArray(req.requested_scopes) ? req.requested_scopes : [];
    await grantConsents(req.student_id, professionalId, req.professional_role, scopes, client as never);

    await logDataAccessEvent(
      {
        actorId: professionalId,
        subjectUserId: req.student_id,
        eventType: 'request.accepted',
        eventPayload: { requestId, scopes },
        ip,
      },
      client as never
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectConnectionRequest(opts: {
  requestId: string;
  professionalId: number;
  professionalRole: ProfessionalRole;
  rejectionReason?: string;
  ip?: string;
}): Promise<void> {
  const { requestId, professionalId, professionalRole, rejectionReason, ip } = opts;

  const { rows } = await pool.query(
    `UPDATE student_professional_requests
     SET status = 'rejected', responded_at = NOW(), rejection_reason = $4
     WHERE id = $1 AND professional_id = $2 AND professional_role = $3 AND status = 'pending'
     RETURNING student_id`,
    [requestId, professionalId, professionalRole, rejectionReason ?? null]
  );
  if (!rows[0]) throw Object.assign(new Error('not_found_or_not_pending'), { status: 404 });

  await logDataAccessEvent({
    actorId: professionalId,
    subjectUserId: rows[0].student_id,
    eventType: 'request.rejected',
    eventPayload: { requestId },
    ip,
  });
}

export async function cancelConnectionRequest(opts: {
  requestId: string;
  studentId: number;
  ip?: string;
}): Promise<void> {
  const { requestId, studentId, ip } = opts;

  const { rows } = await pool.query(
    `UPDATE student_professional_requests
     SET status = 'cancelled'
     WHERE id = $1 AND student_id = $2 AND status = 'pending'
     RETURNING professional_id`,
    [requestId, studentId]
  );
  if (!rows[0]) throw Object.assign(new Error('not_found_or_not_pending'), { status: 404 });

  await logDataAccessEvent({
    actorId: studentId,
    subjectUserId: studentId,
    eventType: 'request.cancelled',
    eventPayload: { requestId, professionalId: rows[0].professional_id },
    ip,
  });
}

export async function revokeConnection(opts: {
  studentId: number;
  professionalId: number;
  professionalRole: ProfessionalRole;
  ip?: string;
}): Promise<void> {
  const { studentId, professionalId, professionalRole, ip } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assignmentTable =
      professionalRole === 'personal' ? 'personal_student_assignments' : 'nutri_patient_assignments';
    const professionalCol = professionalRole === 'personal' ? 'personal_id' : 'nutri_id';
    const studentCol = professionalRole === 'personal' ? 'student_id' : 'patient_id';

    const { rows } = await client.query(
      `UPDATE ${assignmentTable}
       SET status = 'revoked', updated_at = NOW()
       WHERE ${professionalCol} = $1 AND ${studentCol} = $2 AND status = 'active'
       RETURNING id`,
      [professionalId, studentId]
    );
    if (!rows[0]) throw Object.assign(new Error('no_active_connection'), { status: 404 });

    await revokeAllConsents(studentId, professionalId, professionalRole, studentId, client as never, ip);

    await logDataAccessEvent(
      {
        actorId: studentId,
        subjectUserId: studentId,
        eventType: 'connection.revoked',
        eventPayload: { professionalId, professionalRole },
        ip,
      },
      client as never
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listIncomingRequests(
  professionalId: number,
  status: RequestStatus = 'pending'
): Promise<Array<ProfessionalRequest & { studentName: string; studentEmail: string }>> {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS student_name, u.email AS student_email
     FROM student_professional_requests r
     JOIN users u ON u.id = r.student_id
     WHERE r.professional_id = $1 AND r.status = $2
     ORDER BY r.created_at DESC`,
    [professionalId, status]
  );
  return rows.map((r) => ({
    ...mapRow(r),
    studentName: r.student_name,
    studentEmail: r.student_email,
  }));
}

export async function listOutgoingRequests(
  studentId: number
): Promise<Array<ProfessionalRequest & { professionalName: string }>> {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS professional_name
     FROM student_professional_requests r
     JOIN users u ON u.id = r.professional_id
     WHERE r.student_id = $1
     ORDER BY r.created_at DESC`,
    [studentId]
  );
  return rows.map((r) => ({
    ...mapRow(r),
    professionalName: r.professional_name,
  }));
}

export async function expireStaleRequests(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE student_professional_requests
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
  return rowCount ?? 0;
}

export async function resolveProfessionalByIdentifier(
  identifier: string,
  role: ProfessionalRole
): Promise<{ id: number; name: string; professionalCode: string | null } | null> {
  const dbRole = role === 'personal' ? 'personal' : 'nutri';
  // Normaliza email para lowercase (índice de email é case-sensitive em algumas instâncias)
  const normalizedIdentifier = identifier.includes('@') ? identifier.toLowerCase() : identifier;
  const { rows } = await pool.query(
    `SELECT id, name, professional_code FROM users
     WHERE (LOWER(email) = $1 OR professional_code = $1)
       AND role = $2
     LIMIT 1`,
    [normalizedIdentifier, dbRole]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, name: rows[0].name, professionalCode: rows[0].professional_code };
}

function mapRow(r: Record<string, unknown>): ProfessionalRequest {
  return {
    id: r.id as string,
    studentId: r.student_id as number,
    professionalId: r.professional_id as number,
    professionalRole: r.professional_role as ProfessionalRole,
    requestedVia: r.requested_via as RequestedVia,
    message: r.message as string | null,
    status: r.status as RequestStatus,
    requestedScopes: (r.requested_scopes as ConsentScope[]) ?? [],
    expiresAt: r.expires_at as string,
    respondedAt: r.responded_at as string | null,
    rejectionReason: r.rejection_reason as string | null,
    createdAt: r.created_at as string,
  };
}
