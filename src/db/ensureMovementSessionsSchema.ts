import pool from '../config/database';

export async function ensureMovementSessionsSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movement_sessions (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise_id      TEXT        NOT NULL,
      exercise_label   TEXT        NOT NULL DEFAULT '',
      rep_count        INTEGER     NOT NULL DEFAULT 0,
      avg_form_score   INTEGER     NOT NULL DEFAULT 0,
      best_rep_score   INTEGER     NOT NULL DEFAULT 0,
      worst_rep_score  INTEGER     NOT NULL DEFAULT 0,
      avg_symmetry     NUMERIC(5,2) NOT NULL DEFAULT 0,
      insight          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_movement_sessions_user_created
    ON movement_sessions (user_id, created_at DESC)
  `);
}
