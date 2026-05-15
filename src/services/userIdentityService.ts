import pool from '../config/database';
import bcryptjs from 'bcryptjs';
import logger from '../lib/logger';
import { normalizeCpf, normalizePhone, isValidCpf } from './authService';
import { assertStrongPassword } from '../utils/passwordPolicy';

export type MatchedBy = 'email' | 'cpf' | 'phone' | 'none';

export interface FoundUser {
  id: number;
  email: string;
  role: string;
  name: string | null;
  cpf: string | null;
  phone: string | null;
  profile_completed: boolean;
  has_password: boolean;
}

export interface FindOrCreateResult {
  user: FoundUser;
  isNew: boolean;
  matchedBy: MatchedBy;
}

/**
 * Looks up an existing user by identity signals in priority order:
 *   1. email (strongest — globally unique constraint)
 *   2. cpf   (unique constraint)
 *   3. phone (NOT unique — used only as fallback hint; may return null if ambiguous)
 *
 * Returns null if no match found.
 */
export async function findUserByIdentity(input: {
  email?: string | null;
  cpf?: string | null;
  phone?: string | null;
}): Promise<{ user: FoundUser; matchedBy: MatchedBy } | null> {
  const email = input.email ? input.email.toLowerCase().trim() : null;
  const cpf   = input.cpf   ? normalizeCpf(input.cpf)         : null;
  const phone = input.phone ? normalizePhone(input.phone)      : null;

  // 1. Match by email
  if (email) {
    const res = await pool.query<FoundUser>(
      `SELECT id, email, role, name, cpf, phone, profile_completed,
              (password IS NOT NULL) AS has_password
       FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    if (res.rows.length > 0) {
      return { user: res.rows[0], matchedBy: 'email' };
    }
  }

  // 2. Match by CPF (only if valid)
  if (cpf && isValidCpf(cpf)) {
    const res = await pool.query<FoundUser>(
      `SELECT id, email, role, name, cpf, phone, profile_completed,
              (password IS NOT NULL) AS has_password
       FROM users WHERE cpf = $1 LIMIT 1`,
      [cpf]
    );
    if (res.rows.length > 0) {
      return { user: res.rows[0], matchedBy: 'cpf' };
    }
  }

  // 3. Match by phone — only if exactly one result (avoid false-positives)
  if (phone && phone.length >= 10) {
    const res = await pool.query<FoundUser>(
      `SELECT id, email, role, name, cpf, phone, profile_completed,
              (password IS NOT NULL) AS has_password
       FROM users WHERE phone = $1`,
      [phone]
    );
    if (res.rows.length === 1) {
      return { user: res.rows[0], matchedBy: 'phone' };
    }
  }

  return null;
}

/**
 * Finds an existing user or creates a minimal new one.
 *
 * When an existing user is found:
 *  - Returns it with isNew=false
 *  - Does NOT verify password — caller is responsible for authorization
 *
 * When no user is found:
 *  - Creates a minimal user with role='user', profile_completed=false
 *  - Requires at minimum email + password + name
 *  - Does NOT assign free subscription (caller should decide)
 *
 * Used by invite flows to implement "link account if already exists, create if not".
 */
export async function findOrCreateUserFromContext(input: {
  email: string;
  name: string;
  cpf?: string | null;
  phone?: string | null;
  /** Required only when creating a new user. */
  password?: string | null;
  /** Skip password policy check — for academy direct-add flows with temp passwords. */
  skipPasswordPolicy?: boolean;
}): Promise<FindOrCreateResult> {
  const email = input.email.toLowerCase().trim();
  const cpf   = input.cpf   ? normalizeCpf(input.cpf)    : null;
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const found = await findUserByIdentity({ email, cpf, phone });
  if (found) {
    logger.info(
      { userId: found.user.id, matchedBy: found.matchedBy },
      '[identity] reusing existing user'
    );
    return { user: found.user, isNew: false, matchedBy: found.matchedBy };
  }

  // Create new user
  if (!input.password) {
    throw new Error('Senha obrigatória para criar nova conta.');
  }

  if (!input.skipPasswordPolicy) {
    assertStrongPassword(input.password);
  }

  const hashedPassword = await bcryptjs.hash(input.password, 10);

  const res = await pool.query<FoundUser>(
    `INSERT INTO users (email, password, role, name, cpf, phone, profile_completed)
     VALUES ($1, $2, 'user', $3, $4, $5, false)
     RETURNING id, email, role, name, cpf, phone, profile_completed,
               (password IS NOT NULL) AS has_password`,
    [email, hashedPassword, input.name.trim(), cpf ?? null, phone ?? null]
  );

  const newUser = res.rows[0];
  logger.info({ userId: newUser.id, email }, '[identity] created new user');

  return { user: newUser, isNew: true, matchedBy: 'none' };
}

/**
 * Verifies a user's password. Used when an existing user accepts an invite
 * and needs to prove ownership of their account.
 *
 * Returns true if password matches, false otherwise.
 */
export async function verifyUserPassword(userId: number, password: string): Promise<boolean> {
  const res = await pool.query<{ password: string | null }>(
    `SELECT password FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (res.rows.length === 0 || !res.rows[0].password) return false;
  return bcryptjs.compare(password, res.rows[0].password);
}
