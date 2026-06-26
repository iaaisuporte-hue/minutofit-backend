/**
 * Spec 015 — Academy SaaS Billing (Free=operação · Pro=inteligência).
 * Assinatura SaaS da academia, espelhando personal_platform_subscriptions (Spec 008).
 * Sem linha = Free implícito. intelligence_enabled é o gate da inteligência (Pro).
 * price_cents é configurável (preço TBD, nunca hardcodado).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS academy_subscriptions (
      id                   SERIAL PRIMARY KEY,
      academy_id           INT          NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      plan                 TEXT         NOT NULL DEFAULT 'free'
                           CHECK (plan IN ('free', 'pro')),
      status               TEXT         NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'trial', 'pending', 'expired', 'cancelled')),
      intelligence_enabled BOOLEAN      NOT NULL DEFAULT false,
      student_cap          INT,
      price_cents          INT,
      coupon_code          TEXT,
      trial_until          TIMESTAMPTZ,
      current_period_end   TIMESTAMPTZ,
      mp_preapproval_id    TEXT,
      notes                TEXT,
      set_by_user_id       INT          REFERENCES users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (academy_id)
    )
  `);

  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_academy_sub_mp_preapproval
      ON academy_subscriptions (mp_preapproval_id) WHERE mp_preapproval_id IS NOT NULL
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS academy_subscription_billing_events (
      id                 BIGSERIAL    PRIMARY KEY,
      academy_id         INT          NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      mp_preapproval_id  TEXT,
      mp_event_id        TEXT,
      event_type         TEXT         NOT NULL,
      mp_status          TEXT,
      payload            JSONB        NOT NULL DEFAULT '{}',
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_academy_billing_mp_event_id
      ON academy_subscription_billing_events (mp_event_id) WHERE mp_event_id IS NOT NULL
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_academy_billing_academy_created
      ON academy_subscription_billing_events (academy_id, created_at DESC)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS academy_subscription_billing_events`);
  await pgm.db.query(`DROP TABLE IF EXISTS academy_subscriptions`);
};
