/**
 * Reset de senha self-service (Spec 027).
 *
 * Token: crypto.randomBytes(32) hex; só o SHA-256 é persistido (nunca o cru);
 * single-use; expira em 30 min; ao gerar um novo, os anteriores do usuário são
 * invalidados. Aplicar a nova senha carimba `password_changed_at` → o refresh
 * passa a rejeitar sessões abertas antes do reset (ver refreshWithRefreshToken).
 */
import crypto from 'crypto';
import bcryptjs from 'bcryptjs';
import pool from '../config/database';
import { assertStrongPassword } from '../utils/passwordPolicy';

const TOKEN_TTL_MINUTES = 30;

export const RESET_TOKEN_TTL_MINUTES = TOKEN_TTL_MINUTES;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Usuário elegível a reset por e-mail: existe E tem senha local (não OAuth-only). */
export async function findResettableUserByEmail(email: string): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE LOWER(email) = LOWER($1) AND password IS NOT NULL
      LIMIT 1`,
    [email.trim()],
  );
  return rows.length ? { id: Number(rows[0].id) } : null;
}

/** Gera um token de reset para o usuário, invalidando os anteriores. Devolve o
 *  token CRU (só aqui ele existe em claro; no banco vai só o hash). */
export async function createResetToken(userId: number, ip?: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Invalida tokens pendentes anteriores (single active token por usuário).
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, request_ip)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)`,
      [userId, tokenHash, String(TOKEN_TTL_MINUTES), ip ?? null],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return token;
}

class InvalidResetTokenError extends Error {
  code = 'INVALID_RESET_TOKEN' as const;
  constructor() {
    super('Token de redefinição inválido, expirado ou já utilizado.');
    this.name = 'InvalidResetTokenError';
  }
}

/**
 * Consome o token e aplica a nova senha (transação): valida força, faz hash,
 * atualiza `users.password` + `password_changed_at` (invalida sessões) +
 * `must_change_password = FALSE`, e marca o token como usado.
 * Lança InvalidResetTokenError se o token não for válido.
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<{ userId: number }> {
  assertStrongPassword(newPassword);
  const tokenHash = hashToken(token);
  const hashedPassword = await bcryptjs.hash(newPassword, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Trava a linha do token válido para consumo atômico (evita corrida).
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [tokenHash],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new InvalidResetTokenError();
    }
    const { id: tokenId, user_id: userId } = rows[0];
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [tokenId]);
    await client.query(
      `UPDATE users
          SET password = $1,
              password_changed_at = NOW(),
              must_change_password = FALSE
        WHERE id = $2`,
      [hashedPassword, userId],
    );
    await client.query('COMMIT');
    return { userId: Number(userId) };
  } catch (err) {
    // ROLLBACK só se ainda não commitou; ROLLBACK após COMMIT é no-op tolerado.
    try { await client.query('ROLLBACK'); } catch { /* já finalizado */ }
    throw err;
  } finally {
    client.release();
  }
}

export { InvalidResetTokenError };
