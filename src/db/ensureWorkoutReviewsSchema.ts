import pool from '../config/database';

export async function ensureWorkoutReviewsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_reviews (
      id SERIAL PRIMARY KEY,
      personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workout_plan_id INTEGER REFERENCES personal_workout_plans(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      goal VARCHAR(32) NOT NULL DEFAULT 'hipertrofia',
      status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'changes_requested', 'approved', 'archived')),
      risk VARCHAR(16) NOT NULL DEFAULT 'low'
        CHECK (risk IN ('low', 'medium', 'high')),
      priority VARCHAR(16) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high')),
      internal_notes TEXT,
      student_feedback TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_reviews_personal_status
    ON workout_reviews(personal_id, status, updated_at DESC)
  `);
}
