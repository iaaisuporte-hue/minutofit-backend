import pool from '../config/database';

export async function ensureActivitySessionsSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_sessions (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_type    TEXT        NOT NULL,
      duration_seconds INTEGER     NOT NULL DEFAULT 0,
      distance_km      NUMERIC(8,3) NOT NULL DEFAULT 0,
      calories_estimated INTEGER   NOT NULL DEFAULT 0,
      avg_pace         NUMERIC(6,2) NOT NULL DEFAULT 0,
      intensity        TEXT,
      score            INTEGER,
      route_coordinates JSONB,
      validation_flag  BOOLEAN     NOT NULL DEFAULT FALSE,
      started_at       TIMESTAMPTZ NOT NULL,
      ended_at         TIMESTAMPTZ NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_user_created
    ON activity_sessions (user_id, created_at DESC)
  `);
}
