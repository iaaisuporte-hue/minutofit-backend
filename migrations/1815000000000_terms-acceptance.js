/**
 * Aceite de Termos de Uso + Política de Privacidade no cadastro (LGPD art. 8º).
 *
 * Blocker de Go Live: até aqui o cadastro B2C (POST /auth/register) não registrava
 * NENHUM aceite — não havia coluna em `users`, nem versionamento. A base legal do
 * tratamento de dados (inclusive dados sensíveis de saúde) ficava sem prova.
 *
 * Três colunas em `users` (evidência de aceite): quando aceitou, qual versão dos
 * termos vigia, e de qual IP. A versão é carimbada pelo SERVIDOR (constante
 * `CURRENT_TERMS_VERSION`) — o cliente não a escolhe. Nullable: usuários OAuth e
 * cadastros feitos por terceiros (academia/personal) confirmam no 1º login
 * (follow-up), então null = aceite ainda pendente, não erro.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMPTZ`);
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20)`);
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_ip INET`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS accepted_terms_ip`);
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS terms_version`);
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS accepted_terms_at`);
};
