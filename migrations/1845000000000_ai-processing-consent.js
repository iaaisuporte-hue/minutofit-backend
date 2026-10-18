/**
 * Consentimento do titular para tratamento de dados por IA de terceiros (Spec 039).
 *
 * Apple 5.1.2(i) exige divulgar e obter permissão EXPLÍCITA antes de compartilhar dado
 * pessoal com IA de terceiro; a LGPD (art. 11, I) exige consentimento específico e
 * destacado para dado de saúde. O aceite dos Termos no cadastro não cobre nenhum dos dois.
 *
 * Três colunas em `users`, no mesmo molde do aceite de termos (migration 1815):
 *  - ai_processing_consent_at         quando concedeu (NULL = nunca concedeu)
 *  - ai_processing_consent_version    versão da Política de IA aceita, carimbada pelo
 *                                     SERVIDOR (`CURRENT_AI_POLICY_VERSION`)
 *  - ai_processing_revoked_at         quando revogou. O consentimento só vale se
 *                                     concedido, na versão vigente e não revogado depois
 *                                     do último aceite.
 *
 * Sem backfill, de propósito: NULL significa "não consentiu". Inferir consentimento a
 * partir de `accepted_terms_at` seria exatamente o que a regra proíbe.
 *
 * Por que não um novo escopo em `user_data_consents`: aquela tabela é por PAR
 * profissional↔aluno (`professional_id NOT NULL`), o escopo tem CHECK enumerado, e o
 * consentimento de IA é do titular perante a plataforma — vale também quando o próprio
 * aluno usa a IA, sem profissional nenhum.
 *
 * Aditiva e reversível. Quem consentiu e revogou fica no `data_access_audit`.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_processing_consent_at TIMESTAMPTZ`);
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_processing_consent_version VARCHAR(20)`);
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_processing_revoked_at TIMESTAMPTZ`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS ai_processing_revoked_at`);
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS ai_processing_consent_version`);
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS ai_processing_consent_at`);
};
