/**
 * Spec 008 — Adaptive Training Engine (MaaS)
 * Novas tabelas:
 *   user_readiness_snapshot     — cache diário da lente de prontidão (nível verde/amarelo/vermelho)
 *   training_adaptation_policy  — limites configurados pelo Personal por aluno (default OFF)
 *   workout_adaptation_log      — trilha imutável de adaptações aplicadas (policy_snapshot congelado)
 *
 * IMPORTANTE: user_readiness_snapshot NÃO tem coluna de score (CLAUDE.md: Score Metabólico é único).
 * training_adaptation_policy NÃO tem campos de aumento de carga (CREF: só reduce é representável).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── 1. user_readiness_snapshot ───────────────────────────────────────────
  pgm.createTable('user_readiness_snapshot', {
    id:            { type: 'serial', primaryKey: true },
    user_id:       { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    snapshot_date: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    level:         { type: 'text', notNull: true },
    factors:       { type: 'jsonb', notNull: true, default: "'[]'::jsonb" },
    created_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('user_readiness_snapshot', 'chk_readiness_level',
    "CHECK (level IN ('green','yellow','red'))");
  pgm.addConstraint('user_readiness_snapshot', 'uq_readiness_user_date',
    'UNIQUE (user_id, snapshot_date)');
  pgm.createIndex('user_readiness_snapshot', ['user_id', 'snapshot_date'],
    { name: 'idx_readiness_snap_user_date' });

  // ── 2. training_adaptation_policy ───────────────────────────────────────
  pgm.createTable('training_adaptation_policy', {
    id:         { type: 'serial', primaryKey: true },
    personal_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    student_id:  { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    academy_id:  { type: 'integer', notNull: false, references: '"academies"', onDelete: 'SET NULL' },
    version:     { type: 'integer', notNull: true, default: 1 },
    // master switch — OFF by default (CREF safety)
    master_enabled:                     { type: 'boolean', notNull: true, default: false },
    allow_volume_reduction:             { type: 'boolean', notNull: true, default: false },
    allow_rest_increase:                { type: 'boolean', notNull: true, default: false },
    allow_intensity_reduction:          { type: 'boolean', notNull: true, default: false },
    allow_active_recovery_substitution: { type: 'boolean', notNull: true, default: false },
    allow_mobility_suggestion:          { type: 'boolean', notNull: true, default: false },
    // numeric clamps (caps, not targets; no "max_increase" field exists — by design)
    max_set_reduction_pct: { type: 'integer', notNull: true, default: 25 },
    max_rest_increase_pct: { type: 'integer', notNull: true, default: 30 },
    min_intensity_pct:     { type: 'integer', notNull: true, default: 70 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('training_adaptation_policy', 'chk_tap_set_pct',
    'CHECK (max_set_reduction_pct BETWEEN 0 AND 50)');
  pgm.addConstraint('training_adaptation_policy', 'chk_tap_rest_pct',
    'CHECK (max_rest_increase_pct BETWEEN 0 AND 60)');
  pgm.addConstraint('training_adaptation_policy', 'chk_tap_intensity_pct',
    'CHECK (min_intensity_pct BETWEEN 50 AND 100)');
  pgm.addConstraint('training_adaptation_policy', 'uq_policy_personal_student',
    'UNIQUE (personal_id, student_id)');
  pgm.createIndex('training_adaptation_policy', ['student_id'],
    { name: 'idx_policy_student' });
  pgm.createIndex('training_adaptation_policy', ['academy_id'],
    { name: 'idx_policy_academy' });

  // ── 3. workout_adaptation_log ───────────────────────────────────────────
  pgm.createTable('workout_adaptation_log', {
    id:           { type: 'serial', primaryKey: true },
    student_id:   { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    personal_id:  { type: 'integer', notNull: true, references: '"users"' },
    academy_id:   { type: 'integer', notNull: false, references: '"academies"', onDelete: 'SET NULL' },
    plan_id:      { type: 'integer', notNull: true, references: '"personal_workout_plans"', onDelete: 'CASCADE' },
    day_index:    { type: 'integer', notNull: true },
    snapshot_date:    { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    readiness_level:  { type: 'text', notNull: true },
    readiness_factors:{ type: 'jsonb', notNull: true, default: "'[]'::jsonb" },
    policy_version:   { type: 'integer', notNull: true },
    policy_snapshot:  { type: 'jsonb', notNull: true },
    original_payload: { type: 'jsonb', notNull: true },
    adapted_payload:  { type: 'jsonb', notNull: true },
    changes:          { type: 'jsonb', notNull: true, default: "'[]'::jsonb" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('workout_adaptation_log', 'chk_wal_level',
    "CHECK (readiness_level IN ('green','yellow','red'))");
  pgm.addConstraint('workout_adaptation_log', 'uq_log_student_plan_day_date',
    'UNIQUE (student_id, plan_id, day_index, snapshot_date)');
  pgm.createIndex('workout_adaptation_log', ['student_id', 'snapshot_date'],
    { name: 'idx_adap_log_student_date' });
  pgm.createIndex('workout_adaptation_log', ['personal_id', 'snapshot_date'],
    { name: 'idx_adap_log_personal_date' });
  pgm.createIndex('workout_adaptation_log', ['academy_id'],
    { name: 'idx_adap_log_academy' });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('workout_adaptation_log');
  pgm.dropTable('training_adaptation_policy');
  pgm.dropTable('user_readiness_snapshot');
};
