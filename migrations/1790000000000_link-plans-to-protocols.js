/**
 * Link assigned workout plans to their source protocols.
 *
 * Protocols become the reusable template source; personal_workout_plans remain
 * assigned snapshots. ON DELETE SET NULL preserves assigned history if a
 * personal protocol is removed from the library.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE personal_workout_plans
    ADD COLUMN IF NOT EXISTS source_protocol_id integer NULL
      REFERENCES workout_protocols(id) ON DELETE SET NULL
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_personal_workout_plans_source_protocol
    ON personal_workout_plans(source_protocol_id)
  `);

  pgm.sql(`
    ALTER TABLE workout_protocols
    ADD COLUMN IF NOT EXISTS days_json jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE workout_protocols DROP COLUMN IF EXISTS days_json`);
  pgm.sql(`DROP INDEX IF EXISTS idx_personal_workout_plans_source_protocol`);
  pgm.sql(`ALTER TABLE personal_workout_plans DROP COLUMN IF EXISTS source_protocol_id`);
};
