import pool from '../config/database';
import { auditLog } from '../utils/auditLog';
import type { StudentStatus } from './academyStudentService';
import { getGamificationSummary } from './gamificationService';
import { receptionStreamEmit } from './receptionStream';

export type AccessEventType = 'checkin' | 'exception' | 'denied' | 'visitor';
export type AccessEventSource = 'manual' | 'qr' | 'facial' | 'catraca_vendor_webhook';

export interface ReceptionStudentSearchRow {
  userId: number;
  name: string;
  email: string;
  phone: string | null;
  cpf: string | null;
  avatarUrl: string | null;
  studentStatus: StudentStatus | null;
  activePlan: { id: number; name: string; monthlyPrice: number } | null;
  lastAccessAt: string | null;
  daysOverdue: number | null;
  // Privacidade (beta academia): só metadado da interação — NUNCA o conteúdo do
  // chat. A recepção sabe que houve recado de quem/quando, sem ler a mensagem.
  lastStaffNote: { from: string; sentAt: string } | null;
}

export interface ReceptionAccessEvent {
  id: number;
  eventType: AccessEventType;
  source: AccessEventSource;
  reason: string | null;
  createdAt: string;
  student: {
    userId: number | null;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    studentStatus: StudentStatus | null;
  };
  visitor: {
    id: number | null;
    name: string | null;
    type: string | null;
  };
  actorName: string | null;
}

export interface ReceptionDashboardStudent {
  userId: number;
  name: string;
  email: string;
  phone: string | null;
  birthDate: string | null;
  studentStatus: StudentStatus | null;
  joinedAt: string | null;
  activePlan: { id: number; name: string; monthlyPrice: number } | null;
  lastAccessAt: string | null;
}

function normalizeSearchTerm(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function mapStudent(row: any): ReceptionStudentSearchRow {
  return {
    userId: row.user_id,
    name: row.name ?? '',
    email: row.email ?? '',
    phone: row.phone ?? null,
    cpf: row.cpf ?? null,
    avatarUrl: row.avatar_url ?? null,
    studentStatus: row.student_status ?? null,
    activePlan: row.plan_id
      ? {
          id: Number(row.plan_id),
          name: row.plan_name,
          monthlyPrice: Number(row.monthly_price ?? 0),
        }
      : null,
    lastAccessAt: row.last_access_at ? new Date(row.last_access_at).toISOString() : null,
    daysOverdue: row.days_overdue != null ? Number(row.days_overdue) : null,
    lastStaffNote: row.staff_note_at
      ? {
          from: row.staff_note_from ?? 'Equipe',
          sentAt: new Date(row.staff_note_at).toISOString(),
        }
      : null,
  };
}

function mapEvent(row: any): ReceptionAccessEvent {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    source: row.source,
    reason: row.reason ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    student: {
      userId: row.user_id != null ? Number(row.user_id) : null,
      name: row.student_name ?? null,
      email: row.student_email ?? null,
      avatarUrl: row.avatar_url ?? null,
      studentStatus: row.student_status ?? null,
    },
    visitor: {
      id: row.visitor_id != null ? Number(row.visitor_id) : null,
      name: row.visitor_name ?? null,
      type: row.visitor_type ?? null,
    },
    actorName: row.actor_name ?? null,
  };
}

function mapDashboardStudent(row: any): ReceptionDashboardStudent {
  return {
    userId: Number(row.user_id),
    name: row.name ?? '',
    email: row.email ?? '',
    phone: row.phone ?? null,
    birthDate: row.birth_date ? new Date(row.birth_date).toISOString() : null,
    studentStatus: row.student_status ?? null,
    joinedAt: row.joined_at ? new Date(row.joined_at).toISOString() : null,
    activePlan: row.plan_id
      ? {
          id: Number(row.plan_id),
          name: row.plan_name,
          monthlyPrice: Number(row.monthly_price ?? 0),
        }
      : null,
    lastAccessAt: row.last_access_at ? new Date(row.last_access_at).toISOString() : null,
  };
}

async function getStudentForAccess(academyId: number, userId: number): Promise<ReceptionStudentSearchRow> {
  const result = await pool.query(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.phone,
       u.cpf,
       u.avatar_url,
       au.student_status,
       e.plan_id,
       e.plan_name,
       e.monthly_price,
       last_event.last_access_at,
       CASE
         WHEN au.student_status = 'overdue' THEN GREATEST(
           1,
           LEAST(9999, FLOOR(EXTRACT(EPOCH FROM (NOW() - au.updated_at)) / 86400))::int
         )
         ELSE NULL
       END AS days_overdue,
       sn.staff_note_at,
       sn.staff_note_from
     FROM academy_users au
     JOIN users u ON u.id = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     LEFT JOIN LATERAL (
       SELECT ae.plan_id, ap.name AS plan_name, ap.monthly_price
       FROM academy_enrollments ae
       LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
       WHERE ae.academy_id = au.academy_id
         AND ae.user_id = au.user_id
         AND ae.status = 'active'
       ORDER BY ae.created_at DESC
       LIMIT 1
     ) e ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_access_at
       FROM academy_access_events aae
       WHERE aae.academy_id = au.academy_id
         AND aae.user_id = au.user_id
         AND aae.event_type IN ('checkin','exception')
     ) last_event ON TRUE
     LEFT JOIN LATERAL (
       SELECT cm.created_at AS staff_note_at, usr.name AS staff_note_from
       FROM chat_conversations cc
       JOIN chat_messages cm ON cm.conversation_id = cc.id
       JOIN users usr ON usr.id = cm.sender_id
       WHERE cc.student_id = u.id
         AND cc.academy_id = au.academy_id
         AND cm.sender_role IN ('personal', 'admin')
       ORDER BY cm.created_at DESC
       LIMIT 1
     ) sn ON TRUE
     WHERE au.academy_id = $1
       AND au.user_id = $2
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
     LIMIT 1`,
    [academyId, userId]
  );

  if (result.rows.length === 0) throw new Error('Aluno não encontrado nesta academia.');
  return mapStudent(result.rows[0]);
}

export async function searchReceptionStudents(
  academyId: number,
  q: string,
  limit = 8
): Promise<ReceptionStudentSearchRow[]> {
  const term = normalizeSearchTerm(q);
  if (term.length < 2) return [];

  const digits = onlyDigits(term);
  const like = `%${term}%`;
  const digitLike = digits ? `%${digits}%` : null;

  const result = await pool.query(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.phone,
       u.cpf,
       u.avatar_url,
       au.student_status,
       e.plan_id,
       e.plan_name,
       e.monthly_price,
       last_event.last_access_at,
       CASE
         WHEN au.student_status = 'overdue' THEN GREATEST(
           1,
           LEAST(9999, FLOOR(EXTRACT(EPOCH FROM (NOW() - au.updated_at)) / 86400))::int
         )
         ELSE NULL
       END AS days_overdue,
       sn.staff_note_at,
       sn.staff_note_from
     FROM academy_users au
     JOIN users u ON u.id = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     LEFT JOIN LATERAL (
       SELECT ae.plan_id, ap.name AS plan_name, ap.monthly_price
       FROM academy_enrollments ae
       LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
       WHERE ae.academy_id = au.academy_id
         AND ae.user_id = au.user_id
         AND ae.status = 'active'
       ORDER BY ae.created_at DESC
       LIMIT 1
     ) e ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_access_at
       FROM academy_access_events aae
       WHERE aae.academy_id = au.academy_id
         AND aae.user_id = au.user_id
         AND aae.event_type IN ('checkin','exception')
     ) last_event ON TRUE
     LEFT JOIN LATERAL (
       SELECT cm.created_at AS staff_note_at, usr.name AS staff_note_from
       FROM chat_conversations cc
       JOIN chat_messages cm ON cm.conversation_id = cc.id
       JOIN users usr ON usr.id = cm.sender_id
       WHERE cc.student_id = u.id
         AND cc.academy_id = au.academy_id
         AND cm.sender_role IN ('personal', 'admin')
       ORDER BY cm.created_at DESC
       LIMIT 1
     ) sn ON TRUE
     WHERE au.academy_id = $1
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
       AND (
         u.name ILIKE $2
         OR u.email ILIKE $2
         OR COALESCE(u.phone, '') ILIKE $2
         OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(u.cpf, ''), '\\D', '', 'g') ILIKE $3)
         OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') ILIKE $3)
       )
     ORDER BY
       CASE
         WHEN lower(u.email) = lower($4) THEN 0
         WHEN lower(u.name) = lower($4) THEN 1
         ELSE 2
       END,
       u.name
     LIMIT $5`,
    [academyId, like, digitLike, term, Math.min(Math.max(limit, 1), 20)]
  );

  return result.rows.map(mapStudent);
}

async function listAccessEvents(academyId: number, limit = 12): Promise<ReceptionAccessEvent[]> {
  const result = await pool.query(
    `SELECT
       aae.id,
       aae.event_type,
       aae.source,
       aae.reason,
       aae.created_at,
       u.id AS user_id,
       u.name AS student_name,
       u.email AS student_email,
       u.avatar_url,
       au.student_status,
       av.id AS visitor_id,
       av.name AS visitor_name,
       av.visitor_type,
       actor.name AS actor_name
     FROM academy_access_events aae
     LEFT JOIN users u ON u.id = aae.user_id
     LEFT JOIN academy_users au ON au.academy_id = aae.academy_id AND au.user_id = aae.user_id
     LEFT JOIN academy_visitors av ON av.id = aae.visitor_id AND av.academy_id = aae.academy_id
     LEFT JOIN users actor ON actor.id = aae.performed_by
     WHERE aae.academy_id = $1
     ORDER BY aae.created_at DESC
     LIMIT $2`,
    [academyId, Math.min(Math.max(limit, 1), 50)]
  );

  return result.rows.map(mapEvent);
}

async function listDashboardEvents(
  academyId: number,
  filter: 'occupancy_now' | 'access_today' | 'exceptions_today' | 'denied_today',
  limit = 50
): Promise<ReceptionAccessEvent[]> {
  const filters = {
    occupancy_now: "aae.created_at >= NOW() - INTERVAL '90 minutes' AND aae.event_type IN ('checkin','exception','visitor')",
    access_today: 'aae.created_at::date = CURRENT_DATE',
    exceptions_today: "aae.created_at::date = CURRENT_DATE AND aae.event_type = 'exception'",
    denied_today: "aae.created_at::date = CURRENT_DATE AND aae.event_type = 'denied'",
  } as const;

  const result = await pool.query(
    `SELECT
       aae.id,
       aae.event_type,
       aae.source,
       aae.reason,
       aae.created_at,
       u.id AS user_id,
       u.name AS student_name,
       u.email AS student_email,
       u.avatar_url,
       au.student_status,
       av.id AS visitor_id,
       av.name AS visitor_name,
       av.visitor_type,
       actor.name AS actor_name
     FROM academy_access_events aae
     LEFT JOIN users u ON u.id = aae.user_id
     LEFT JOIN academy_users au ON au.academy_id = aae.academy_id AND au.user_id = aae.user_id
     LEFT JOIN academy_visitors av ON av.id = aae.visitor_id AND av.academy_id = aae.academy_id
     LEFT JOIN users actor ON actor.id = aae.performed_by
     WHERE aae.academy_id = $1
       AND ${filters[filter]}
     ORDER BY aae.created_at DESC
     LIMIT $2`,
    [academyId, Math.min(Math.max(limit, 1), 100)]
  );

  return result.rows.map(mapEvent);
}

async function listDashboardStudents(
  academyId: number,
  filter: 'overdue' | 'new_7d' | 'birthdays_today',
  limit = 50
): Promise<ReceptionDashboardStudent[]> {
  const filters = {
    overdue: "au.student_status = 'overdue'",
    new_7d: "au.joined_at >= NOW() - INTERVAL '7 days'",
    birthdays_today: `u.birth_date IS NOT NULL
      AND EXTRACT(MONTH FROM u.birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
      AND EXTRACT(DAY FROM u.birth_date) = EXTRACT(DAY FROM CURRENT_DATE)`,
  } as const;

  const result = await pool.query(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.phone,
       u.birth_date,
       au.student_status,
       au.joined_at,
       e.plan_id,
       e.plan_name,
       e.monthly_price,
       last_event.last_access_at
     FROM academy_users au
     JOIN users u ON u.id = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     LEFT JOIN LATERAL (
       SELECT ae.plan_id, ap.name AS plan_name, ap.monthly_price
       FROM academy_enrollments ae
       LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
       WHERE ae.academy_id = au.academy_id
         AND ae.user_id = au.user_id
         AND ae.status = 'active'
       ORDER BY ae.created_at DESC
       LIMIT 1
     ) e ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_access_at
       FROM academy_access_events aae
       WHERE aae.academy_id = au.academy_id
         AND aae.user_id = au.user_id
         AND aae.event_type IN ('checkin','exception')
     ) last_event ON TRUE
     WHERE au.academy_id = $1
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
       AND ${filters[filter]}
     ORDER BY au.joined_at DESC NULLS LAST, u.name
     LIMIT $2`,
    [academyId, Math.min(Math.max(limit, 1), 100)]
  );

  return result.rows.map(mapDashboardStudent);
}

export async function getReceptionDashboard(academyId: number) {
  const [
    accessRes,
    studentsRes,
    birthdayRes,
    recentEvents,
    exceptionEvents,
    occupancyNowEvents,
    accessTodayEvents,
    exceptionsTodayEvents,
    deniedTodayEvents,
    overdueStudentsList,
    newStudents7dList,
    birthdaysTodayList,
  ] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS access_today,
         COUNT(*) FILTER (
           WHERE created_at >= NOW() - INTERVAL '90 minutes'
             AND event_type IN ('checkin','exception','visitor')
         ) AS occupancy_now,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE AND event_type = 'exception') AS exceptions_today,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE AND event_type = 'denied') AS denied_today
       FROM academy_access_events
       WHERE academy_id = $1`,
      [academyId]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE au.student_status = 'active') AS active_students,
         COUNT(*) FILTER (WHERE au.student_status = 'overdue') AS overdue_students,
         COUNT(*) FILTER (WHERE au.joined_at >= NOW() - INTERVAL '7 days') AS new_students_7d
       FROM academy_users au
       JOIN users u ON u.id = au.user_id
       JOIN academy_roles ar ON ar.id = au.role_id
       WHERE au.academy_id = $1
         AND au.is_active = TRUE
         AND au.status = 'active'
         AND ar.slug = 'academy_student'`,
      [academyId]
    ),
    pool.query(
      `SELECT COUNT(*) AS birthdays_today
       FROM academy_users au
       JOIN users u ON u.id = au.user_id
       JOIN academy_roles ar ON ar.id = au.role_id
       WHERE au.academy_id = $1
         AND au.is_active = TRUE
         AND au.status = 'active'
         AND ar.slug = 'academy_student'
         AND u.birth_date IS NOT NULL
         AND EXTRACT(MONTH FROM u.birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
         AND EXTRACT(DAY FROM u.birth_date) = EXTRACT(DAY FROM CURRENT_DATE)`,
      [academyId]
    ),
    listAccessEvents(academyId, 10),
    pool.query(
      `SELECT
         aae.id,
         aae.event_type,
         aae.source,
         aae.reason,
         aae.created_at,
         u.id AS user_id,
         u.name AS student_name,
         u.email AS student_email,
         u.avatar_url,
         au.student_status,
         av.id AS visitor_id,
         av.name AS visitor_name,
         av.visitor_type,
         actor.name AS actor_name
       FROM academy_access_events aae
       LEFT JOIN users u ON u.id = aae.user_id
       LEFT JOIN academy_users au ON au.academy_id = aae.academy_id AND au.user_id = aae.user_id
       LEFT JOIN academy_visitors av ON av.id = aae.visitor_id AND av.academy_id = aae.academy_id
       LEFT JOIN users actor ON actor.id = aae.performed_by
       WHERE aae.academy_id = $1
         AND aae.event_type IN ('exception','denied')
         AND aae.created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY aae.created_at DESC
       LIMIT 8`,
      [academyId]
    ),
    listDashboardEvents(academyId, 'occupancy_now'),
    listDashboardEvents(academyId, 'access_today'),
    listDashboardEvents(academyId, 'exceptions_today'),
    listDashboardEvents(academyId, 'denied_today'),
    listDashboardStudents(academyId, 'overdue'),
    listDashboardStudents(academyId, 'new_7d'),
    listDashboardStudents(academyId, 'birthdays_today'),
  ]);

  const access = accessRes.rows[0] ?? {};
  const students = studentsRes.rows[0] ?? {};
  const birthdays = birthdayRes.rows[0] ?? {};

  return {
    kpis: {
      occupancyNow: Number(access.occupancy_now ?? 0),
      accessToday: Number(access.access_today ?? 0),
      exceptionsToday: Number(access.exceptions_today ?? 0),
      deniedToday: Number(access.denied_today ?? 0),
      overdueStudents: Number(students.overdue_students ?? 0),
      newStudents7d: Number(students.new_students_7d ?? 0),
      activeStudents: Number(students.active_students ?? 0),
      birthdaysToday: Number(birthdays.birthdays_today ?? 0),
    },
    status: {
      catraca: 'manual_only' as const,
      facial: 'planned' as const,
      partners: 'planned' as const,
    },
    recentEvents,
    exceptions: exceptionEvents.rows.map(mapEvent),
    related: {
      occupancyNow: occupancyNowEvents,
      accessToday: accessTodayEvents,
      exceptionsToday: exceptionsTodayEvents,
      deniedToday: deniedTodayEvents,
      overdueStudents: overdueStudentsList,
      newStudents7d: newStudents7dList,
      birthdaysToday: birthdaysTodayList,
    },
  };
}

export async function registerStudentAccess(params: {
  academyId: number;
  actorUserId: number;
  userId: number;
  eventType?: AccessEventType;
  source?: AccessEventSource;
  reason?: string;
  ipAddress?: string;
}) {
  const student = await getStudentForAccess(params.academyId, params.userId);
  const eventType = params.eventType ?? 'checkin';
  const source = params.source ?? 'manual';
  const reason = params.reason?.trim() || null;

  if ((eventType === 'exception' || eventType === 'denied') && !reason) {
    throw new Error('Motivo obrigatório para exceção ou bloqueio.');
  }

  const dup = await pool.query<{ id: number; event_type: string; source: string; reason: string | null; created_at: Date }>(
    `SELECT id, event_type, source, reason, created_at
     FROM academy_access_events
     WHERE academy_id = $1
       AND user_id = $2
       AND event_type = $3
       AND created_at > NOW() - INTERVAL '60 seconds'
     ORDER BY created_at DESC
     LIMIT 1`,
    [params.academyId, params.userId, eventType]
  );
  if (dup.rows.length > 0) {
    const row = dup.rows[0];
    return {
      duplicate: true as const,
      event: {
        id: Number(row.id),
        eventType: row.event_type as AccessEventType,
        source: row.source as AccessEventSource,
        reason: row.reason ?? null,
        createdAt: new Date(row.created_at).toISOString(),
      },
      student,
    };
  }

  const result = await pool.query(
    `INSERT INTO academy_access_events
       (academy_id, user_id, event_type, source, reason, performed_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, event_type, source, reason, created_at`,
    [params.academyId, params.userId, eventType, source, reason, params.actorUserId]
  );

  await auditLog(pool, {
    academyId: params.academyId,
    userId: params.actorUserId,
    action: eventType === 'checkin' ? 'reception.checkin' : `reception.${eventType}`,
    entityType: 'user',
    entityId: params.userId,
    meta: { source, reason },
    ipAddress: params.ipAddress,
  });

  const eventRow = result.rows[0];
  const payload = {
    duplicate: false as const,
    event: {
      id: Number(eventRow.id),
      eventType: eventRow.event_type,
      source: eventRow.source,
      reason: eventRow.reason ?? null,
      createdAt: new Date(eventRow.created_at).toISOString(),
    },
    student,
  };
  receptionStreamEmit(params.academyId, { type: 'access', event: payload.event, userId: params.userId });
  return payload;
}

export async function createVisitorAccess(params: {
  academyId: number;
  actorUserId: number;
  name: string;
  document?: string;
  visitorType?: 'visitor' | 'external_personal' | 'prospect' | 'trial_class';
  phone?: string;
  referredBy?: string;
  validUntil?: string;
  reason?: string;
  ipAddress?: string;
}) {
  const name = params.name.trim();
  if (name.length < 2) throw new Error('Nome do visitante é obrigatório.');

  const dup = await pool.query<{ visitor_id: number; event_id: number; created_at: Date }>(
    `SELECT av.id AS visitor_id, aae.id AS event_id, aae.created_at
     FROM academy_visitors av
     JOIN academy_access_events aae
       ON aae.visitor_id = av.id AND aae.academy_id = av.academy_id AND aae.event_type = 'visitor'
     WHERE av.academy_id = $1
       AND lower(trim(av.name)) = lower(trim($2))
       AND aae.created_at > NOW() - INTERVAL '60 seconds'
     ORDER BY aae.created_at DESC
     LIMIT 1`,
    [params.academyId, name]
  );
  if (dup.rows.length > 0) {
    const row = dup.rows[0];
    const visitorRes = await pool.query(
      `SELECT id, name, document, visitor_type, valid_until, created_at, phone, referred_by
       FROM academy_visitors WHERE id = $1`,
      [row.visitor_id]
    );
    const eventRes = await pool.query(
      `SELECT id, event_type, source, reason, created_at FROM academy_access_events WHERE id = $1`,
      [row.event_id]
    );
    const visitor = visitorRes.rows[0];
    const event = eventRes.rows[0];
    return {
      duplicate: true as const,
      visitor: {
        id: Number(visitor.id),
        name: visitor.name,
        document: visitor.document ?? null,
        visitorType: visitor.visitor_type,
        validUntil: visitor.valid_until ? new Date(visitor.valid_until).toISOString() : null,
        createdAt: new Date(visitor.created_at).toISOString(),
      },
      event: {
        id: Number(event.id),
        eventType: event.event_type,
        source: event.source,
        reason: event.reason ?? null,
        createdAt: new Date(event.created_at).toISOString(),
      },
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const visitorRes = await client.query(
      `INSERT INTO academy_visitors
         (academy_id, name, document, visitor_type, phone, referred_by, valid_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       RETURNING id, name, document, visitor_type, valid_until, created_at, phone, referred_by`,
      [
        params.academyId,
        name,
        params.document?.trim() || null,
        params.visitorType ?? 'visitor',
        params.phone?.trim() || null,
        params.referredBy?.trim() || null,
        params.validUntil ?? null,
        params.actorUserId,
      ]
    );

    const visitor = visitorRes.rows[0];
    const eventRes = await client.query(
      `INSERT INTO academy_access_events
         (academy_id, visitor_id, event_type, source, reason, performed_by)
       VALUES ($1, $2, 'visitor', 'manual', $3, $4)
       RETURNING id, event_type, source, reason, created_at`,
      [params.academyId, visitor.id, params.reason?.trim() || null, params.actorUserId]
    );

    await auditLog(client, {
      academyId: params.academyId,
      userId: params.actorUserId,
      action: 'reception.visitor_access',
      entityType: 'academy_visitor',
      entityId: visitor.id,
      meta: { visitorType: visitor.visitor_type, reason: params.reason ?? null },
      ipAddress: params.ipAddress,
    });

    await client.query('COMMIT');

    const event = eventRes.rows[0];
    const out = {
      duplicate: false as const,
      visitor: {
        id: Number(visitor.id),
        name: visitor.name,
        document: visitor.document ?? null,
        visitorType: visitor.visitor_type,
        validUntil: visitor.valid_until ? new Date(visitor.valid_until).toISOString() : null,
        createdAt: new Date(visitor.created_at).toISOString(),
      },
      event: {
        id: Number(event.id),
        eventType: event.event_type,
        source: event.source,
        reason: event.reason ?? null,
        createdAt: new Date(event.created_at).toISOString(),
      },
    };
    receptionStreamEmit(params.academyId, { type: 'access', event: out.event, visitorId: visitor.id });
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type ReceptionPanelApiKey =
  | 'occupancyNow'
  | 'accessToday'
  | 'overdueStudents'
  | 'birthdaysToday'
  | 'exceptionsToday'
  | 'deniedToday'
  | 'newStudents7d';

export async function getReceptionPanel(
  academyId: number,
  key: ReceptionPanelApiKey,
  page: number,
  pageSize: number,
  search?: string
): Promise<{ total: number; events: ReceptionAccessEvent[]; students: ReceptionDashboardStudent[] }> {
  const lim = Math.min(Math.max(pageSize, 1), 50);
  const off = Math.max(page - 1, 0) * lim;
  const q = search?.trim();
  const like = q && q.length >= 1 ? `%${q.replace(/%/g, '').replace(/_/g, '')}%` : null;

  if (
    key === 'occupancyNow' ||
    key === 'accessToday' ||
    key === 'exceptionsToday' ||
    key === 'deniedToday'
  ) {
    const filter =
      key === 'occupancyNow'
        ? "aae.created_at >= NOW() - INTERVAL '90 minutes' AND aae.event_type IN ('checkin','exception','visitor')"
        : key === 'accessToday'
          ? 'aae.created_at::date = CURRENT_DATE'
          : key === 'exceptionsToday'
            ? "aae.created_at::date = CURRENT_DATE AND aae.event_type = 'exception'"
            : "aae.created_at::date = CURRENT_DATE AND aae.event_type = 'denied'";
    const countRes = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM academy_access_events aae
       WHERE aae.academy_id = $1 AND ${filter}`,
      [academyId]
    );
    const total = Number(countRes.rows[0]?.c ?? 0);
    const params: unknown[] = [academyId];
    let extra = '';
    if (like) {
      params.push(like);
      extra = ` AND (
        COALESCE(u.name, '') ILIKE $${params.length}
        OR COALESCE(u.email, '') ILIKE $${params.length}
        OR COALESCE(av.name, '') ILIKE $${params.length}
        OR COALESCE(aae.reason, '') ILIKE $${params.length}
      )`;
    }
    params.push(lim, off);
    const limI = params.length - 1;
    const offI = params.length;
    const listRes = await pool.query(
      `SELECT
         aae.id,
         aae.event_type,
         aae.source,
         aae.reason,
         aae.created_at,
         u.id AS user_id,
         u.name AS student_name,
         u.email AS student_email,
         u.avatar_url,
         au.student_status,
         av.id AS visitor_id,
         av.name AS visitor_name,
         av.visitor_type,
         actor.name AS actor_name
       FROM academy_access_events aae
       LEFT JOIN users u ON u.id = aae.user_id
       LEFT JOIN academy_users au ON au.academy_id = aae.academy_id AND au.user_id = aae.user_id
       LEFT JOIN academy_visitors av ON av.id = aae.visitor_id AND av.academy_id = aae.academy_id
       LEFT JOIN users actor ON actor.id = aae.performed_by
       WHERE aae.academy_id = $1 AND ${filter}${extra}
       ORDER BY aae.created_at DESC
       LIMIT $${limI} OFFSET $${offI}`,
      params
    );
    return { total, events: listRes.rows.map(mapEvent), students: [] };
  }

  const studentFilter =
    key === 'overdueStudents'
      ? "au.student_status = 'overdue'"
      : key === 'newStudents7d'
        ? "au.joined_at >= NOW() - INTERVAL '7 days'"
        : `u.birth_date IS NOT NULL
      AND EXTRACT(MONTH FROM u.birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
      AND EXTRACT(DAY FROM u.birth_date) = EXTRACT(DAY FROM CURRENT_DATE)`;

  const countParams: unknown[] = [academyId];
  let countExtra = '';
  if (like) {
    countParams.push(like);
    countExtra = ` AND (u.name ILIKE $${countParams.length} OR u.email ILIKE $${countParams.length})`;
  }
  const countRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM academy_users au
     JOIN users u ON u.id = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.academy_id = $1
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
       AND ${studentFilter}${countExtra}`,
    countParams
  );
  const total = Number(countRes.rows[0]?.c ?? 0);

  const listParams: unknown[] = [academyId];
  let listExtra = '';
  if (like) {
    listParams.push(like);
    listExtra = ` AND (u.name ILIKE $${listParams.length} OR u.email ILIKE $${listParams.length})`;
  }
  listParams.push(lim, off);
  const lI = listParams.length - 1;
  const oI = listParams.length;
  const listRes = await pool.query(
    `SELECT
       u.id AS user_id,
       u.name,
       u.email,
       u.phone,
       u.birth_date,
       au.student_status,
       au.joined_at,
       e.plan_id,
       e.plan_name,
       e.monthly_price,
       last_event.last_access_at
     FROM academy_users au
     JOIN users u ON u.id = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     LEFT JOIN LATERAL (
       SELECT ae.plan_id, ap.name AS plan_name, ap.monthly_price
       FROM academy_enrollments ae
       LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
       WHERE ae.academy_id = au.academy_id
         AND ae.user_id = au.user_id
         AND ae.status = 'active'
       ORDER BY ae.created_at DESC
       LIMIT 1
     ) e ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_access_at
       FROM academy_access_events aae
       WHERE aae.academy_id = au.academy_id
         AND aae.user_id = au.user_id
         AND aae.event_type IN ('checkin','exception')
     ) last_event ON TRUE
     WHERE au.academy_id = $1
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
       AND ${studentFilter}${listExtra}
     ORDER BY au.joined_at DESC NULLS LAST, u.name
     LIMIT $${lI} OFFSET $${oI}`,
    listParams
  );
  return { total, events: [], students: listRes.rows.map(mapDashboardStudent) };
}

export interface ReceptionStudentContextDto {
  adherence7dPct: number;
  streakDays: number;
  lastWorkoutAt: string | null;
  productMaaSActive: boolean;
  unreadStaffMessageCount: number;
  welcomeContext: string | null;
  staffMessages: Array<{
    id: number;
    text: string;
    fromName: string;
    senderRole: string;
    createdAt: string;
  }>;
}

export async function getReceptionStudentContext(
  academyId: number,
  studentUserId: number
): Promise<ReceptionStudentContextDto> {
  const ok = await pool.query(
    `SELECT 1
     FROM academy_users au
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.academy_id = $1
       AND au.user_id = $2
       AND au.is_active = TRUE
       AND au.status = 'active'
       AND ar.slug = 'academy_student'
     LIMIT 1`,
    [academyId, studentUserId]
  );
  if (ok.rows.length === 0) throw new Error('Aluno não encontrado nesta academia.');

  const [adRes, maasRes, msgListRes, unreadRes, lastAccessRes, weekCountRes, gs] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT date_key)::text AS n
       FROM user_daily_checkins
       WHERE user_id = $1 AND academy_id = $2 AND date_key >= (CURRENT_DATE - INTERVAL '6 days')::date`,
      [studentUserId, academyId]
    ),
    pool.query<{ x: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_product_memberships
         WHERE user_id = $1 AND product_key = 'metabolismo' AND status = 'active'
       ) AS x`,
      [studentUserId]
    ),
    pool.query<{ id: number; text: string; sender_role: string; from_name: string; created_at: Date }>(
      `SELECT cm.id, cm.text, cm.sender_role, usr.name AS from_name, cm.created_at
       FROM chat_conversations cc
       JOIN chat_messages cm ON cm.conversation_id = cc.id
       JOIN users usr ON usr.id = cm.sender_id
       WHERE cc.student_id = $1
         AND cc.academy_id = $2
         AND cm.sender_role IN ('personal', 'admin')
       ORDER BY cm.created_at DESC
       LIMIT 15`,
      [studentUserId, academyId]
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM chat_conversations cc
       JOIN chat_messages cm ON cm.conversation_id = cc.id
       WHERE cc.student_id = $1
         AND cc.academy_id = $2
         AND cm.sender_role IN ('personal', 'admin')
         AND cm.created_at > COALESCE(cc.last_read_at_by_student, to_timestamp(0))`,
      [studentUserId, academyId]
    ),
    pool.query<{ last_at: Date | null }>(
      `SELECT MAX(created_at) AS last_at
       FROM academy_access_events
       WHERE academy_id = $1 AND user_id = $2 AND event_type IN ('checkin','exception')`,
      [academyId, studentUserId]
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM academy_access_events
       WHERE academy_id = $1
         AND user_id = $2
         AND event_type IN ('checkin','exception')
         AND created_at >= date_trunc('week', NOW())`,
      [academyId, studentUserId]
    ),
    getGamificationSummary(studentUserId, false, academyId),
  ]);

  const distinctDays = Number(adRes.rows[0]?.n ?? 0);
  const adherence7dPct = Math.min(100, Math.round((distinctDays / 7) * 100));
  const productMaaSActive = !!maasRes.rows[0]?.x;
  const unreadStaffMessageCount = Number(unreadRes.rows[0]?.c ?? 0);
  const staffMessages = msgListRes.rows.map((r) => ({
    id: r.id,
    text: r.text,
    fromName: r.from_name ?? 'Equipe',
    senderRole: r.sender_role,
    createdAt: new Date(r.created_at).toISOString(),
  }));

  const streakDays = gs.streak;
  const lastWorkoutAt = gs.lastWorkout?.completedAt
    ? new Date(gs.lastWorkout.completedAt).toISOString()
    : null;

  const lastAt = lastAccessRes.rows[0]?.last_at;
  const daysSinceLastAccess = lastAt
    ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86400000)
    : null;
  const accessesThisWeek = Number(weekCountRes.rows[0]?.c ?? 0);

  let welcomeContext: string | null = null;
  if (streakDays >= 3) {
    welcomeContext = `${streakDays}º dia da streak`;
  } else if (daysSinceLastAccess != null && daysSinceLastAccess >= 7) {
    welcomeContext = `Volta após ${daysSinceLastAccess} dias`;
  } else if (accessesThisWeek === 1) {
    welcomeContext = 'Primeiro check-in da semana';
  }

  return {
    adherence7dPct,
    streakDays,
    lastWorkoutAt,
    productMaaSActive,
    unreadStaffMessageCount,
    welcomeContext,
    staffMessages,
  };
}

export async function logReceptionNotesViewed(params: {
  academyId: number;
  actorUserId: number;
  studentUserId: number;
  ipAddress?: string;
}): Promise<void> {
  await auditLog(pool, {
    academyId: params.academyId,
    userId: params.actorUserId,
    action: 'reception.notes_viewed',
    entityType: 'user',
    entityId: params.studentUserId,
    meta: {},
    ipAddress: params.ipAddress,
  });
}
