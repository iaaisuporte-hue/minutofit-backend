/**
 * S2CORE NUTRI P0 (Spec 039) — metas diárias prescritas pelo nutri.
 *
 * Tabela própria (decisão do usuário, 19/10/2026), e não colunas em
 * `nutrition_plans` nem `source='nutri'` em `user_nutrition_targets`:
 *  - a meta pertence ao PACIENTE e sobrevive a novas versões do plano (e a
 *    paciente sem plano nenhum);
 *  - `user_nutrition_targets` tem UNIQUE(user_id) — gravar a meta do nutri
 *    ali apagaria a estimativa própria do aluno.
 *
 * Uma linha por paciente (UNIQUE). Toda coluna de meta é NULL = "sem meta
 * para este nutriente" — nunca zero. `max` só existe com `min`; valor único
 * é só o `min`. Água em ml (a UI fala em litros). `objectives` reusa o enum
 * de `nutrition_plans.objective`.
 *
 * `updated_by` é SET NULL: o nutri excluir a própria conta não pode apagar a
 * prescrição do paciente nem travar o DELETE (lição da migration 1822).
 *
 * Sem backfill: nenhuma meta é inventada para paciente existente.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_patient_goals (
      id             SERIAL PRIMARY KEY,
      patient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      energy_kcal    NUMERIC(7,1),
      protein_min_g  NUMERIC(6,1),
      protein_max_g  NUMERIC(6,1),
      fiber_min_g    NUMERIC(6,1),
      fiber_max_g    NUMERIC(6,1),
      water_min_ml   INTEGER,
      water_max_ml   INTEGER,
      objectives     TEXT[] NOT NULL DEFAULT '{}',
      patient_note   VARCHAR(500),
      updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals DROP CONSTRAINT IF EXISTS nutrition_patient_goals_patient_uq
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals ADD CONSTRAINT nutrition_patient_goals_patient_uq UNIQUE (patient_id)
  `);

  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals DROP CONSTRAINT IF EXISTS chk_npg_ranges
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals ADD CONSTRAINT chk_npg_ranges CHECK (
      (energy_kcal IS NULL OR energy_kcal BETWEEN 800 AND 6000) AND
      (protein_min_g IS NULL OR (protein_min_g > 0 AND protein_min_g <= 400)) AND
      (protein_max_g IS NULL OR (protein_max_g > 0 AND protein_max_g <= 400)) AND
      (fiber_min_g IS NULL OR (fiber_min_g > 0 AND fiber_min_g <= 100)) AND
      (fiber_max_g IS NULL OR (fiber_max_g > 0 AND fiber_max_g <= 100)) AND
      (water_min_ml IS NULL OR water_min_ml BETWEEN 500 AND 8000) AND
      (water_max_ml IS NULL OR water_max_ml BETWEEN 500 AND 8000)
    )
  `);

  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals DROP CONSTRAINT IF EXISTS chk_npg_min_max
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals ADD CONSTRAINT chk_npg_min_max CHECK (
      (protein_max_g IS NULL OR (protein_min_g IS NOT NULL AND protein_min_g <= protein_max_g)) AND
      (fiber_max_g IS NULL OR (fiber_min_g IS NOT NULL AND fiber_min_g <= fiber_max_g)) AND
      (water_max_ml IS NULL OR (water_min_ml IS NOT NULL AND water_min_ml <= water_max_ml))
    )
  `);

  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals DROP CONSTRAINT IF EXISTS chk_npg_has_goal
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals ADD CONSTRAINT chk_npg_has_goal CHECK (
      energy_kcal IS NOT NULL OR protein_min_g IS NOT NULL OR
      fiber_min_g IS NOT NULL OR water_min_ml IS NOT NULL
    )
  `);

  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals DROP CONSTRAINT IF EXISTS chk_npg_objectives
  `);
  await pgm.db.query(`
    ALTER TABLE nutrition_patient_goals ADD CONSTRAINT chk_npg_objectives CHECK (
      cardinality(objectives) <= 3 AND
      objectives <@ ARRAY['weight_loss', 'muscle_gain', 'metabolic_health', 'performance', 'maintenance']::text[]
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_patient_goals`);
};
