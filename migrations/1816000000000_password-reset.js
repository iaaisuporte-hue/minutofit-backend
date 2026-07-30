/**
 * Recuperação de senha self-service (Spec 027).
 *
 * 1. `password_reset_tokens`: tokens de reset — só o SHA-256 é guardado (nunca o
 *    token cru), single-use (`used_at`), expiração curta (`expires_at`). FK CASCADE.
 * 2. `users.password_changed_at`: carimbo de invalidação de sessão. O reset o seta
 *    para NOW(); o refresh passa a rejeitar tokens emitidos antes disso (fecha o
 *    refresh roubado de até 7 dias sem precisar enumerar a denylist). Nullable:
 *    usuários legados (null) não são afetados.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   VARCHAR(64)  NOT NULL,
      expires_at   TIMESTAMPTZ  NOT NULL,
      used_at      TIMESTAMPTZ,
      request_ip   INET,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens (token_hash)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id)`);
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at`);
  await pgm.db.query(`DROP TABLE IF EXISTS password_reset_tokens`);
};
