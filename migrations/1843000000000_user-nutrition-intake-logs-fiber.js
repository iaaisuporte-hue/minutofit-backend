/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B — adendo "Seu dia nutricional").
 *
 * Fibra nunca foi persistida em `user_nutrition_intake_logs` — a
 * investigação do adendo achou exatamente o que ele temia: o item já
 * calcula fibra via `calculateNutrition` (SPEC 038), mas `persistIntakeLog`
 * descartava o valor antes de somar. `fiber_g` fica NULLABLE (nem todo
 * alimento do catálogo tem fibra medida) e `fiber_partial` marca quando
 * ALGUM item do log não tinha fibra conhecida — mesma semântica de
 * `NutrientTotals.fiberPartial` em `nutritionCalculation.ts`. Sem meta de
 * fibra em lugar nenhum: o adendo pede quantidade registrada, nunca uma
 * meta inventada.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs
      ADD COLUMN IF NOT EXISTS fiber_g NUMERIC(8,2),
      ADD COLUMN IF NOT EXISTS fiber_partial BOOLEAN NOT NULL DEFAULT false
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs
      DROP COLUMN IF EXISTS fiber_g,
      DROP COLUMN IF EXISTS fiber_partial
  `);
};
