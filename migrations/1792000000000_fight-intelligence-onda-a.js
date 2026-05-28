/**
 * Spec 006 — Fight Intelligence (MaaS Sports Engine, Onda A)
 * Novas tabelas: user_sport_profile, athlete_pre_workout_checkin,
 *                athlete_competition_camp, athlete_readiness_snapshot
 * Altera: user_data_consents.scope CHECK (adiciona 'sports')
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── Sport Profile — declaração esportiva do usuário ────────────────────────
  pgm.createTable('user_sport_profile', {
    user_id: {
      type: 'integer',
      primaryKey: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    primary_sport:    { type: 'text', notNull: true },
    sport_level:      { type: 'text', notNull: true, default: 'intermediate' },
    graduation_rank:  { type: 'text', notNull: false },
    weekly_frequency: { type: 'integer', notNull: true, default: 3 },
    competes:         { type: 'boolean', notNull: true, default: false },
    primary_goal:     { type: 'text', notNull: true, default: 'performance' },
    current_weight_kg: { type: 'numeric(5,2)', notNull: false },
    target_weight_kg:  { type: 'numeric(5,2)', notNull: false },
    coach_name:       { type: 'text', notNull: false },
    nutri_name:       { type: 'text', notNull: false },
    active:           { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── Pre-workout check-in — sinais esportivos pré-treino ───────────────────
  pgm.createTable('athlete_pre_workout_checkin', {
    id:      { type: 'serial', primaryKey: true },
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    checkin_date:        { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    sleep_quality:       { type: 'integer', notNull: true },
    energy_level:        { type: 'integer', notNull: true },
    muscle_soreness:     { type: 'integer', notNull: true },
    joint_soreness:      { type: 'integer', notNull: true },
    stress_level:        { type: 'integer', notNull: true },
    hydration_ok:        { type: 'boolean', notNull: true, default: true },
    weight_kg:           { type: 'numeric(5,2)', notNull: false },
    motivation:          { type: 'integer', notNull: true },
    perceived_readiness: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_sleep_quality',
    'CHECK (sleep_quality BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_energy_level',
    'CHECK (energy_level BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_muscle_soreness',
    'CHECK (muscle_soreness BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_joint_soreness',
    'CHECK (joint_soreness BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_stress_level',
    'CHECK (stress_level BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_motivation',
    'CHECK (motivation BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'chk_apwc_perceived_readiness',
    'CHECK (perceived_readiness BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_pre_workout_checkin',
    'uq_athlete_checkin_per_day',
    'UNIQUE (user_id, checkin_date)',
  );
  pgm.createIndex('athlete_pre_workout_checkin', ['user_id', 'checkin_date'], {
    name: 'idx_athlete_checkin_user_date',
  });

  // ── Competition Camp — preparação para competição ─────────────────────────
  pgm.createTable('athlete_competition_camp', {
    id:      { type: 'serial', primaryKey: true },
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    event_name:       { type: 'text', notNull: true },
    event_date:       { type: 'date', notNull: true },
    category:         { type: 'text', notNull: false },
    target_weight_kg: { type: 'numeric(5,2)', notNull: false },
    weeks_planned:    { type: 'integer', notNull: false },
    status: {
      type: 'text',
      notNull: true,
      default: 'planning',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'athlete_competition_camp',
    'chk_acc_status',
    "CHECK (status IN ('planning','active','completed','cancelled'))",
  );
  pgm.createIndex('athlete_competition_camp', ['user_id', 'status'], {
    name: 'idx_camp_user_status',
  });

  // ── Readiness Snapshot — cache do readiness diário ────────────────────────
  pgm.createTable('athlete_readiness_snapshot', {
    id:      { type: 'serial', primaryKey: true },
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    snapshot_date:   { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    metabolic_score: { type: 'integer', notNull: true },
    sport_modifier:  { type: 'integer', notNull: true, default: 0 },
    final_score:     { type: 'integer', notNull: true },
    sport_factors:   { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    recommendation:  { type: 'text', notNull: true },
    risk_level:      { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'athlete_readiness_snapshot',
    'chk_ars_risk_level',
    "CHECK (risk_level IN ('low','moderate','high'))",
  );
  pgm.addConstraint(
    'athlete_readiness_snapshot',
    'uq_readiness_per_day',
    'UNIQUE (user_id, snapshot_date)',
  );
  pgm.createIndex('athlete_readiness_snapshot', ['user_id', 'snapshot_date'], {
    name: 'idx_readiness_user_date',
  });

  // ── user_data_consents — adicionar escopo 'sports' ────────────────────────
  pgm.dropConstraint('user_data_consents', 'user_data_consents_scope_check', { ifExists: true });
  pgm.addConstraint(
    'user_data_consents',
    'user_data_consents_scope_check',
    `CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','parq_anamnese',
      'activity_logs','chat_history','sports'
    ))`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Restaura CHECK sem 'sports' (apenas se não há dados com esse scope)
  pgm.dropConstraint('user_data_consents', 'user_data_consents_scope_check', { ifExists: true });
  pgm.addConstraint(
    'user_data_consents',
    'user_data_consents_scope_check',
    `CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','parq_anamnese',
      'activity_logs','chat_history'
    ))`,
  );

  pgm.dropTable('athlete_readiness_snapshot');
  pgm.dropTable('athlete_competition_camp');
  pgm.dropTable('athlete_pre_workout_checkin');
  pgm.dropTable('user_sport_profile');
};
