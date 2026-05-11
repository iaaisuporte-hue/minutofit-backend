import pool from '../config/database';

export async function ensurePersonalDashboardIndexes() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_personal_student_assignments_personal_status
    ON personal_student_assignments(personal_id, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_workout_logs_user_completed
    ON user_workout_logs(user_id, completed_at DESC)
  `);
}
