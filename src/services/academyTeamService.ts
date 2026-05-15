import pool from '../config/database';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { ensureAcademyRoles } from '../db/academyRoles';
import { getUserProducts, grantUserProduct } from '../db/ensureProductsSchema';
import logger from '../lib/logger';
import { auditLog } from '../utils/auditLog';
import { resolveActiveAcademyId } from './authService';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamMember {
  userId: number;
  name: string;
  email: string;
  roleSlug: string;
  roleLabel: string;
  isActive: boolean;
  status: string;
  joinedAt: string | null;
  phone?: string;
}

export interface PendingInvitation {
  id: number;
  email: string;
  roleSlug: string;
  roleLabel: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  return crypto.randomBytes(6).toString('hex'); // 12-char hex
}

async function getRoleId(academyId: number, roleSlug: string): Promise<number | null> {
  const res = await pool.query(
    `SELECT id FROM academy_roles WHERE academy_id = $1 AND slug = $2`,
    [academyId, roleSlug]
  );
  return res.rows.length > 0 ? res.rows[0].id : null;
}

// ─── Team ─────────────────────────────────────────────────────────────────────

export async function getTeam(academyId: number): Promise<TeamMember[]> {
  const res = await pool.query(
    `SELECT
       u.id AS user_id, u.name, u.email, u.phone,
       ar.slug  AS role_slug,
       ar.label AS role_label,
       au.is_active, au.status, au.joined_at
     FROM academy_users au
     JOIN users         u  ON u.id  = au.user_id
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.academy_id = $1
     ORDER BY ar.slug, u.name`,
    [academyId]
  );
  return res.rows.map((r) => ({
    userId:    r.user_id,
    name:      r.name ?? '',
    email:     r.email,
    phone:     r.phone ?? undefined,
    roleSlug:  r.role_slug,
    roleLabel: r.role_label,
    isActive:  r.is_active,
    status:    r.status,
    joinedAt:  r.joined_at ? new Date(r.joined_at).toISOString() : null,
  }));
}

export async function addMemberDirect(
  academyId: number,
  actorUserId: number,
  params: { roleSlug: string; name: string; email: string; cpf?: string; phone?: string }
): Promise<{ member: TeamMember; tempPassword?: string }> {
  const email = params.email.toLowerCase().trim();

  const roleId = await getRoleId(academyId, params.roleSlug);
  if (!roleId) throw new Error(`Role "${params.roleSlug}" não encontrado nesta academia.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if user exists globally
    let userRow: any;
    const existing = await client.query(`SELECT id, name, email FROM users WHERE email = $1`, [email]);

    let tempPassword: string | undefined;

    if (existing.rows.length > 0) {
      userRow = existing.rows[0];
    } else {
      // Create new user with temp password
      tempPassword = generateTempPassword();
      const hash = await bcrypt.hash(tempPassword, 12);
      const ins = await client.query(
        `INSERT INTO users (name, email, password, role, phone, cpf, profile_completed)
         VALUES ($1, $2, $3, 'user', $4, $5, true)
         RETURNING id, name, email`,
        [
          String(params.name).trim(),
          email,
          hash,
          params.phone ?? null,
          params.cpf   ?? null,
        ]
      );
      userRow = ins.rows[0];
    }

    // Link to academy (or reactivate)
    await client.query(
      `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active, joined_at)
       VALUES ($1, $2, $3, 'active', TRUE, NOW())
       ON CONFLICT (user_id, academy_id) DO UPDATE
         SET role_id = EXCLUDED.role_id,
             status  = 'active',
             is_active = TRUE,
             joined_at = COALESCE(academy_users.joined_at, NOW()),
             updated_at = NOW()`,
      [userRow.id, academyId, roleId]
    );

    await auditLog(client, {
      academyId,
      userId: actorUserId,
      action: 'member.added',
      entityType: 'user',
      entityId: userRow.id,
      meta: { roleSlug: params.roleSlug, mode: 'direct' },
    });

    await client.query('COMMIT');

    try {
      await grantUserProduct({
        userId: userRow.id,
        productKey: 'academia',
        source: 'academy_bootstrap',
        sourceAcademyId: academyId,
        grantedByUserId: actorUserId,
        notes: 'Vínculo equipe da academia (cadastro direto)',
      });
    } catch (err: any) {
      logger.error({ err }, '[products] grant academia (addMemberDirect)');
    }

    return {
      member: {
        userId:    userRow.id,
        name:      userRow.name ?? '',
        email:     userRow.email,
        roleSlug:  params.roleSlug,
        roleLabel: params.roleSlug,
        isActive:  true,
        status:    'active',
        joinedAt:  new Date().toISOString(),
      },
      tempPassword,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createInvitation(
  academyId: number,
  actorUserId: number,
  params: { roleSlug: string; email: string },
  frontendUrl: string
): Promise<{ invitation: PendingInvitation; inviteUrl: string }> {
  const email = params.email.toLowerCase().trim();

  const roleId = await getRoleId(academyId, params.roleSlug);
  if (!roleId) throw new Error(`Role "${params.roleSlug}" não encontrado nesta academia.`);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const res = await pool.query(
    `INSERT INTO academy_invitations (academy_id, email, role_id, token, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [academyId, email, roleId, token, actorUserId, expiresAt]
  );

  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'invitation.created',
    entityType: 'invitation',
    entityId: res.rows[0].id,
    meta: { email, roleSlug: params.roleSlug },
  });

  const roleRes = await pool.query(
    `SELECT label FROM academy_roles WHERE id = $1`, [roleId]
  );

  const invitation: PendingInvitation = {
    id:        res.rows[0].id,
    email,
    roleSlug:  params.roleSlug,
    roleLabel: roleRes.rows[0]?.label ?? params.roleSlug,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date(res.rows[0].created_at).toISOString(),
    acceptedAt: null,
  };

  return { invitation, inviteUrl: `${frontendUrl}/invite/${token}` };
}

export async function getInvitations(academyId: number): Promise<PendingInvitation[]> {
  const res = await pool.query(
    `SELECT
       ai.id, ai.email, ai.expires_at, ai.created_at, ai.accepted_at,
       ar.slug AS role_slug, ar.label AS role_label
     FROM academy_invitations ai
     JOIN academy_roles ar ON ar.id = ai.role_id
     WHERE ai.academy_id = $1
     ORDER BY ai.created_at DESC`,
    [academyId]
  );
  return res.rows.map((r) => ({
    id:        r.id,
    email:     r.email,
    roleSlug:  r.role_slug,
    roleLabel: r.role_label,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
  }));
}

export async function revokeInvitation(
  academyId: number,
  actorUserId: number,
  invitationId: number
): Promise<void> {
  const res = await pool.query(
    `DELETE FROM academy_invitations WHERE id = $1 AND academy_id = $2 RETURNING id`,
    [invitationId, academyId]
  );
  if (res.rows.length === 0) throw new Error('Convite não encontrado.');

  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'invitation.revoked',
    entityType: 'invitation',
    entityId: invitationId,
  });
}

export async function updateMember(
  academyId: number,
  actorUserId: number,
  targetUserId: number,
  params: { roleSlug?: string; isActive?: boolean }
): Promise<void> {
  // Prevent owner from demoting themselves
  const selfCheck = await pool.query(
    `SELECT ar.slug FROM academy_users au
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.user_id = $1 AND au.academy_id = $2`,
    [targetUserId, academyId]
  );
  if (selfCheck.rows.length === 0) throw new Error('Membro não encontrado.');

  const currentSlug = selfCheck.rows[0].slug;
  if (
    targetUserId === actorUserId &&
    currentSlug === 'academy_owner' &&
    params.roleSlug &&
    params.roleSlug !== 'academy_owner'
  ) {
    throw new Error('O dono não pode rebaixar a própria conta.');
  }

  const updates: string[] = [];
  const vals: unknown[] = [];

  if (params.roleSlug !== undefined) {
    const roleId = await getRoleId(academyId, params.roleSlug);
    if (!roleId) throw new Error(`Role "${params.roleSlug}" não encontrado.`);
    updates.push(`role_id = $${vals.length + 1}`);
    vals.push(roleId);
  }
  if (params.isActive !== undefined) {
    updates.push(`is_active = $${vals.length + 1}`);
    vals.push(params.isActive);
    updates.push(`status = $${vals.length + 1}`);
    vals.push(params.isActive ? 'active' : 'inactive');
  }
  if (updates.length === 0) return;

  updates.push('updated_at = NOW()');
  vals.push(targetUserId, academyId);

  await pool.query(
    `UPDATE academy_users SET ${updates.join(', ')}
     WHERE user_id = $${vals.length - 1} AND academy_id = $${vals.length}`,
    vals
  );

  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: params.isActive === false ? 'member.deactivated' : 'member.role_changed',
    entityType: 'user',
    entityId: targetUserId,
    meta: params as Record<string, unknown>,
  });
}

// ─── Accept invitation (public flow) ─────────────────────────────────────────

export async function validateInvitationToken(token: string): Promise<{
  id: number;
  email: string;
  academyName: string;
  academySlug: string;
  roleSlug: string;
  roleLabel: string;
  userExists: boolean;
}> {
  const res = await pool.query(
    `SELECT
       ai.id, ai.email, ai.accepted_at, ai.expires_at,
       a.display_name AS academy_name, a.slug AS academy_slug,
       ar.slug AS role_slug, ar.label AS role_label
     FROM academy_invitations ai
     JOIN academies     a  ON a.id  = ai.academy_id
     JOIN academy_roles ar ON ar.id = ai.role_id
     WHERE ai.token = $1`,
    [token]
  );

  if (res.rows.length === 0) throw new Error('Convite inválido ou não encontrado.');
  const row = res.rows[0];

  if (row.accepted_at) throw new Error('Este convite já foi aceito.');
  if (new Date(row.expires_at) < new Date()) throw new Error('Este convite expirou.');

  const userCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, [row.email]);

  return {
    id:          row.id,
    email:       row.email,
    academyName: row.academy_name,
    academySlug: row.academy_slug,
    roleSlug:    row.role_slug,
    roleLabel:   row.role_label,
    userExists:  userCheck.rows.length > 0,
  };
}

export async function acceptInvitation(
  token: string,
  params: { password?: string; name?: string; cpf?: string; phone?: string }
): Promise<{ user: any; accessToken: string; refreshToken: string }> {
  const inv = await pool.query(
    `SELECT
       ai.id, ai.email, ai.accepted_at, ai.expires_at, ai.role_id, ai.academy_id,
       a.display_name AS academy_name
     FROM academy_invitations ai
     JOIN academies a ON a.id = ai.academy_id
     WHERE ai.token = $1`,
    [token]
  );

  if (inv.rows.length === 0) throw new Error('Convite inválido.');
  const row = inv.rows[0];
  if (row.accepted_at) throw new Error('Convite já aceito.');
  if (new Date(row.expires_at) < new Date()) throw new Error('Convite expirado.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let userId: number;
    const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [row.email]);

    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
    } else {
      if (!params.password || !params.name) {
        throw new Error('Nome e senha são obrigatórios para criar a conta.');
      }
      const hash = await bcrypt.hash(params.password, 12);
      const ins = await client.query(
        `INSERT INTO users (name, email, password, role, phone, cpf, profile_completed)
         VALUES ($1, $2, $3, 'user', $4, $5, true)
         RETURNING id`,
        [
          String(params.name).trim(),
          row.email,
          hash,
          params.phone ?? null,
          params.cpf   ?? null,
        ]
      );
      userId = ins.rows[0].id;
    }

    // Link to academy
    await client.query(
      `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active, joined_at)
       VALUES ($1, $2, $3, 'active', TRUE, NOW())
       ON CONFLICT (user_id, academy_id) DO UPDATE
         SET role_id = EXCLUDED.role_id, status = 'active', is_active = TRUE,
             joined_at = COALESCE(academy_users.joined_at, NOW()), updated_at = NOW()`,
      [userId, row.academy_id, row.role_id]
    );

    // Mark invitation as accepted
    await client.query(
      `UPDATE academy_invitations SET accepted_at = NOW() WHERE id = $1`,
      [row.id]
    );

    await auditLog(client, {
      academyId: row.academy_id,
      userId,
      action: 'invitation.accepted',
      entityType: 'invitation',
      entityId: row.id,
    });

    await client.query('COMMIT');

    try {
      await grantUserProduct({
        userId,
        productKey: 'academia',
        source: 'academy_bootstrap',
        sourceAcademyId: row.academy_id,
        academyId: row.academy_id,
        grantedByUserId: null,
        notes: 'Vínculo equipe da academia (convite aceito)',
        metadata: { source: 'academy_invite_accepted' },
      });
    } catch (err: any) {
      logger.error({ err }, '[products] grant academia (acceptInvitation)');
    }

    const userRes = await pool.query(`SELECT id, email, role, name, profile_completed, access_profile FROM users WHERE id = $1`, [userId]);
    const u = userRes.rows[0];

    const activeAcademyId = await resolveActiveAcademyId(userId);
    const products = await getUserProducts(userId);
    const accessToken = generateAccessToken({
      id: u.id,
      email: u.email,
      role: u.role,
      profileCompleted: u.profile_completed,
      accessProfile: u.access_profile,
      activeAcademyId,
      products,
    });
    const refreshToken = generateRefreshToken({ id: u.id, email: u.email });

    return { user: u, accessToken, refreshToken };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Assign owner to existing academy ────────────────────────────────────────

export async function assignOwner(
  academyId: number,
  actorUserId: number,
  params: {
    mode: 'existing' | 'new';
    userId?: number;
    email?: string;
    name?: string;
    cpf?: string;
    phone?: string;
  }
): Promise<{ ownerId: number; ownerName: string; ownerEmail: string; tempPassword?: string }> {
  const roleIdMap = await ensureAcademyRoles(pool, academyId);
  const ownerRoleId = roleIdMap['academy_owner'];
  if (!ownerRoleId) throw new Error('Role academy_owner não encontrado.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let ownerId: number;
    let ownerName: string;
    let ownerEmail: string;
    let tempPassword: string | undefined;

    if (params.mode === 'existing') {
      // Find by userId or email
      let q: any;
      if (params.userId) {
        q = await client.query(`SELECT id, name, email FROM users WHERE id = $1`, [params.userId]);
      } else if (params.email) {
        q = await client.query(`SELECT id, name, email FROM users WHERE email = $1`, [params.email.toLowerCase().trim()]);
      } else {
        throw new Error('userId ou email obrigatório para modo existing.');
      }
      if (q.rows.length === 0) throw new Error('Usuário não encontrado.');
      ownerId    = q.rows[0].id;
      ownerName  = q.rows[0].name;
      ownerEmail = q.rows[0].email;
    } else {
      // Create new user
      if (!params.name || !params.email) throw new Error('name e email obrigatórios para criar novo dono.');
      tempPassword = generateTempPassword();
      const hash = await bcrypt.hash(tempPassword, 12);
      const ins = await client.query(
        `INSERT INTO users (name, email, password, role, phone, cpf, profile_completed)
         VALUES ($1, $2, $3, 'user', $4, $5, true)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, email`,
        [
          String(params.name).trim(),
          params.email.toLowerCase().trim(),
          hash,
          params.phone ?? null,
          params.cpf   ?? null,
        ]
      );
      ownerId    = ins.rows[0].id;
      ownerName  = ins.rows[0].name;
      ownerEmail = ins.rows[0].email;
    }

    // Upsert academy_users with owner role
    await client.query(
      `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active, joined_at)
       VALUES ($1, $2, $3, 'active', TRUE, NOW())
       ON CONFLICT (user_id, academy_id) DO UPDATE
         SET role_id = EXCLUDED.role_id, status = 'active', is_active = TRUE, updated_at = NOW()`,
      [ownerId, academyId, ownerRoleId]
    );

    // Update academies.owner_user_id
    await client.query(
      `UPDATE academies SET owner_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [ownerId, academyId]
    );

    await auditLog(client, {
      academyId,
      userId: actorUserId,
      action: 'owner.assigned',
      entityType: 'user',
      entityId: ownerId,
      meta: { mode: params.mode },
    });

    await client.query('COMMIT');

    try {
      await grantUserProduct({
        userId: ownerId,
        productKey: 'academia',
        source: 'academy_bootstrap',
        sourceAcademyId: academyId,
        grantedByUserId: actorUserId,
        notes: 'Dono da academia atribuído',
      });
    } catch (err: any) {
      logger.error({ err }, '[products] grant academia (assignOwner)');
    }

    return { ownerId, ownerName, ownerEmail, tempPassword };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
