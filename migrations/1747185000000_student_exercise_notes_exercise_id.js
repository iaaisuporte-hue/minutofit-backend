/**
 * Adiciona coluna exercise_id UUID opcional na tabela student_exercise_notes.
 * Migração gradual: exercise_key (legado) permanece; exercise_id é preenchido
 * pelo script backfillWorkoutPlanExerciseIds.ts.
 *
 * Idempotente: IF NOT EXISTS protege contra execução em BDs onde
 * a coluna/índice já existem.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE student_exercise_notes
    ADD COLUMN IF NOT EXISTS exercise_id uuid
      REFERENCES exercises(id) ON DELETE SET NULL
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS student_notes_exercise_id_idx
    ON student_exercise_notes (exercise_id)
    WHERE exercise_id IS NOT NULL
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS student_notes_exercise_id_idx`);
  pgm.dropColumn('student_exercise_notes', 'exercise_id');
};
