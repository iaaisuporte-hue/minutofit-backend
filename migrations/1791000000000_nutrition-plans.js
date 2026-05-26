/**
 * Área Nutri MVP — Fase 1
 * Tabelas: nutrition_plans + nutrition_plan_meals
 *
 * nutrition_plans: plano alimentar criado pela nutri para um paciente.
 *   - 1 plano ACTIVE por dupla (nutri_id, patient_id) — unique partial index.
 *   - academy_id nullable (nutri autônoma sem academia).
 *
 * nutrition_plan_meals: refeições do plano (até 6), texto livre.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'nutrition_plans',
    {
      id:            'id',
      nutri_id:      { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
      patient_id:    { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
      academy_id:    { type: 'integer', references: '"academies"', onDelete: 'SET NULL' },
      title:         { type: 'varchar(200)', notNull: true },
      objective:     { type: 'varchar(50)',  notNull: true },
      general_notes: { type: 'text' },
      status:        { type: 'varchar(20)', notNull: true, default: "'active'" },
      started_at:    { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      ended_at:      { type: 'timestamptz' },
      created_at:    { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      updated_at:    { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.addConstraint('nutrition_plans', 'np_status_check',
    "CHECK (status IN ('active', 'ended'))");
  pgm.addConstraint('nutrition_plans', 'np_objective_check',
    "CHECK (objective IN ('weight_loss', 'muscle_gain', 'metabolic_health', 'performance', 'maintenance'))");

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS np_one_active_idx
    ON nutrition_plans(nutri_id, patient_id)
    WHERE status = 'active'
  `);

  pgm.createIndex('nutrition_plans', ['nutri_id'],   { name: 'np_nutri_idx',   ifNotExists: true });
  pgm.createIndex('nutrition_plans', ['patient_id'], { name: 'np_patient_idx', ifNotExists: true });

  pgm.createTable(
    'nutrition_plan_meals',
    {
      id:          'id',
      plan_id:     { type: 'integer', notNull: true, references: '"nutrition_plans"', onDelete: 'CASCADE' },
      name:        { type: 'varchar(80)', notNull: true },
      orientation: { type: 'text', notNull: true },
      order_index: { type: 'smallint', notNull: true, default: 0 },
      created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      updated_at:  { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('nutrition_plan_meals', ['plan_id'], { name: 'npm_plan_idx', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('nutrition_plan_meals', [], { name: 'npm_plan_idx',   ifExists: true });
  pgm.dropTable('nutrition_plan_meals', { ifExists: true });
  pgm.dropIndex('nutrition_plans', [], { name: 'np_patient_idx', ifExists: true });
  pgm.dropIndex('nutrition_plans', [], { name: 'np_nutri_idx',   ifExists: true });
  pgm.sql(`DROP INDEX IF EXISTS np_one_active_idx`);
  pgm.dropConstraint('nutrition_plans', 'np_objective_check', { ifExists: true });
  pgm.dropConstraint('nutrition_plans', 'np_status_check',    { ifExists: true });
  pgm.dropTable('nutrition_plans', { ifExists: true });
};
