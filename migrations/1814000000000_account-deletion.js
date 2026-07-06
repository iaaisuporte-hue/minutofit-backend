/**
 * Exclusão e Exportação de Conta (Spec 025 · Fase 1a store readiness · Frente 1.4 LGPD).
 *
 * Blocker de loja (Apple 5.1.1v / Google Play data deletion) + direito de exclusão
 * LGPD art. 18. Duas mudanças de schema:
 *
 * 1. Tombstone `account_deletions`: prova de exclusão SEM PII (email só como hash),
 *    para auditoria/fisco/chargeback. Sem FK (o usuário deixa de existir).
 *
 * 2. Anonimização financeira: `payments` e `user_subscriptions` referenciam
 *    users(id) com ON DELETE CASCADE + user_id NOT NULL. Se cascateassem no delete,
 *    perderíamos histórico financeiro (obrigação fiscal ~5 anos). Tornamos user_id
 *    NULLABLE e adicionamos colunas de anonimização; o serviço de exclusão faz
 *    UPDATE ... SET user_id=NULL (desvincula PII) ANTES do DELETE FROM users, então
 *    o CASCADE não toca essas linhas — valores/datas/status/gateway_id ficam.
 *
 * Nota de escopo: as tabelas de cobrança aluno→personal (student_subscriptions,
 * personal_student_subscriptions) seguem cascateando por ora (billing V1 congelado,
 * cobrança fora da plataforma). Anonimizá-las é follow-up quando o billing reabrir.
 */

const FIN_TABLES = ['payments', 'user_subscriptions'];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS account_deletions (
      id                       SERIAL PRIMARY KEY,
      user_id                  INTEGER      NOT NULL,
      email_hash               VARCHAR(64)  NOT NULL,
      requested_by             VARCHAR(12)  NOT NULL DEFAULT 'self' CHECK (requested_by IN ('self','admin')),
      reason                   VARCHAR(120),
      storage_objects_deleted  INTEGER      NOT NULL DEFAULT 0,
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  for (const t of FIN_TABLES) {
    await pgm.db.query(`ALTER TABLE ${t} ALTER COLUMN user_id DROP NOT NULL`);
    await pgm.db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ`);
    await pgm.db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS anonymized_user_hash VARCHAR(64)`);
  }
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  for (const t of FIN_TABLES) {
    await pgm.db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS anonymized_user_hash`);
    await pgm.db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS anonymized_at`);
    // Não restauramos NOT NULL: linhas anonimizadas podem ter user_id NULL.
  }
  await pgm.db.query(`DROP TABLE IF EXISTS account_deletions`);
};
