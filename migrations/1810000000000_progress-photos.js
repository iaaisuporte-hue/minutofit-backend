/**
 * Fotos de Progresso (Spec 020).
 *
 * Registro visual de progresso corporal do aluno. Dado sensível (LGPD art. 11):
 * visível para personal E nutri SOMENTE com consent explícito `body_photos`.
 *
 * - progress_photos: metadados da foto + chave do objeto no S3. O binário vive
 *   no S3 (bucket privado); a coluna `storage_key` nunca guarda URL pública —
 *   leitura sempre por URL assinada curta gerada sob demanda.
 *
 * Sem `academy_id` (decisão consciente): é dado do usuário, não dado operacional
 * de academia. Isolamento por `user_id`; leitura profissional por consent.
 *
 * NÃO altera o enum `user_data_consents.scope`: `body_photos` já existe (1809) e
 * não está em nenhum default scope → consentimento explícito é garantido por
 * construção, sem backfill.
 */

const POSE_CHECK = `pose IS NULL OR pose IN ('front','side','back','other')`;
const STATUS_CHECK = `status IN ('active','deleted')`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS progress_photos (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key  VARCHAR(512) NOT NULL,
      content_type VARCHAR(64),
      byte_size    INTEGER,
      taken_at     DATE         NOT NULL DEFAULT CURRENT_DATE,
      pose         VARCHAR(16)  CHECK (${POSE_CHECK}),
      note         VARCHAR(280),
      status       VARCHAR(12)  NOT NULL DEFAULT 'active' CHECK (${STATUS_CHECK}),
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_progress_photos_user_status ON progress_photos (user_id, status)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_progress_photos_user_taken  ON progress_photos (user_id, taken_at DESC)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS progress_photos`);
};
