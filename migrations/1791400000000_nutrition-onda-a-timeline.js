/**
 * Nutri Onda A — Timeline + check-in granular por refeição
 *
 * 1. Colunas aditivas em nutrition_plan_meals:
 *    meal_time, tolerance_minutes, reminder_minutes,
 *    metabolic_goal, workout_relation, hydration_note, supplement_note
 *
 * 2. Nova tabela nutrition_meal_alternatives:
 *    substituições por refeição prescritas pela nutri.
 *
 * 3. Nova tabela nutrition_meal_checkins:
 *    check-in granular do aluno por refeição/dia.
 *    Substitui o modelo diário binário (nutrition_adherence_checkins legado é mantido).
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // -------------------------------------------------------------------
  // 1. Extend nutrition_plan_meals — all additive, all nullable
  // -------------------------------------------------------------------
  pgm.addColumns('nutrition_plan_meals', {
    meal_time:          { type: 'time' },
    tolerance_minutes:  { type: 'integer', default: 60 },
    reminder_minutes:   { type: 'integer', default: 30 },
    metabolic_goal:     { type: 'varchar(30)' },
    workout_relation:   { type: 'varchar(10)' },
    hydration_note:     { type: 'varchar(200)' },
    supplement_note:    { type: 'varchar(200)' },
  }, { ifNotExists: true });

  pgm.addConstraint('nutrition_plan_meals', 'npm_metabolic_goal_check',
    "CHECK (metabolic_goal IS NULL OR metabolic_goal IN ('energy', 'recovery', 'satiety', 'sleep_light'))");

  pgm.addConstraint('nutrition_plan_meals', 'npm_workout_relation_check',
    "CHECK (workout_relation IS NULL OR workout_relation IN ('pre', 'post', 'none'))");

  // -------------------------------------------------------------------
  // 2. nutrition_meal_alternatives
  // -------------------------------------------------------------------
  pgm.createTable('nutrition_meal_alternatives', {
    id:          'id',
    meal_id:     { type: 'integer', notNull: true, references: '"nutrition_plan_meals"', onDelete: 'CASCADE' },
    description: { type: 'text', notNull: true },
    order_index: { type: 'smallint', notNull: true, default: 0 },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  }, { ifNotExists: true });

  pgm.createIndex('nutrition_meal_alternatives', ['meal_id'],
    { name: 'nma_meal_idx', ifNotExists: true });

  // -------------------------------------------------------------------
  // 3. nutrition_meal_checkins
  // -------------------------------------------------------------------
  pgm.createTable('nutrition_meal_checkins', {
    id:          { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), primaryKey: true },
    patient_id:  { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    plan_id:     { type: 'integer', notNull: true, references: '"nutrition_plans"', onDelete: 'CASCADE' },
    meal_id:     { type: 'integer', notNull: true, references: '"nutrition_plan_meals"', onDelete: 'CASCADE' },
    check_date:  { type: 'date', notNull: true },
    status:      { type: 'varchar(20)', notNull: true },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    satiety:     { type: 'smallint' },
    hunger:      { type: 'smallint' },
    energy:      { type: 'smallint' },
    note:        { type: 'text' },
  }, { ifNotExists: true });

  pgm.addConstraint('nutrition_meal_checkins', 'nmc_status_check',
    "CHECK (status IN ('done', 'partial', 'skipped', 'substituted', 'delayed'))");

  pgm.addConstraint('nutrition_meal_checkins', 'nmc_satiety_check',
    "CHECK (satiety IS NULL OR (satiety BETWEEN 1 AND 5))");

  pgm.addConstraint('nutrition_meal_checkins', 'nmc_hunger_check',
    "CHECK (hunger IS NULL OR (hunger BETWEEN 1 AND 5))");

  pgm.addConstraint('nutrition_meal_checkins', 'nmc_energy_check',
    "CHECK (energy IS NULL OR (energy BETWEEN 1 AND 5))");

  // One check-in per patient+meal+day
  pgm.addConstraint('nutrition_meal_checkins', 'nmc_one_per_day_unique',
    'UNIQUE (patient_id, meal_id, check_date)');

  pgm.createIndex('nutrition_meal_checkins', ['patient_id', 'check_date'],
    { name: 'nmc_patient_date_idx', ifNotExists: true });

  pgm.createIndex('nutrition_meal_checkins', ['plan_id'],
    { name: 'nmc_plan_idx', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('nutrition_meal_checkins', [], { name: 'nmc_plan_idx',         ifExists: true });
  pgm.dropIndex('nutrition_meal_checkins', [], { name: 'nmc_patient_date_idx', ifExists: true });
  pgm.dropConstraint('nutrition_meal_checkins', 'nmc_one_per_day_unique', { ifExists: true });
  pgm.dropConstraint('nutrition_meal_checkins', 'nmc_energy_check',       { ifExists: true });
  pgm.dropConstraint('nutrition_meal_checkins', 'nmc_hunger_check',       { ifExists: true });
  pgm.dropConstraint('nutrition_meal_checkins', 'nmc_satiety_check',      { ifExists: true });
  pgm.dropConstraint('nutrition_meal_checkins', 'nmc_status_check',       { ifExists: true });
  pgm.dropTable('nutrition_meal_checkins', { ifExists: true });

  pgm.dropIndex('nutrition_meal_alternatives', [], { name: 'nma_meal_idx', ifExists: true });
  pgm.dropTable('nutrition_meal_alternatives', { ifExists: true });

  pgm.dropConstraint('nutrition_plan_meals', 'npm_workout_relation_check', { ifExists: true });
  pgm.dropConstraint('nutrition_plan_meals', 'npm_metabolic_goal_check',   { ifExists: true });

  pgm.dropColumns('nutrition_plan_meals', [
    'supplement_note',
    'hydration_note',
    'workout_relation',
    'metabolic_goal',
    'reminder_minutes',
    'tolerance_minutes',
    'meal_time',
  ]);
};
