/**
 * Área Nutri MVP — Fase 1
 * Tabela: nutrition_adherence_checkins
 *
 * Check-in diário do aluno sobre adesão ao plano alimentar ativo.
 * Uma entrada por (patient_id, plan_id, check_date) — índice único.
 * check_date é DATE (sem hora) para garantir um registro por dia.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'nutrition_adherence_checkins',
    {
      id:         'id',
      patient_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
      plan_id:    { type: 'integer', notNull: true, references: '"nutrition_plans"', onDelete: 'CASCADE' },
      check_date: { type: 'date', notNull: true },
      adherence:  { type: 'varchar(20)', notNull: true },
      note:       { type: 'varchar(200)' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.addConstraint('nutrition_adherence_checkins', 'nac_adherence_check',
    "CHECK (adherence IN ('full', 'partial', 'skipped'))");

  pgm.addConstraint('nutrition_adherence_checkins', 'nac_one_per_day_unique',
    'UNIQUE (patient_id, plan_id, check_date)');

  pgm.createIndex('nutrition_adherence_checkins', ['patient_id', 'check_date'],
    { name: 'nac_patient_date_idx', ifNotExists: true });
  pgm.createIndex('nutrition_adherence_checkins', ['plan_id'],
    { name: 'nac_plan_idx', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('nutrition_adherence_checkins', [], { name: 'nac_plan_idx',         ifExists: true });
  pgm.dropIndex('nutrition_adherence_checkins', [], { name: 'nac_patient_date_idx', ifExists: true });
  pgm.dropConstraint('nutrition_adherence_checkins', 'nac_one_per_day_unique', { ifExists: true });
  pgm.dropConstraint('nutrition_adherence_checkins', 'nac_adherence_check',    { ifExists: true });
  pgm.dropTable('nutrition_adherence_checkins', { ifExists: true });
};
