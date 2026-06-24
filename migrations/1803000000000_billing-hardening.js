/**
 * Billing hardening (Spec 011) — observabilidade + idempotência do SaaS do personal.
 *
 *  - personal_platform_billing_events: log append-only de cada webhook/ação MP,
 *    com UNIQUE parcial em mp_event_id → dedup de reprocessamento (idempotência).
 *  - UNIQUE parcial em personal_platform_subscriptions.mp_preapproval_id
 *    (hoje só há índice não-único) → um preapproval não aponta p/ 2 linhas.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_platform_billing_events (
      id                 BIGSERIAL PRIMARY KEY,
      personal_id        INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mp_preapproval_id  TEXT,
      mp_event_id        TEXT,
      event_type         TEXT         NOT NULL,
      mp_status          TEXT,
      payload            JSONB        NOT NULL DEFAULT '{}',
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // Dedup: o mesmo evento do MP (x-request-id / data.id) só é processado 1x.
  // Parcial porque eventos sem id (ex.: reconciliação manual) não deduplicam.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ppbe_mp_event_id
      ON personal_platform_billing_events (mp_event_id)
      WHERE mp_event_id IS NOT NULL
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_ppbe_personal_created
      ON personal_platform_billing_events (personal_id, created_at DESC)
  `);

  // Um preapproval do MP não pode apontar para duas assinaturas (parcial: NULLs ok).
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pps_mp_preapproval_id
      ON personal_platform_subscriptions (mp_preapproval_id)
      WHERE mp_preapproval_id IS NOT NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS uq_pps_mp_preapproval_id`);
  await pgm.db.query(`DROP TABLE IF EXISTS personal_platform_billing_events`);
};
