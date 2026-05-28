/**
 * Rede de Profissionais — US4 (checkout pago via Mercado Pago)
 *
 * Cria as duas tabelas de monetização da Spec 001:
 *   - professional_service_offerings: planos comerciais ofertados por personal/nutri
 *   - professional_subscriptions:     assinatura paga aluno → profissional
 *
 * Webhook MP usa `external_reference = 'pro-net-sub:<id>'` para rotear.
 *
 * Reusa user_data_consents (Onda 1) — ativação transacional concede consents
 * default. Reusa data_access_audit; novos event_type values (offering.*,
 * subscription.*) cabem em VARCHAR(48) sem CHECK constraint.
 *
 * US3 (políticas de academia) foi removida em 2026-05-27; tabela
 * academy_professional_network_policies criada em 1790900000000 segue
 * inativa — não gateia checkout aqui.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS professional_service_offerings (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      professional_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_role   VARCHAR(16) NOT NULL CHECK (professional_role IN ('personal','nutri')),
      title               VARCHAR(120) NOT NULL,
      description         TEXT CHECK (description IS NULL OR char_length(description) <= 400),
      price_cents         INTEGER NOT NULL CHECK (price_cents >= 0),
      currency            CHAR(3) NOT NULL DEFAULT 'BRL',
      period              VARCHAR(16) NOT NULL CHECK (period IN ('monthly','quarterly','semiannual','annual')),
      status              VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_pso_pro_active
      ON professional_service_offerings(professional_id)
      WHERE status = 'active'
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS professional_subscriptions (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_role           VARCHAR(16) NOT NULL CHECK (professional_role IN ('personal','nutri')),
      offering_id                 UUID NOT NULL REFERENCES professional_service_offerings(id) ON DELETE RESTRICT,
      price_cents_snapshot        INTEGER NOT NULL CHECK (price_cents_snapshot >= 0),
      period_snapshot             VARCHAR(16) NOT NULL CHECK (period_snapshot IN ('monthly','quarterly','semiannual','annual')),
      metacore_fee_bps_snapshot   INTEGER NOT NULL DEFAULT 0 CHECK (metacore_fee_bps_snapshot >= 0),
      status                      VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                                    CHECK (status IN ('pending_payment','active','paused','cancelled','expired')),
      mp_preapproval_id           VARCHAR(120),
      current_period_start        TIMESTAMPTZ,
      current_period_end          TIMESTAMPTZ,
      next_charge_at              TIMESTAMPTZ,
      cancelled_at                TIMESTAMPTZ,
      cancel_reason               TEXT,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_ps_student_active
      ON professional_subscriptions(student_id, professional_role)
      WHERE status = 'active'
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_ps_pro_active
      ON professional_subscriptions(professional_id)
      WHERE status = 'active'
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_ps_mp
      ON professional_subscriptions(mp_preapproval_id)
      WHERE mp_preapproval_id IS NOT NULL
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_ps_mp`);
  pgm.sql(`DROP INDEX IF EXISTS idx_ps_pro_active`);
  pgm.sql(`DROP INDEX IF EXISTS idx_ps_student_active`);
  pgm.sql(`DROP TABLE IF EXISTS professional_subscriptions`);
  pgm.sql(`DROP INDEX IF EXISTS idx_pso_pro_active`);
  pgm.sql(`DROP TABLE IF EXISTS professional_service_offerings`);
};
