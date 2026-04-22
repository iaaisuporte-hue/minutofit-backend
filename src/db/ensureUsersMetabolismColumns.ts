import pool from '../config/database';

const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm SMALLINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(5,2)`,
];

export async function ensureUsersMetabolismColumns(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}
