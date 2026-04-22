import pool from '../config/database';

export async function ensureMetabolismSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_metabolism_snapshots (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date   DATE    NOT NULL,
      score           SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
      status          VARCHAR(10) NOT NULL,
      trend           VARCHAR(10) NOT NULL,
      factors         JSONB NOT NULL DEFAULT '[]',
      inputs          JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, snapshot_date)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_metab_snap_user_date
    ON user_metabolism_snapshots(user_id, snapshot_date DESC)
  `);
}
