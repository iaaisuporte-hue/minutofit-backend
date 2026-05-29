/**
 * Spec 007 — Fight Intelligence (Onda B)
 * Nova tabela: athlete_post_workout_checkin
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('athlete_post_workout_checkin', {
    id: { type: 'serial', primaryKey: true },
    user_id: {
      type: 'integer',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    checkin_date: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    duration_min: { type: 'smallint', notNull: true },
    workout_type: { type: 'varchar(20)', notNull: true },
    rpe: { type: 'smallint', notNull: true },
    muscle_soreness_post: { type: 'smallint', notNull: true },
    joint_soreness_post: { type: 'smallint', notNull: true },
    estimated_load: { type: 'numeric(5,2)', notNull: false },
    recovery_gap: { type: 'numeric(6,2)', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'chk_apwc_duration_min',
    'CHECK (duration_min BETWEEN 1 AND 480)',
  );
  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'chk_apwc_rpe',
    'CHECK (rpe BETWEEN 1 AND 10)',
  );
  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'chk_apwc_muscle_soreness',
    'CHECK (muscle_soreness_post BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'chk_apwc_joint_soreness',
    'CHECK (joint_soreness_post BETWEEN 1 AND 5)',
  );
  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'chk_apwc_workout_type',
    `CHECK (workout_type IN ('sparring','technical','physical','competition','other'))`,
  );

  pgm.addConstraint(
    'athlete_post_workout_checkin',
    'uq_post_checkin_per_day',
    'UNIQUE (user_id, checkin_date)',
  );

  pgm.createIndex('athlete_post_workout_checkin', ['user_id', 'checkin_date'], {
    name: 'idx_post_checkin_user_date',
    order: { checkin_date: 'DESC' },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('athlete_post_workout_checkin');
};
