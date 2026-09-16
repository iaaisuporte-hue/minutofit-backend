/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B) — registro rápido de refeição do aluno.
 *
 * `items` JSONB nunca contém item não resolvido — o service rejeita antes de
 * chegar aqui (400), e um teste de contrato garante. `confidence_score` é
 * SEMPRE derivado no servidor a partir dos pesos do resolver (catalog/
 * measure/plan=1.00, manual=0.80, ai confirmada=0.70) — nunca aceito do
 * cliente, mesma disciplina de "backend recalcula, nunca confia no client"
 * já usada em `nutritionTarget.ts` (P1A).
 *
 * Sem coluna de cobertura do dia: cobertura/confiança do dia são derivadas
 * na leitura (P1C, `nutritionIntake.ts`) — aqui só a linha do log.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_nutrition_intake_logs (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key         DATE NOT NULL,
      logged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meal_id          INTEGER REFERENCES nutrition_plan_meals(id) ON DELETE SET NULL,
      label            VARCHAR(80) NOT NULL,
      raw_text         VARCHAR(300),
      energy_kcal      NUMERIC(8,2) NOT NULL,
      protein_g        NUMERIC(8,2) NOT NULL,
      carbohydrate_g   NUMERIC(8,2) NOT NULL,
      fat_g            NUMERIC(8,2) NOT NULL,
      items            JSONB NOT NULL DEFAULT '[]',
      confidence_score NUMERIC(3,2) NOT NULL,
      source           VARCHAR(16) NOT NULL,
      is_favorite      BOOLEAN NOT NULL DEFAULT false,
      deleted_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs DROP CONSTRAINT IF EXISTS chk_nutrition_intake_logs_source
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs ADD CONSTRAINT chk_nutrition_intake_logs_source
      CHECK (source IN ('parse', 'parse_ai', 'manual', 'repeat', 'favorite', 'plan'))
  `);

  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs DROP CONSTRAINT IF EXISTS chk_nutrition_intake_logs_ranges
  `);
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs ADD CONSTRAINT chk_nutrition_intake_logs_ranges CHECK (
      energy_kcal >= 0 AND energy_kcal <= 5000 AND
      protein_g >= 0 AND carbohydrate_g >= 0 AND fat_g >= 0 AND
      confidence_score >= 0 AND confidence_score <= 1
    )
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_intake_logs_user_day
      ON user_nutrition_intake_logs (user_id, date_key) WHERE deleted_at IS NULL
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_intake_logs_user_favorite
      ON user_nutrition_intake_logs (user_id) WHERE is_favorite AND deleted_at IS NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS user_nutrition_intake_logs`);
};
