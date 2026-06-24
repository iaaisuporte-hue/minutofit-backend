/**
 * B2C Waitlist (Spec 013) — captura de interesse pré-lançamento do app do aluno.
 *
 * Trilho B2C "pronto, desligado": uma landing pública coleta e-mails de pessoas
 * interessadas no acompanhamento metabólico (B2C direto). Nenhuma aquisição ativa
 * roda no piloto — a lista só abastece o GTM B2C quando os critérios de escala
 * (piloto personal) forem batidos.
 *
 *  - email UNIQUE (lowercased) → idempotência: reinscrição não duplica.
 *  - Sem vínculo de tenant: é pré-auth, público, fora de qualquer academia.
 *  - PII mínima (só e-mail); nunca logar o corpo da request.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS b2c_waitlist (
      id          BIGSERIAL    PRIMARY KEY,
      email       TEXT         NOT NULL,
      source      TEXT         NOT NULL DEFAULT 'landing',
      referral    TEXT,
      interest    TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // Dedup por e-mail (case-insensitive — a rota grava sempre em lowercase).
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_b2c_waitlist_email
      ON b2c_waitlist (email)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS b2c_waitlist`);
};
