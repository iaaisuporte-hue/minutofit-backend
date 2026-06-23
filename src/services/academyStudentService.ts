import pool from '../config/database';
import crypto from 'crypto';
import { auditLog } from '../utils/auditLog';
import { grantMembership } from './membershipService';
import { findOrCreateUserFromContext } from './userIdentityService';
import logger from '../lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StudentStatus = 'lead' | 'active' | 'overdue' | 'paused' | 'cancelled';

export interface Student {
  userId: number;
  name: string;
  email: string;
  phone?: string;
  cpf?: string;
  birthDate?: string | null;
  avatarUrl?: string | null;
  studentStatus: StudentStatus | null;
  unitId?: number | null;
  isActive: boolean;
  joinedAt: string | null;
  paymentMethod?: string | null;
  mainGoal?: string | null;
  medicalRestrictions?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  acceptedTermsAt?: string | null;
  acceptedLgpdAt?: string | null;
  activePlan: { id: number; name: string; monthlyPrice: number; startDate: string } | null;
  hasUsedLab?: boolean;
  hasUsedTracker?: boolean;
  hasApp?: boolean;
  hasPersonal?: boolean;
  hasNutri?: boolean;
}

export interface Enrollment {
  id: number;
  academyId: number;
  userId: number;
  planId: number | null;
  planName?: string;
  monthlyPrice?: number;
  startDate: string;
  endDate: string | null;
  status: 'active' | 'paused' | 'cancelled';
  notes: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  userId: number | null;
  entityType: string | null;
  entityId: number | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface StudentsStats {
  active: number;
  leads: number;
  overdue: number;
  paused: number;
  cancelled: number;
  total: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  return crypto.randomBytes(6).toString('hex');
}

function mapStudent(row: any): Student {
  return {
    userId:               row.user_id,
    name:                 row.name ?? '',
    email:                row.email,
    phone:                row.phone ?? undefined,
    cpf:                  row.cpf ?? undefined,
    birthDate:            row.birth_date ? new Date(row.birth_date).toISOString().slice(0, 10) : null,
    avatarUrl:            row.avatar_url ?? null,
    studentStatus:        row.student_status ?? null,
    unitId:               row.academy_unit_id ?? null,
    isActive:             row.is_active,
    joinedAt:             row.joined_at ? new Date(row.joined_at).toISOString() : null,
    paymentMethod:        row.payment_method ?? null,
    mainGoal:             row.main_goal ?? null,
    medicalRestrictions:  row.medical_restrictions ?? null,
    emergencyContactName: row.emergency_contact_name ?? null,
    emergencyContactPhone:row.emergency_contact_phone ?? null,
    acceptedTermsAt:      row.accepted_terms_at ? new Date(row.accepted_terms_at).toISOString() : null,
    acceptedLgpdAt:       row.accepted_lgpd_at  ? new Date(row.accepted_lgpd_at).toISOString()  : null,
    activePlan:           row.plan_id
      ? {
          id:           row.plan_id,
          name:         row.plan_name,
          monthlyPrice: Number(row.monthly_price ?? 0),
          startDate:    row.enrollment_start ? new Date(row.enrollment_start).toISOString().slice(0, 10) : '',
        }
      : null,
    hasUsedLab:     Boolean(row.has_used_lab),
    hasUsedTracker: Boolean(row.has_used_tracker),
    hasApp:         Boolean(row.has_app),
    hasPersonal:    Boolean(row.has_personal),
    hasNutri:       Boolean(row.has_nutri),
  };
}

async function getOwnerRoleId(academyId: number): Promise<number | null> {
  const r = await pool.query(
    `SELECT id FROM academy_roles WHERE academy_id = $1 AND slug = 'academy_student' LIMIT 1`,
    [academyId]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

// ─── List + stats ─────────────────────────────────────────────────────────────

export async function listStudents(
  academyId: number,
  opts: {
    status?: string;
    q?: string;
    unitId?: number;
    page?: number;
    pageSize?: number;
    /** Alunos ativos sem check-in nos últimos 14 dias (alinhado ao card do dashboard) */
    atRisk?: boolean;
  }
): Promise<{ students: Student[]; total: number; stats: StudentsStats }> {
  const page     = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const offset   = (page - 1) * pageSize;

  const conditions: string[] = [
    `au.academy_id = $1`,
    `ar.slug = 'academy_student'`,
  ];
  const vals: unknown[] = [academyId];

  if (opts.status && !opts.atRisk) {
    vals.push(opts.status);
    conditions.push(`au.student_status = $${vals.length}`);
  }
  if (opts.atRisk) {
    conditions.push(`au.student_status = 'active'`);
    conditions.push(`
      NOT EXISTS (
        SELECT 1 FROM user_daily_checkins c
        WHERE c.user_id = u.id AND c.academy_id = au.academy_id
          AND c.created_at >= NOW() - INTERVAL '14 days'
      )
    `);
  }
  if (opts.unitId) {
    vals.push(opts.unitId);
    conditions.push(`au.academy_unit_id = $${vals.length}`);
  }
  if (opts.q) {
    const term = opts.q.trim();
    const digits = term.replace(/\D/g, '');
    vals.push(`%${term}%`);
    const textParam = vals.length;
    vals.push(digits ? `%${digits}%` : null);
    const digitParam = vals.length;
    conditions.push(`(
      u.name ILIKE $${textParam}
      OR u.email ILIKE $${textParam}
      OR COALESCE(u.phone, '') ILIKE $${textParam}
      OR ($${digitParam}::text IS NOT NULL AND regexp_replace(COALESCE(u.cpf, ''), '\\D', '', 'g') ILIKE $${digitParam})
      OR ($${digitParam}::text IS NOT NULL AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') ILIKE $${digitParam})
    )`);
  }

  const where = conditions.join(' AND ');

  const BASE_QUERY = `
    FROM academy_users au
    JOIN users         u  ON u.id  = au.user_id
    JOIN academy_roles ar ON ar.id = au.role_id
    LEFT JOIN LATERAL (
      SELECT ae.id AS enroll_id, ae.plan_id, ae.start_date AS enrollment_start,
             ap.name AS plan_name, ap.monthly_price
      FROM academy_enrollments ae
      LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
      WHERE ae.academy_id = au.academy_id AND ae.user_id = au.user_id AND ae.status = 'active'
      ORDER BY ae.created_at DESC LIMIT 1
    ) e ON TRUE
    WHERE ${where}
  `;

  const [dataRes, countRes, statsRes] = await Promise.all([
    pool.query(
      `SELECT
         u.id AS user_id, u.name, u.email, u.phone, u.cpf, u.birth_date, u.avatar_url,
         au.student_status, au.academy_unit_id, au.is_active, au.joined_at,
         au.payment_method, au.main_goal, au.medical_restrictions,
         au.emergency_contact_name, au.emergency_contact_phone,
         au.accepted_terms_at, au.accepted_lgpd_at,
         e.plan_id, e.plan_name, e.monthly_price, e.enrollment_start,
         EXISTS (
           SELECT 1 FROM movement_sessions ms
           WHERE ms.user_id = u.id
             AND (ms.academy_id IS NULL OR ms.academy_id = au.academy_id)
         ) AS has_used_lab,
         EXISTS (
           SELECT 1 FROM activity_sessions acs
           WHERE acs.user_id = u.id
             AND (acs.academy_id IS NULL OR acs.academy_id = au.academy_id)
         ) AS has_used_tracker,
         EXISTS (
           SELECT 1 FROM user_product_memberships upm
           WHERE upm.user_id = u.id AND upm.product_key = 'app' AND upm.status = 'active'
         ) AS has_app,
         EXISTS (
           SELECT 1 FROM user_product_memberships upm
           WHERE upm.user_id = u.id AND upm.product_key = 'personal' AND upm.status = 'active'
         ) AS has_personal,
         EXISTS (
           SELECT 1 FROM user_product_memberships upm
           WHERE upm.user_id = u.id AND upm.product_key = 'nutri' AND upm.status = 'active'
         ) AS has_nutri
       ${BASE_QUERY}
       ORDER BY u.name
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*) AS total ${BASE_QUERY}`, vals),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE au.student_status = 'active')   AS active,
         COUNT(*) FILTER (WHERE au.student_status = 'lead')     AS leads,
         COUNT(*) FILTER (WHERE au.student_status = 'overdue')  AS overdue,
         COUNT(*) FILTER (WHERE au.student_status = 'paused')   AS paused,
         COUNT(*) FILTER (WHERE au.student_status = 'cancelled') AS cancelled,
         COUNT(*) AS total
       FROM academy_users au
       JOIN academy_roles ar ON ar.id = au.role_id
       WHERE au.academy_id = $1 AND ar.slug = 'academy_student'`,
      [academyId]
    ),
  ]);

  const s = statsRes.rows[0];
  return {
    students: dataRes.rows.map(mapStudent),
    total: Number(countRes.rows[0].total),
    stats: {
      active:    Number(s.active),
      leads:     Number(s.leads),
      overdue:   Number(s.overdue),
      paused:    Number(s.paused),
      cancelled: Number(s.cancelled),
      total:     Number(s.total),
    },
  };
}

// ─── Get single student ───────────────────────────────────────────────────────

export async function getStudent(academyId: number, userId: number): Promise<Student & {
  enrollments: Enrollment[];
  auditHistory: AuditEntry[];
  activity: {
    lastWorkout: string | null;
    lastCheckin: string | null;
    workouts30d: number;
    checkins30d: number;
    adherence30dPct: number | null;
    adherence7dPct: number | null;
  };
  memberships: { hasApp: boolean; hasPersonal: boolean; hasNutri: boolean };
}> {
  const [studentRes, enrollRes, auditRes, activityRes, membershipsRes] = await Promise.all([
    pool.query(
      `SELECT
         u.id AS user_id, u.name, u.email, u.phone, u.cpf, u.birth_date, u.avatar_url,
         au.student_status, au.academy_unit_id, au.is_active, au.joined_at,
         au.payment_method, au.main_goal, au.medical_restrictions,
         au.emergency_contact_name, au.emergency_contact_phone,
         au.accepted_terms_at, au.accepted_lgpd_at,
         e.plan_id, e.plan_name, e.monthly_price, e.enrollment_start
       FROM academy_users au
       JOIN users         u  ON u.id  = au.user_id
       JOIN academy_roles ar ON ar.id = au.role_id
       LEFT JOIN LATERAL (
         SELECT ae.id AS enroll_id, ae.plan_id, ae.start_date AS enrollment_start,
                ap.name AS plan_name, ap.monthly_price
         FROM academy_enrollments ae
         LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
         WHERE ae.academy_id = au.academy_id AND ae.user_id = au.user_id AND ae.status = 'active'
         ORDER BY ae.created_at DESC LIMIT 1
       ) e ON TRUE
       WHERE au.academy_id = $1 AND au.user_id = $2 AND ar.slug = 'academy_student'`,
      [academyId, userId]
    ),
    pool.query(
      `SELECT
         ae.id, ae.academy_id, ae.user_id, ae.plan_id, ae.start_date, ae.end_date,
         ae.status, ae.notes, ae.created_at,
         ap.name AS plan_name, ap.monthly_price
       FROM academy_enrollments ae
       LEFT JOIN academy_plans ap ON ap.id = ae.plan_id
       WHERE ae.academy_id = $1 AND ae.user_id = $2
       ORDER BY ae.created_at DESC
       LIMIT 20`,
      [academyId, userId]
    ),
    pool.query(
      `SELECT id, action, user_id, entity_type, entity_id, meta, created_at
       FROM academy_audit_log
       WHERE academy_id = $1 AND entity_type = 'user' AND entity_id = $2
       ORDER BY created_at DESC LIMIT 20`,
      [academyId, userId]
    ),
    pool.query(
      `SELECT
         (SELECT MAX(completed_at) FROM user_workout_logs WHERE user_id = $1) AS last_workout,
         (SELECT MAX(created_at)   FROM user_daily_checkins WHERE user_id = $1) AS last_checkin,
         (SELECT COUNT(*)          FROM user_workout_logs
          WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '30 days') AS workouts_30d,
         (SELECT COUNT(*)          FROM user_daily_checkins
          WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days') AS checkins_30d,
         (SELECT COUNT(DISTINCT date_key) FROM user_daily_checkins
          WHERE user_id = $1 AND date_key >= (CURRENT_DATE - INTERVAL '6 days')::date) AS checkins_7d`,
      [userId]
    ),
    pool.query(
      `SELECT
         MAX(CASE WHEN product_key = 'app'      AND status = 'active' THEN 1 ELSE 0 END)::int AS has_app,
         MAX(CASE WHEN product_key = 'personal' AND status = 'active' THEN 1 ELSE 0 END)::int AS has_personal,
         MAX(CASE WHEN product_key = 'nutri'    AND status = 'active' THEN 1 ELSE 0 END)::int AS has_nutri
       FROM user_product_memberships
       WHERE user_id = $1`,
      [userId]
    ),
  ]);

  if (studentRes.rows.length === 0) throw new Error('Aluno não encontrado.');

  const student = mapStudent(studentRes.rows[0]);

  const enrollments: Enrollment[] = enrollRes.rows.map((r) => ({
    id:           r.id,
    academyId:    r.academy_id,
    userId:       r.user_id,
    planId:       r.plan_id ?? null,
    planName:     r.plan_name ?? undefined,
    monthlyPrice: r.monthly_price != null ? Number(r.monthly_price) : undefined,
    startDate:    new Date(r.start_date).toISOString().slice(0, 10),
    endDate:      r.end_date ? new Date(r.end_date).toISOString().slice(0, 10) : null,
    status:       r.status,
    notes:        r.notes ?? null,
    createdAt:    new Date(r.created_at).toISOString(),
  }));

  const auditHistory: AuditEntry[] = auditRes.rows.map((r) => ({
    id:         r.id,
    action:     r.action,
    userId:     r.user_id ?? null,
    entityType: r.entity_type ?? null,
    entityId:   r.entity_id ?? null,
    meta:       r.meta ?? null,
    createdAt:  new Date(r.created_at).toISOString(),
  }));

  const ar = activityRes.rows[0] ?? {};
  const workouts30d  = Number(ar.workouts_30d  ?? 0);
  const checkins30d  = Number(ar.checkins_30d  ?? 0);
  const checkins7d   = Number(ar.checkins_7d   ?? 0);
  const activity = {
    lastWorkout:     ar.last_workout ? new Date(ar.last_workout).toISOString() : null,
    lastCheckin:     ar.last_checkin ? new Date(ar.last_checkin).toISOString() : null,
    workouts30d,
    checkins30d,
    // Target: ~3 workouts/week = 12/month; capped at 100%
    adherence30dPct: workouts30d > 0 ? Math.min(Math.round((workouts30d / 12) * 100), 100) : null,
    adherence7dPct:  Math.min(100, Math.round((checkins7d / 7) * 100)),
  };

  const mr = membershipsRes.rows[0] ?? {};
  const memberships = {
    hasApp:      Boolean(Number(mr.has_app)),
    hasPersonal: Boolean(Number(mr.has_personal)),
    hasNutri:    Boolean(Number(mr.has_nutri)),
  };

  return { ...student, enrollments, auditHistory, activity, memberships };
}

// ─── Add student ──────────────────────────────────────────────────────────────

export async function addStudent(
  academyId: number,
  actorUserId: number,
  params: {
    mode: 'direct' | 'invite';
    name?: string;
    email: string;
    cpf?: string;
    phone?: string;
    birthDate?: string;
    avatarUrl?: string;
    unitId?: number;
    planId?: number;
    startDate?: string;
    paymentMethod?: string;
    mainGoal?: string;
    medicalRestrictions?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    acceptedTerms?: boolean;
    acceptedLgpd?: boolean;
    /**
     * Conceder o App como bônus ao criar/atualizar o aluno. Default `true`.
     * Quando a Academia cancelar o vínculo no futuro, o App entra em
     * `grace_period` automaticamente (ver `membershipService.cancelMembership`).
     */
    giveAppBonus?: boolean;
  }
): Promise<{ student: Partial<Student>; tempPassword?: string; inviteUrl?: string }> {
  const email = params.email.toLowerCase().trim();
  const studentRoleId = await getOwnerRoleId(academyId);
  if (!studentRoleId) throw new Error('Role academy_student não encontrado.');

  const giveAppBonus = params.giveAppBonus !== false; // default true

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (params.mode === 'invite') {
    const roleRes = await pool.query(
      `SELECT id FROM academy_roles WHERE academy_id = $1 AND slug = 'academy_student'`,
      [academyId]
    );
    if (roleRes.rows.length === 0) throw new Error('Role academy_student não encontrado.');

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO academy_invitations (academy_id, email, role_id, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [academyId, email, roleRes.rows[0].id, token, actorUserId, expiresAt]
    );
    await auditLog(pool, {
      academyId,
      userId: actorUserId,
      action: 'student.added',
      meta: { email, mode: 'invite' },
    });
    return { student: { email }, inviteUrl: `${frontendUrl}/invite/${token}` };
  }

  // Direct
  if (!params.name) throw new Error('name é obrigatório para cadastro direto.');

  // Identidade: a academia confirma identidade do aluno → permitir dedup amplo
  // (email > cpf > phone). Senha temporária gerada quando o usuário ainda não
  // existe; ignorada quando o aluno já tem conta no CoreFit.
  let tempPassword: string | undefined = generateTempPassword();
  const identity = await findOrCreateUserFromContext({
    email,
    name: String(params.name).trim(),
    cpf: params.cpf ?? null,
    phone: params.phone ?? null,
    password: tempPassword,
    skipPasswordPolicy: true,
  });

  if (!identity.isNew) {
    tempPassword = undefined; // user já existia — não devolver senha temporária
  }

  const userId = identity.user.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Campos demográficos não tocados pelo serviço de identidade.
    await client.query(
      `UPDATE users SET
         birth_date = COALESCE($2::date, birth_date),
         avatar_url = COALESCE($3, avatar_url)
       WHERE id = $1`,
      [userId, params.birthDate ?? null, params.avatarUrl ?? null]
    );

    // Determine initial status
    const hasEnrollment = !!params.planId;
    const initialStatus: StudentStatus = hasEnrollment ? 'active' : 'lead';

    const now = new Date();
    const acceptedTermsAt  = params.acceptedTerms ? now : null;
    const acceptedLgpdAt   = params.acceptedLgpd  ? now : null;

    // Upsert academy_users as student
    await client.query(
      `INSERT INTO academy_users (
         user_id, academy_id, role_id, status, is_active, joined_at,
         student_status, academy_unit_id,
         payment_method, main_goal, medical_restrictions,
         emergency_contact_name, emergency_contact_phone,
         accepted_terms_at, accepted_lgpd_at
       )
       VALUES ($1, $2, $3, 'active', TRUE, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, academy_id) DO UPDATE
         SET role_id                = EXCLUDED.role_id,
             status                 = 'active',
             is_active              = TRUE,
             joined_at              = COALESCE(academy_users.joined_at, NOW()),
             student_status         = $4,
             academy_unit_id        = COALESCE($5, academy_users.academy_unit_id),
             payment_method         = COALESCE($6, academy_users.payment_method),
             main_goal              = COALESCE($7, academy_users.main_goal),
             medical_restrictions   = COALESCE($8, academy_users.medical_restrictions),
             emergency_contact_name = COALESCE($9, academy_users.emergency_contact_name),
             emergency_contact_phone= COALESCE($10, academy_users.emergency_contact_phone),
             accepted_terms_at      = COALESCE($11, academy_users.accepted_terms_at),
             accepted_lgpd_at       = COALESCE($12, academy_users.accepted_lgpd_at),
             updated_at             = NOW()`,
      [
        userId, academyId, studentRoleId,
        initialStatus, params.unitId ?? null,
        params.paymentMethod ?? null, params.mainGoal ?? null, params.medicalRestrictions ?? null,
        params.emergencyContactName ?? null, params.emergencyContactPhone ?? null,
        acceptedTermsAt, acceptedLgpdAt,
      ]
    );

    // Create enrollment if plan provided
    if (params.planId) {
      const planCheck = await client.query(
        `SELECT id FROM academy_plans WHERE id = $1 AND academy_id = $2`,
        [params.planId, academyId]
      );
      if (planCheck.rows.length === 0) throw new Error('Plano não encontrado.');

      await client.query(
        `INSERT INTO academy_enrollments (academy_id, user_id, plan_id, start_date, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [academyId, userId, params.planId, params.startDate ?? new Date().toISOString().slice(0, 10)]
      );
    }

    await auditLog(client, {
      academyId,
      userId: actorUserId,
      action: 'student.added',
      entityType: 'user',
      entityId: userId,
      meta: { email, mode: 'direct', planId: params.planId },
    });

    await client.query('COMMIT');

    // Grant ACADEMIA membership outside transaction (idempotent, non-critical)
    await grantMembership(userId, 'academia', {
      source: 'academy_bootstrap',
      academyId,
      sourceAcademyId: academyId,
      metadata: { channel: 'academy_direct_add' },
    }).catch((err) => logger.error({ err, userId, academyId }, '[academy] grantMembership academia failed'));

    // Grant APP como bônus (default ligado). Se a Academia cancelar o aluno
    // depois, esse App cai em grace_period (30 dias) automaticamente.
    if (giveAppBonus) {
      await grantMembership(userId, 'app', {
        source: 'bonus_academy',
        sourceAcademyId: academyId,
        metadata: { channel: 'academy_direct_add_bonus' },
      }).catch((err) => logger.error({ err, userId, academyId }, '[academy] grantMembership app bonus failed'));
    }

    return {
      student: { userId, name: params.name, email, studentStatus: initialStatus },
      tempPassword,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Update student ───────────────────────────────────────────────────────────

export async function updateStudent(
  academyId: number,
  actorUserId: number,
  userId: number,
  params: { studentStatus?: StudentStatus; unitId?: number | null; notes?: string }
): Promise<void> {
  const updates: string[] = [];
  const vals: unknown[] = [];

  if (params.studentStatus !== undefined) {
    updates.push(`student_status = $${vals.length + 1}`);
    vals.push(params.studentStatus);
  }
  if (params.unitId !== undefined) {
    updates.push(`academy_unit_id = $${vals.length + 1}`);
    vals.push(params.unitId);
  }
  if (updates.length === 0) return;

  updates.push('updated_at = NOW()');
  vals.push(userId, academyId);

  const res = await pool.query(
    `UPDATE academy_users SET ${updates.join(', ')}
     WHERE user_id = $${vals.length - 1} AND academy_id = $${vals.length}
       AND role_id = (SELECT id FROM academy_roles WHERE academy_id = $${vals.length} AND slug = 'academy_student')
     RETURNING user_id`,
    vals
  );
  if (res.rows.length === 0) throw new Error('Aluno não encontrado.');

  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'student.status_changed',
    entityType: 'user',
    entityId: userId,
    meta: params as Record<string, unknown>,
  });
}

// ─── Enroll ───────────────────────────────────────────────────────────────────

export async function enrollStudent(
  academyId: number,
  actorUserId: number,
  userId: number,
  params: { planId: number; startDate?: string; notes?: string }
): Promise<Enrollment> {
  // Validate plan belongs to academy
  const planCheck = await pool.query(
    `SELECT id FROM academy_plans WHERE id = $1 AND academy_id = $2 AND status = 'active'`,
    [params.planId, academyId]
  );
  if (planCheck.rows.length === 0) throw new Error('Plano não encontrado.');

  // Validate student belongs to academy
  const stuCheck = await pool.query(
    `SELECT au.user_id FROM academy_users au
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.user_id = $1 AND au.academy_id = $2 AND ar.slug = 'academy_student'`,
    [userId, academyId]
  );
  if (stuCheck.rows.length === 0) throw new Error('Aluno não encontrado nesta academia.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cancel previous active enrollment
    await client.query(
      `UPDATE academy_enrollments
       SET status = 'cancelled', end_date = CURRENT_DATE, updated_at = NOW()
       WHERE academy_id = $1 AND user_id = $2 AND status = 'active'`,
      [academyId, userId]
    );

    const ins = await client.query(
      `INSERT INTO academy_enrollments (academy_id, user_id, plan_id, start_date, notes, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING *`,
      [
        academyId,
        userId,
        params.planId,
        params.startDate ?? new Date().toISOString().slice(0, 10),
        params.notes ?? null,
      ]
    );

    // Update student_status to active
    await client.query(
      `UPDATE academy_users SET student_status = 'active', updated_at = NOW()
       WHERE user_id = $1 AND academy_id = $2`,
      [userId, academyId]
    );

    await auditLog(client, {
      academyId,
      userId: actorUserId,
      action: 'student.enrolled',
      entityType: 'user',
      entityId: userId,
      meta: { planId: params.planId },
    });

    await client.query('COMMIT');

    void grantMembership(userId, 'academia', {
      source: 'academy_bootstrap',
      sourceAcademyId: academyId,
      academyId,
      grantedByUserId: actorUserId,
      notes: `Concedido automaticamente na matrícula (academyId=${academyId})`,
      metadata: { channel: 'academy_enrollment' },
    }).catch((err) => {
      logger.error({ err }, '[academy] grantMembership on enroll failed');
    });

    const r = ins.rows[0];
    return {
      id: r.id,
      academyId: r.academy_id,
      userId: r.user_id,
      planId: r.plan_id,
      startDate: new Date(r.start_date).toISOString().slice(0, 10),
      endDate: null,
      status: r.status,
      notes: r.notes ?? null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Status transitions ───────────────────────────────────────────────────────

async function transitionStudentStatus(
  academyId: number,
  actorUserId: number,
  userId: number,
  newStatus: StudentStatus,
  auditAction: string
): Promise<void> {
  const res = await pool.query(
    `UPDATE academy_users SET student_status = $1, updated_at = NOW()
     WHERE user_id = $2 AND academy_id = $3
       AND role_id = (SELECT id FROM academy_roles WHERE academy_id = $3 AND slug = 'academy_student')
     RETURNING user_id`,
    [newStatus, userId, academyId]
  );
  if (res.rows.length === 0) throw new Error('Aluno não encontrado.');

  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: auditAction,
    entityType: 'user',
    entityId: userId,
    meta: { newStatus },
  });
}

export async function pauseStudent(academyId: number, actorUserId: number, userId: number): Promise<void> {
  await transitionStudentStatus(academyId, actorUserId, userId, 'paused', 'student.paused');
}

export async function cancelStudent(academyId: number, actorUserId: number, userId: number): Promise<void> {
  await transitionStudentStatus(academyId, actorUserId, userId, 'cancelled', 'student.cancelled');

  // Also cancel active enrollment
  await pool.query(
    `UPDATE academy_enrollments
     SET status = 'cancelled', end_date = CURRENT_DATE, updated_at = NOW()
     WHERE academy_id = $1 AND user_id = $2 AND status = 'active'`,
    [academyId, userId]
  );
}

export async function reactivateStudent(academyId: number, actorUserId: number, userId: number): Promise<void> {
  await transitionStudentStatus(academyId, actorUserId, userId, 'active', 'student.reactivated');
}
