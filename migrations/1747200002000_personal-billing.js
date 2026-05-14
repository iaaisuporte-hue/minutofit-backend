/**
 * Monetização recorrente do personal.
 *
 * personal_billing_settings     : configuração financeira do personal (ticket padrão, fee MetaCore)
 * personal_billing_plans        : planos que o personal oferece (preço, período)
 * personal_student_subscriptions: assinatura por aluno (vinculada ao MP pre-approval)
 * personal_billing_events       : log imutável de eventos de cobrança/webhook
 *
 * Anti-escopo: sem DRE, NFS-e, plano de contas. Financeiro = mensalidade + régua + dashboard.
 * Split MP (metacore_fee_bps_snapshot) registrado agora; efetivado na Onda 9.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // ---------------------------------------------------------------------------
  // personal_billing_settings
  // ---------------------------------------------------------------------------
  pgm.createTable(
    'personal_billing_settings',
    {
      personal_id: {
        type: 'integer',
        primaryKey: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      default_ticket_cents: { type: 'integer' },
      default_period: { type: 'varchar(20)', default: 'monthly' },
      metacore_fee_bps: { type: 'integer', notNull: true, default: 0 },
      mp_access_token_id: { type: 'integer' },
      created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  // ---------------------------------------------------------------------------
  // personal_billing_plans
  // ---------------------------------------------------------------------------
  pgm.createTable(
    'personal_billing_plans',
    {
      id: 'id',
      personal_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      academy_id: {
        type: 'integer',
        references: '"academies"',
        onDelete: 'SET NULL',
      },
      title: { type: 'varchar(120)', notNull: true },
      description: { type: 'text' },
      price_cents: { type: 'integer', notNull: true },
      period: { type: 'varchar(20)', notNull: true, default: 'monthly' },
      active: { type: 'boolean', notNull: true, default: true },
      created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('personal_billing_plans', ['personal_id', 'active'], {
    name: 'idx_pbp_personal_active',
    ifNotExists: true,
  });

  // ---------------------------------------------------------------------------
  // personal_student_subscriptions
  // ---------------------------------------------------------------------------
  pgm.createTable(
    'personal_student_subscriptions',
    {
      id: 'id',
      personal_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      student_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      academy_id: {
        type: 'integer',
        references: '"academies"',
        onDelete: 'SET NULL',
      },
      plan_id: {
        type: 'integer',
        references: '"personal_billing_plans"',
        onDelete: 'SET NULL',
      },
      price_cents: { type: 'integer', notNull: true },
      status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'pending',
        check: `status IN ('pending','active','paused','canceled','expired')`,
      },
      mp_preapproval_id: { type: 'varchar(80)' },
      current_period_start: { type: 'timestamptz' },
      current_period_end: { type: 'timestamptz' },
      next_charge_at: { type: 'timestamptz' },
      canceled_at: { type: 'timestamptz' },
      discount_cents: { type: 'integer', notNull: true, default: 0 },
      metacore_fee_bps_snapshot: { type: 'integer', notNull: true, default: 0 },
      created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('personal_student_subscriptions', ['personal_id', 'student_id', 'status'], {
    name: 'idx_pss_personal_student_status',
    ifNotExists: true,
  });
  pgm.createIndex('personal_student_subscriptions', ['mp_preapproval_id'], {
    name: 'idx_pss_mp_preapproval',
    where: 'mp_preapproval_id IS NOT NULL',
    ifNotExists: true,
  });

  // ---------------------------------------------------------------------------
  // personal_billing_events
  // ---------------------------------------------------------------------------
  pgm.createTable(
    'personal_billing_events',
    {
      id: 'id',
      subscription_id: {
        type: 'integer',
        notNull: true,
        references: '"personal_student_subscriptions"',
        onDelete: 'CASCADE',
      },
      event_type: { type: 'varchar(40)', notNull: true },
      payload_json: {
        type: 'jsonb',
        notNull: true,
        default: pgm.func("'{}'::jsonb"),
      },
      occurred_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('personal_billing_events', ['subscription_id', 'occurred_at'], {
    name: 'idx_pbe_subscription',
    order: { occurred_at: 'DESC' },
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('personal_billing_events', [], { name: 'idx_pbe_subscription', ifExists: true });
  pgm.dropTable('personal_billing_events', { ifExists: true });

  pgm.dropIndex('personal_student_subscriptions', [], {
    name: 'idx_pss_mp_preapproval',
    ifExists: true,
  });
  pgm.dropIndex('personal_student_subscriptions', [], {
    name: 'idx_pss_personal_student_status',
    ifExists: true,
  });
  pgm.dropTable('personal_student_subscriptions', { ifExists: true });

  pgm.dropIndex('personal_billing_plans', [], {
    name: 'idx_pbp_personal_active',
    ifExists: true,
  });
  pgm.dropTable('personal_billing_plans', { ifExists: true });

  pgm.dropTable('personal_billing_settings', { ifExists: true });
};
