/**
 * Spec 005 Onda B — Substitution tracking
 * Adds substituted_alternative_id to nutrition_meal_checkins so that when
 * a patient marks a meal as 'substituted', the chosen alternative is recorded.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('nutrition_meal_checkins', {
    substituted_alternative_id: {
      type: 'integer',
      notNull: false,
      references: '"nutrition_meal_alternatives"',
      onDelete: 'SET NULL',
    },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('nutrition_meal_checkins', 'substituted_alternative_id');
};
