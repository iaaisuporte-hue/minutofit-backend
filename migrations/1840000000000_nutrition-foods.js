/**
 * SPEC 038 (P3A) — fundação nutricional estruturada: catálogo de alimentos
 * (TACO), medidas caseiras, alimento customizado do nutri, item de refeição
 * com SNAPSHOT dos nutrientes usados na prescrição.
 *
 * Tudo aditivo — `nutrition_plan_meals.orientation` continua existindo e
 * continua podendo ser a única coisa preenchida numa refeição.
 *
 * `nutrition_custom_foods.owner_nutri_id` é ON DELETE SET NULL seguindo o
 * MESMO desenho de `exercises.owner_personal_id` (migration
 * 1837000000000) — e a MESMA lição do bug de 02/ago documentado lá:
 * SOZINHO isso vazaria a linha como global-visível na exclusão de conta.
 * `accountDeletionService.ts` arquiva (`status='archived'`) antes do SET
 * NULL disparar, igual já faz para `exercises`.
 *
 * `nutrition_meal_items` usa soft-delete (`deleted_at`), mesmo padrão de
 * `nutrition_plan_meals` (migration 1839000000000) — editar uma refeição
 * nunca pode apagar histórico de item já prescrito.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── nutrition_foods (catálogo) ──────────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_foods (
      id                 SERIAL PRIMARY KEY,
      source             VARCHAR(20)  NOT NULL,
      source_id          VARCHAR(50)  NOT NULL,
      source_version     VARCHAR(50)  NOT NULL,
      name               VARCHAR(200) NOT NULL,
      normalized_name    VARCHAR(200) NOT NULL,
      category           VARCHAR(80),
      reference_amount_g NUMERIC(8,2) NOT NULL DEFAULT 100,
      energy_kcal        NUMERIC(8,2) NOT NULL,
      protein_g          NUMERIC(8,2) NOT NULL,
      carbohydrate_g     NUMERIC(8,2) NOT NULL,
      fat_g              NUMERIC(8,2) NOT NULL,
      fiber_g            NUMERIC(8,2),
      sodium_mg          NUMERIC(10,2),
      is_active          BOOLEAN NOT NULL DEFAULT true,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_foods DROP CONSTRAINT IF EXISTS nutrition_foods_source_uq
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_foods ADD CONSTRAINT nutrition_foods_source_uq UNIQUE (source, source_id)
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_foods DROP CONSTRAINT IF EXISTS chk_nutrition_foods_ranges
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_foods ADD CONSTRAINT chk_nutrition_foods_ranges CHECK (
      energy_kcal BETWEEN 0 AND 950 AND
      protein_g BETWEEN 0 AND 100 AND
      carbohydrate_g BETWEEN 0 AND 100 AND
      fat_g BETWEEN 0 AND 100 AND
      (fiber_g IS NULL OR fiber_g BETWEEN 0 AND 100) AND
      (sodium_mg IS NULL OR sodium_mg BETWEEN 0 AND 50000) AND
      reference_amount_g > 0
    )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_foods_normalized_name
      ON nutrition_foods (normalized_name) WHERE is_active
  `);

  // ── nutrition_food_measures ─────────────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_food_measures (
      id         SERIAL PRIMARY KEY,
      food_id    INTEGER NOT NULL REFERENCES nutrition_foods(id) ON DELETE CASCADE,
      name       VARCHAR(80) NOT NULL,
      grams      NUMERIC(8,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_food_measures DROP CONSTRAINT IF EXISTS chk_nutrition_food_measures_grams
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_food_measures ADD CONSTRAINT chk_nutrition_food_measures_grams CHECK (grams > 0)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_food_measures_food ON nutrition_food_measures (food_id)
  `);

  // ── nutrition_custom_foods (alimento próprio do nutri) ──────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_custom_foods (
      id                 SERIAL PRIMARY KEY,
      owner_nutri_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name               VARCHAR(200) NOT NULL,
      normalized_name    VARCHAR(200) NOT NULL,
      brand              VARCHAR(120),
      notes              VARCHAR(300),
      reference_amount_g NUMERIC(8,2) NOT NULL DEFAULT 100,
      energy_kcal        NUMERIC(8,2) NOT NULL,
      protein_g          NUMERIC(8,2) NOT NULL,
      carbohydrate_g     NUMERIC(8,2) NOT NULL,
      fat_g              NUMERIC(8,2) NOT NULL,
      fiber_g            NUMERIC(8,2),
      sodium_mg          NUMERIC(10,2),
      status             VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_foods DROP CONSTRAINT IF EXISTS chk_nutrition_custom_foods_status
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_foods ADD CONSTRAINT chk_nutrition_custom_foods_status
      CHECK (status IN ('active', 'archived'))
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_foods DROP CONSTRAINT IF EXISTS chk_nutrition_custom_foods_ranges
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_foods ADD CONSTRAINT chk_nutrition_custom_foods_ranges CHECK (
      energy_kcal BETWEEN 0 AND 950 AND
      protein_g BETWEEN 0 AND 100 AND
      carbohydrate_g BETWEEN 0 AND 100 AND
      fat_g BETWEEN 0 AND 100 AND
      (fiber_g IS NULL OR fiber_g BETWEEN 0 AND 100) AND
      (sodium_mg IS NULL OR sodium_mg BETWEEN 0 AND 50000) AND
      reference_amount_g > 0
    )
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS nutrition_custom_foods_owner_name_uq
      ON nutrition_custom_foods (owner_nutri_id, normalized_name) WHERE status = 'active'
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_custom_foods_owner ON nutrition_custom_foods (owner_nutri_id)
  `);

  // ── nutrition_custom_food_measures ──────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_custom_food_measures (
      id              SERIAL PRIMARY KEY,
      custom_food_id  INTEGER NOT NULL REFERENCES nutrition_custom_foods(id) ON DELETE CASCADE,
      name            VARCHAR(80) NOT NULL,
      grams           NUMERIC(8,2) NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_food_measures DROP CONSTRAINT IF EXISTS chk_nutrition_custom_food_measures_grams
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_custom_food_measures ADD CONSTRAINT chk_nutrition_custom_food_measures_grams CHECK (grams > 0)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_custom_food_measures_food
      ON nutrition_custom_food_measures (custom_food_id)
  `);

  // ── nutrition_meal_items ─────────────────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_meal_items (
      id                     SERIAL PRIMARY KEY,
      meal_id                INTEGER NOT NULL REFERENCES nutrition_plan_meals(id) ON DELETE CASCADE,
      food_id                INTEGER REFERENCES nutrition_foods(id) ON DELETE SET NULL,
      custom_food_id         INTEGER REFERENCES nutrition_custom_foods(id) ON DELETE SET NULL,
      quantity               NUMERIC(8,2) NOT NULL,
      unit_type              VARCHAR(10)  NOT NULL,
      measure_id             INTEGER REFERENCES nutrition_food_measures(id) ON DELETE SET NULL,
      custom_measure_id      INTEGER REFERENCES nutrition_custom_food_measures(id) ON DELETE SET NULL,
      grams                  NUMERIC(8,2) NOT NULL,
      order_index            SMALLINT NOT NULL DEFAULT 0,
      notes                  VARCHAR(200),
      food_name_snapshot     VARCHAR(200) NOT NULL,
      energy_kcal_snapshot   NUMERIC(8,2) NOT NULL,
      protein_g_snapshot     NUMERIC(8,2) NOT NULL,
      carbohydrate_g_snapshot NUMERIC(8,2) NOT NULL,
      fat_g_snapshot         NUMERIC(8,2) NOT NULL,
      fiber_g_snapshot       NUMERIC(8,2),
      sodium_mg_snapshot     NUMERIC(10,2),
      deleted_at             TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items DROP CONSTRAINT IF EXISTS chk_nutrition_meal_items_food_xor
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items ADD CONSTRAINT chk_nutrition_meal_items_food_xor CHECK (
      (food_id IS NOT NULL)::int + (custom_food_id IS NOT NULL)::int = 1
    )
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items DROP CONSTRAINT IF EXISTS chk_nutrition_meal_items_unit_type
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items ADD CONSTRAINT chk_nutrition_meal_items_unit_type
      CHECK (unit_type IN ('grams', 'measure'))
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items DROP CONSTRAINT IF EXISTS chk_nutrition_meal_items_quantity
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_meal_items ADD CONSTRAINT chk_nutrition_meal_items_quantity
      CHECK (quantity > 0 AND grams > 0)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_meal_items_meal_active
      ON nutrition_meal_items (meal_id) WHERE deleted_at IS NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_meal_items`);
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_custom_food_measures`);
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_custom_foods`);
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_food_measures`);
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_foods`);
};
