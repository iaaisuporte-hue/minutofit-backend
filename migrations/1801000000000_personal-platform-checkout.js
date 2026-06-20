/**
 * Adiciona suporte a checkout self-serve (Mercado Pago pre-approval) na
 * assinatura SaaS do personal (personal_platform_subscriptions).
 *
 * V1: personal paga o plano Pro sozinho. Antes, plano só era setado por admin.
 * - mp_preapproval_id: id da pre-aprovação recorrente no Mercado Pago
 * - price_cents: valor cobrado (snapshot)
 * - status ganha 'pending' (checkout criado, aguardando autorização do pagamento)
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT,
      ADD COLUMN IF NOT EXISTS price_cents       INT
  `);

  // Estende o CHECK de status para incluir 'pending' (checkout aguardando pagamento).
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      DROP CONSTRAINT IF EXISTS personal_platform_subscriptions_status_check
  `);
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      ADD CONSTRAINT personal_platform_subscriptions_status_check
      CHECK (status IN ('active', 'trial', 'expired', 'cancelled', 'pending'))
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pps_mp_preapproval
      ON personal_platform_subscriptions (mp_preapproval_id)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_pps_mp_preapproval`);
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      DROP CONSTRAINT IF EXISTS personal_platform_subscriptions_status_check
  `);
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      ADD CONSTRAINT personal_platform_subscriptions_status_check
      CHECK (status IN ('active', 'trial', 'expired', 'cancelled'))
  `);
  await pgm.db.query(`
    ALTER TABLE personal_platform_subscriptions
      DROP COLUMN IF EXISTS mp_preapproval_id,
      DROP COLUMN IF EXISTS price_cents
  `);
};
