/**
 * Varredura de Objetos Órfãos no Storage (Spec 023 — residual LGPD da Frente 1.4).
 *
 * `storage_orphans`: rastro DURÁVEL de todo objeto de storage cuja deleção falhou
 * (falha transitória de rede/R2, ou storage não configurado no momento). Antes
 * essas falhas viravam só log (admin user-delete) ou eram engolidas em silêncio
 * (deletePhoto do aluno) → foto corporal órfã no R2 para sempre. Agora um job
 * (storageOrphanSweep) re-tenta os `pending` até apagar de verdade.
 *
 * Tabela de OPERAÇÃO — sem `academy_id`, sem isolamento por tenant. Não é lida por
 * profissional nem aluno; só pelo job e (opcional) pelo admin em forma agregada.
 * A `storage_key` embute o `user_id` no path; não guardamos PII adicional.
 */

const STATUS_CHECK = `status IN ('pending','resolved','abandoned')`;
const REASON_CHECK = `reason IN ('admin_user_delete','student_delete','storage_not_configured')`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS storage_orphans (
      id          SERIAL PRIMARY KEY,
      storage_key VARCHAR(512) NOT NULL,
      reason      VARCHAR(40)  NOT NULL CHECK (${REASON_CHECK}),
      context     JSONB,
      attempts    INTEGER      NOT NULL DEFAULT 0,
      last_error  TEXT,
      status      VARCHAR(12)  NOT NULL DEFAULT 'pending' CHECK (${STATUS_CHECK}),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);

  // Dedup: no máximo 1 linha PENDENTE por storage_key (produtor usa ON CONFLICT DO NOTHING).
  await pgm.db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_orphans_pending_key
       ON storage_orphans (storage_key) WHERE status = 'pending'`,
  );
  // Varredura do job: pega os pendentes rápido.
  await pgm.db.query(
    `CREATE INDEX IF NOT EXISTS idx_storage_orphans_pending
       ON storage_orphans (status) WHERE status = 'pending'`,
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS storage_orphans`);
};
