/**
 * Relaxes FK constraints on "physical content" tables so users can be hard-deleted
 * without losing the artifacts they produced or that were produced for them.
 *
 * Tables affected:
 *  - personal_workout_plans (student_id, personal_id)
 *  - student_exercise_notes (student_id, personal_id)
 *  - workout_reviews (student_id, personal_id)
 *
 * Before: NOT NULL + ON DELETE CASCADE → deleting any referenced user wiped the
 *         workout plans / notes / reviews tied to them.
 * After:  NULLABLE + ON DELETE SET NULL → row survives the user deletion as an
 *         orphan record with a NULL pointer, so the historical content remains.
 */

const TARGETS = [
  { table: 'personal_workout_plans', cols: ['student_id', 'personal_id'] },
  { table: 'student_exercise_notes', cols: ['student_id', 'personal_id'] },
  { table: 'workout_reviews',        cols: ['student_id', 'personal_id'] },
];

exports.up = async (pgm) => {
  for (const { table, cols } of TARGETS) {
    for (const col of cols) {
      // Drop existing FK constraint (name follows pg default: {table}_{col}_fkey)
      pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${col}_fkey`);
      // Allow NULL
      pgm.sql(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`);
      // Recreate FK with SET NULL
      pgm.sql(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_${col}_fkey
        FOREIGN KEY (${col}) REFERENCES users(id) ON DELETE SET NULL
      `);
    }
  }
};

exports.down = async (pgm) => {
  // Down is best-effort; rows that became NULL stay NULL (cannot be reattributed).
  for (const { table, cols } of TARGETS) {
    for (const col of cols) {
      pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${col}_fkey`);
      pgm.sql(`DELETE FROM ${table} WHERE ${col} IS NULL`);
      pgm.sql(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`);
      pgm.sql(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_${col}_fkey
        FOREIGN KEY (${col}) REFERENCES users(id) ON DELETE CASCADE
      `);
    }
  }
};
