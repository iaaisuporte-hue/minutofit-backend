/**
 * Adiciona coluna exercise_id UUID opcional na tabela student_exercise_notes.
 * Migração gradual: exercise_key (legado) permanece; exercise_id é preenchido
 * pelo script backfillWorkoutPlanExerciseIds.ts.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('student_exercise_notes', {
    exercise_id: {
      type: 'uuid',
      notNull: false,
      references: '"exercises"',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('student_exercise_notes', 'exercise_id', {
    name: 'student_notes_exercise_id_idx',
    where: 'exercise_id IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('student_exercise_notes', 'exercise_id', {
    name: 'student_notes_exercise_id_idx',
  });
  pgm.dropColumn('student_exercise_notes', 'exercise_id');
};
