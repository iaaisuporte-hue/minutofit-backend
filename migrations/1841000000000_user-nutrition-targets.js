/**
 * PLAN_NUTRITION_QUICK_MACROS (P1A) — meta diária de macros do aluno.
 *
 * Uma linha por usuário (`UNIQUE(user_id)`): a estimativa própria não tem
 * histórico no P1, só o valor atual. `source` está pronto para 'nutri' (meta
 * manual definida pelo profissional) mas o P1 só grava 'self_estimate' — o
 * enum existe para não exigir migration futura, não para uso imediato.
 *
 * A meta REAL exibida ao aluno (plano do nutri vs. estimativa própria) é
 * resolvida na leitura por `resolveNutritionTarget` — esta tabela guarda só
 * a estimativa própria, nunca uma cópia do plano.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_nutrition_targets (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source           VARCHAR(20) NOT NULL DEFAULT 'self_estimate',
      energy_kcal      NUMERIC(8,2) NOT NULL,
      protein_g        NUMERIC(8,2) NOT NULL,
      carbohydrate_g   NUMERIC(8,2) NOT NULL,
      fat_g            NUMERIC(8,2) NOT NULL,
      meals_per_day    SMALLINT NOT NULL DEFAULT 4,
      formula_version  SMALLINT NOT NULL DEFAULT 1,
      inputs           JSONB NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets DROP CONSTRAINT IF EXISTS user_nutrition_targets_user_uq
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets ADD CONSTRAINT user_nutrition_targets_user_uq UNIQUE (user_id)
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets DROP CONSTRAINT IF EXISTS chk_user_nutrition_targets_source
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets ADD CONSTRAINT chk_user_nutrition_targets_source
      CHECK (source IN ('self_estimate', 'nutri'))
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets DROP CONSTRAINT IF EXISTS chk_user_nutrition_targets_meals_per_day
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets ADD CONSTRAINT chk_user_nutrition_targets_meals_per_day
      CHECK (meals_per_day BETWEEN 3 AND 6)
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets DROP CONSTRAINT IF EXISTS chk_user_nutrition_targets_ranges
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_targets ADD CONSTRAINT chk_user_nutrition_targets_ranges CHECK (
      energy_kcal BETWEEN 800 AND 6000 AND
      protein_g >= 0 AND
      carbohydrate_g >= 0 AND
      fat_g >= 0
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS user_nutrition_targets`);
};
