import pool from '../config/database';

/**
 * Cria a tabela personal_direct_invites para o fluxo de
 * "personal autônomo convida aluno direto sem academia".
 * Idempotente.
 */
export async function ensurePersonalDirectInvitesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_direct_invites (
      id            SERIAL PRIMARY KEY,
      personal_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token         VARCHAR(64) UNIQUE NOT NULL,
      invited_email VARCHAR(255),
      invited_name  VARCHAR(255),
      status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','expired','revoked')),
      accepted_user_id INTEGER REFERENCES users(id),
      expires_at    TIMESTAMP NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      accepted_at   TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_personal_direct_invites_personal_id
      ON personal_direct_invites(personal_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_personal_direct_invites_token
      ON personal_direct_invites(token)
  `);

  console.log('[db] ensurePersonalDirectInvitesSchema: done');
}
