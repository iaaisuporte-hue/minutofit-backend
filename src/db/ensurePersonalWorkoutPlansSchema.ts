import pool from '../config/database';

export async function ensurePersonalWorkoutPlansSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_workout_plans (
      id SERIAL PRIMARY KEY,
      personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      week_preset VARCHAR(32) NOT NULL DEFAULT '5',
      selected_group VARCHAR(64),
      payload_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_personal_workout_plans_pair_created
    ON personal_workout_plans(personal_id, student_id, created_at DESC)
  `);
}
