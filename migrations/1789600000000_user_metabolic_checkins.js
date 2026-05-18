/**
 * Check-in metabólico — registros parciais e opcionais do aluno.
 *
 * Fonte auditável para tendências leves de composição/pressão/glicemia sem
 * alimentar o score metabólico nesta fase.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'user_metabolic_checkins',
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      user_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      academy_id: {
        type: 'integer',
        notNull: false,
        references: '"academies"',
        onDelete: 'SET NULL',
      },
      recorded_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      weight_kg: { type: 'numeric(5,2)', notNull: false },
      waist_cm: { type: 'numeric(5,1)', notNull: false },
      body_fat_pct: { type: 'numeric(4,1)', notNull: false },
      systolic_mmhg: { type: 'integer', notNull: false },
      diastolic_mmhg: { type: 'integer', notNull: false },
      fasting_glucose_mgdl: { type: 'integer', notNull: false },
      notes: { type: 'text', notNull: false },
      source: {
        type: 'text',
        notNull: true,
        check: "source IN ('onboarding','self_report','professional','imported')",
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('user_metabolic_checkins', ['user_id', 'recorded_at'], {
    name: 'umc_user_recorded_at_idx',
    order: { recorded_at: 'DESC' },
    ifNotExists: true,
  });

  pgm.createIndex('user_metabolic_checkins', ['academy_id', 'recorded_at'], {
    name: 'umc_academy_recorded_at_idx',
    order: { recorded_at: 'DESC' },
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('user_metabolic_checkins', [], { name: 'umc_academy_recorded_at_idx', ifExists: true });
  pgm.dropIndex('user_metabolic_checkins', [], { name: 'umc_user_recorded_at_idx', ifExists: true });
  pgm.dropTable('user_metabolic_checkins', { ifExists: true });
};
