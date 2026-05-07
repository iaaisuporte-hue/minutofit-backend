import pool from '../config/database';

export async function ensureRevokedTokensSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revoked_refresh_tokens (
      jti       UUID        PRIMARY KEY,
      user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_revoked_refresh_tokens_expires_at
    ON revoked_refresh_tokens (expires_at)
  `);

  // Purge entries that have already passed their natural expiry — they are no longer a risk
  await pool.query(`DELETE FROM revoked_refresh_tokens WHERE expires_at < NOW()`);
}
