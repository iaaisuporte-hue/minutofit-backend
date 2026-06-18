/**
 * Cria a tabela personal_platform_subscriptions para gating de planos SaaS
 * do módulo Personal (Free / Starter / Pro).
 * Sem linha na tabela = Free implícito (não requer seed para novos personais).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_platform_subscriptions (
      id                   SERIAL PRIMARY KEY,
      personal_id          INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan                 TEXT         NOT NULL DEFAULT 'free'
                           CHECK (plan IN ('free', 'starter', 'pro')),
      status               TEXT         NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'trial', 'expired', 'cancelled')),
      student_limit        INT,
      ai_enabled           BOOLEAN      NOT NULL DEFAULT false,
      current_period_end   TIMESTAMPTZ,
      notes                TEXT,
      set_by_user_id       INT          REFERENCES users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (personal_id)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS personal_platform_subscriptions`);
};
