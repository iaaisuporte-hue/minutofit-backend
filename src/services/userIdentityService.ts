import pool from '../config/database';
import bcryptjs from 'bcryptjs';
import logger from '../lib/logger';
import { normalizeCpf, normalizePhone, isValidCpf } from './authService';
import { assertStrongPassword } from '../utils/passwordPolicy';
import { logDataAccessEvent } from './dataAccessAuditService';

export type MatchedBy = 'email' | 'cpf' | 'phone' | 'none';
export type MatchKey = 'email' | 'cpf' | 'phone';

/**
 * Estratégia padrão de dedup: email > cpf > phone. Usada em fluxos onde o
 * profissional (academia, personal, nutri) confirma identidade do convidado
 * antes do envio. Não usar em signup público — ali a chave deve ser apenas
 * `email` para evitar merge silencioso por telefone/CPF de terceiros.
 */
const DEFAULT_MATCH_KEYS: MatchKey[] = ['email', 'cpf', 'phone'];

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
 * Looks up an existing user by identity signals.
 *
 * Default priority: email > cpf > phone (strongest first). Caller may restrict
 * the keys via `matchBy` — useful for signup público (`matchBy: ['email']`)
 * para evitar merge silencioso por CPF/phone de terceiros.
 *
 * Email é a chave primária neste momento. CPF está pronto para virar a chave
 * principal numa fase futura (Brasil-only, validação obrigatória em todos os
 * fluxos), mas o backend já normaliza/valida para suportar a transição.
 *
 * Returns null if no match found.
 */
export async function findUserByIdentity(input: {
  email?: string | null;
  cpf?: string | null;
  phone?: string | null;
  matchBy?: MatchKey[];
}): Promise<{ user: FoundUser; matchedBy: MatchedBy } | null> {
  const email = input.email ? input.email.toLowerCase().trim() : null;
  const cpf   = input.cpf   ? normalizeCpf(input.cpf)         : null;
  const phone = input.phone ? normalizePhone(input.phone)      : null;
  const keys  = input.matchBy && input.matchBy.length > 0 ? input.matchBy : DEFAULT_MATCH_KEYS;

  for (const key of keys) {
    if (key === 'email' && email) {
      const res = await pool.query<FoundUser>(
        `SELECT id, email, role, name, cpf, phone, profile_completed,
                (password IS NOT NULL) AS has_password
         FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      if (res.rows.length > 0) return { user: res.rows[0], matchedBy: 'email' };
    }

    if (key === 'cpf' && cpf && isValidCpf(cpf)) {
      const res = await pool.query<FoundUser>(
        `SELECT id, email, role, name, cpf, phone, profile_completed,
                (password IS NOT NULL) AS has_password
         FROM users WHERE cpf = $1 LIMIT 1`,
        [cpf]
      );
      if (res.rows.length > 0) return { user: res.rows[0], matchedBy: 'cpf' };
    }

    if (key === 'phone' && phone && phone.length >= 10) {
      // Telefone só dedupica quando o resultado é único (evita false-positive).
      const res = await pool.query<FoundUser>(
        `SELECT id, email, role, name, cpf, phone, profile_completed,
                (password IS NOT NULL) AS has_password
         FROM users WHERE phone = $1`,
        [phone]
      );
      if (res.rows.length === 1) return { user: res.rows[0], matchedBy: 'phone' };
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
  /**
   * Estratégia de dedup. Default: email > cpf > phone. Em signup público use
   * `['email']` para evitar merge silencioso de identidade por CPF/telefone.
   * Preparado para reorientar para `['cpf', 'email']` quando a Fase 2 tornar
   * CPF obrigatório em todos os fluxos.
   */
  matchBy?: MatchKey[];
}): Promise<FindOrCreateResult> {
  const email = input.email.toLowerCase().trim();
  const cpf   = input.cpf   ? normalizeCpf(input.cpf)    : null;
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const found = await findUserByIdentity({ email, cpf, phone, matchBy: input.matchBy });
  if (found) {
    logger.info(
      { userId: found.user.id, matchedBy: found.matchedBy },
      '[identity] reusing existing user'
    );
    // Auditoria durável de identidade (sem PII no payload — só matchedBy + flags).
    // Útil para disputas "esse cadastro não sou eu" e merge por cpf/phone.
    void logDataAccessEvent({
      actorId: found.user.id,
      subjectUserId: found.user.id,
      eventType: 'identity.user_reused',
      eventPayload: { matchedBy: found.matchedBy, hasCpf: Boolean(cpf), hasPhone: Boolean(phone) },
    });
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

  // Auditoria durável de identidade (sem PII no payload — só estratégia + flags).
  void logDataAccessEvent({
    actorId: newUser.id,
    subjectUserId: newUser.id,
    eventType: 'identity.user_created',
    eventPayload: { matchBy: input.matchBy ?? null, hasCpf: Boolean(cpf), hasPhone: Boolean(phone) },
  });

  return { user: newUser, isNew: true, matchedBy: 'none' };
}

/**
 * Helper dedicado para signup público (`POST /auth/register`). Força
 * `matchBy: ['email']` — bloqueia merge silencioso de identidade por CPF/phone
 * de terceiros mesmo se um caller futuro esquecer de configurar.
 *
 * Use SEMPRE em handlers acessíveis sem autenticação prévia (formulário de
 * registro público). Para fluxos confirmados por profissional (academia,
 * personal, nutri, convites) continue usando `findOrCreateUserFromContext`
 * com a estratégia padrão.
 */
export async function findOrCreateUserForPublicSignup(input: {
  email: string;
  name: string;
  cpf?: string | null;
  phone?: string | null;
  password: string;
}): Promise<FindOrCreateResult> {
  if (!input.password) {
    throw new Error('Senha obrigatória no signup público.');
  }
  return findOrCreateUserFromContext({
    email: input.email,
    name: input.name,
    cpf: input.cpf ?? null,
    phone: input.phone ?? null,
    password: input.password,
    matchBy: ['email'],
  });
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
