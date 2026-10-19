/**
 * S2CORE NUTRI P1 (Spec 040) — suplementação nutricional.
 *
 * Duas tabelas de propósito (decisão do usuário, 19/10/2026):
 *  - `nutrition_supplement_prescriptions`: a ORIENTAÇÃO do nutri. Sem DELETE
 *    no produto — suspender/encerrar muda `status`, o histórico fica.
 *  - `nutrition_supplement_usage_logs`: o USO declarado pelo aluno. Sem
 *    nutrientes e fora de `user_nutrition_intake_logs`: registrar uso nunca
 *    soma macro ao diário nem conta como refeição na cobertura.
 *
 * Nenhuma dose padrão: `dose_amount` é sempre o que o nutri digitou.
 * `created_by`/`updated_by` são SET NULL — o nutri excluir a conta não pode
 * apagar a orientação do paciente nem travar o DELETE (lição da 1822).
 *
 * Sem backfill. O `supplement_note` das refeições do plano segue intacto.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_supplement_prescriptions (
      id                SERIAL PRIMARY KEY,
      patient_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name              VARCHAR(120) NOT NULL,
      dose_amount       NUMERIC(8,2) NOT NULL,
      dose_unit         VARCHAR(20) NOT NULL,
      frequency         VARCHAR(30) NOT NULL,
      frequency_detail  VARCHAR(80),
      timing            VARCHAR(80),
      purpose           VARCHAR(200),
      notes             VARCHAR(1000),
      start_date        DATE,
      end_date          DATE,
      status            VARCHAR(20) NOT NULL DEFAULT 'active',
      status_changed_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const checks = [
    ['chk_nsp_name', `CHECK (length(btrim(name)) > 0)`],
    ['chk_nsp_dose', `CHECK (dose_amount > 0 AND dose_amount <= 10000)`],
    ['chk_nsp_unit', `CHECK (dose_unit IN ('g', 'mg', 'mcg', 'ml', 'ui', 'capsule', 'tablet', 'scoop', 'drops', 'sachet', 'dose'))`],
    ['chk_nsp_frequency', `CHECK (frequency IN ('daily', 'twice_daily', 'three_times_daily', 'weekly', 'as_needed', 'other'))`],
    ['chk_nsp_status', `CHECK (status IN ('active', 'suspended', 'ended'))`],
    ['chk_nsp_dates', `CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)`],
  ];
  for (const [name, def] of checks) {
    await pgm.db.query(`ALTER TABLE nutrition_supplement_prescriptions DROP CONSTRAINT IF EXISTS ${name}`);
    await pgm.db.query(`ALTER TABLE nutrition_supplement_prescriptions ADD CONSTRAINT ${name} ${def}`);
  }
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nsp_patient_status ON nutrition_supplement_prescriptions (patient_id, status)
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS nutrition_supplement_usage_logs (
      id              SERIAL PRIMARY KEY,
      prescription_id INTEGER NOT NULL REFERENCES nutrition_supplement_prescriptions(id) ON DELETE CASCADE,
      patient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key        DATE NOT NULL,
      taken_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note            VARCHAR(200),
      client_key      VARCHAR(64),
      deleted_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nsul_patient_client_key
      ON nutrition_supplement_usage_logs (patient_id, client_key)
      WHERE client_key IS NOT NULL
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nsul_prescription_taken
      ON nutrition_supplement_usage_logs (prescription_id, taken_at DESC)
      WHERE deleted_at IS NULL
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_nsul_patient_date
      ON nutrition_supplement_usage_logs (patient_id, date_key DESC)
      WHERE deleted_at IS NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_supplement_usage_logs`);
  await pgm.db.query(`DROP TABLE IF EXISTS nutrition_supplement_prescriptions`);
};
