import pool from '../config/database';

// Deprecated: tabela gerenciada pela migration 1747180000000_create_student_exercise_notes.js
// Mantida como no-op de segurança; remover após confirmar migration aplicada em produção.
export async function ensureStudentExerciseNotesSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_exercise_notes (
      id SERIAL PRIMARY KEY,
      personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id INTEGER REFERENCES academies(id) ON DELETE SET NULL,
      exercise_key VARCHAR(96),
      exercise_name VARCHAR(160) NOT NULL,
      kind VARCHAR(24) NOT NULL,
      note TEXT NOT NULL,
      severity SMALLINT,
      load_kg NUMERIC(6,2),
      reps VARCHAR(24),
      sets VARCHAR(24),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sxn_student_recent_idx
    ON student_exercise_notes (student_id, recorded_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sxn_student_exercise_idx
    ON student_exercise_notes (student_id, exercise_key, recorded_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sxn_personal_idx
    ON student_exercise_notes (personal_id, recorded_at DESC)
  `);
}
