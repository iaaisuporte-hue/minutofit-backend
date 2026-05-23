/**
 * Aluno pode "abandonar" uma ficha sem que ela seja excluída.
 *
 * - Só o personal pode excluir a ficha (DELETE em personal_workout_plans).
 * - O aluno pode marcar como abandonada → some do `GET /my/workout-plans`,
 *   mas o personal continua vendo (com badge) e pode reativar.
 * - Reativar = setar `abandoned_at = NULL`.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE personal_workout_plans
      ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ NULL
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_personal_workout_plans_active
      ON personal_workout_plans(student_id)
      WHERE abandoned_at IS NULL
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_personal_workout_plans_active`);
  pgm.sql(`ALTER TABLE personal_workout_plans DROP COLUMN IF EXISTS abandoned_at`);
};
