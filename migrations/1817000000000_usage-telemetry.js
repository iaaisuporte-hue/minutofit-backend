/**
 * Spec 028 — Telemetria de Uso.
 *
 * O sistema não registrava login: `last_login` não existia no schema e o único
 * proxy de atividade era `user_daily_checkins` (que mede uma feature, não o app).
 * Sem isto não há DAU/MAU, retenção nem funil de ativação.
 *
 *   users.last_login_at / last_seen_at — marcos por usuário
 *   user_activity_days                 — uma linha por usuário/dia (DAU/MAU)
 *
 * Granularidade DIÁRIA é deliberada: mantém a tabela proporcional a
 * usuários×dias e evita construir um event store. Sem IP, sem user-agent,
 * sem rota — só o fato de ter havido uso.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_activity_days (
      id            SERIAL      PRIMARY KEY,
      user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day           DATE        NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, day)
    )
  `);

  // Agregados varrem por período (DAU/WAU/MAU), daí o índice por dia.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_user_activity_days_day
      ON user_activity_days (day)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_user_activity_days_day`);
  await pgm.db.query(`DROP TABLE IF EXISTS user_activity_days`);
  await pgm.db.query(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS last_login_at,
      DROP COLUMN IF EXISTS last_seen_at
  `);
};
