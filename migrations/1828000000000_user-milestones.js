/**
 * Marcos pessoais (Spec 034, Onda C1).
 *
 * ## O que é um marco
 *
 * Uma conquista **determinística** derivada de fatos que o produto já registra:
 * a primeira sessão, o primeiro recorde real, quatro semanas consistentes. Não
 * é badge decorativa nem coleção — é o registro auditável de que algo
 * aconteceu, com a evidência que permite reproduzir a conta à mão.
 *
 * ## Por que UNIQUE(user_id, code) é a peça central
 *
 * O marco vale uma vez por pessoa. Com o UNIQUE, "já ganhou?" deixa de ser
 * lógica de aplicação — é o banco que recusa a segunda concessão, e o engine
 * pode reprocessar quantas vezes quiser. É a mesma escolha que tornou a
 * conclusão de meta idempotente na P4 e o XP idempotente na C0: a defesa mora
 * na constraint, não na disciplina de quem escreve o próximo caller.
 *
 * ## `evidence_json` não é enfeite
 *
 * Guarda os números que sustentam a concessão (ids de sessão, datas, contagens,
 * a janela avaliada). Sem isso, um marco concedido por engano é indefensável:
 * ninguém consegue dizer POR QUE ele apareceu. Com isso, a auditoria é uma
 * consulta. Só entram fatos do próprio titular — nada clínico, nada de
 * terceiros.
 *
 * ## `shared_at` nasce NULL de propósito
 *
 * Privado por padrão. A coluna existe agora, sem consumidor social, porque a
 * INTENÇÃO explícita do titular é o dado — e ela precisa estar registrada antes
 * de qualquer superfície que a leia (C2+). Um marco nunca vaza por default.
 */

const TABLE = 'user_milestones';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code          TEXT NOT NULL,
      unlocked_at   TIMESTAMPTZ NOT NULL,
      evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      shared_at     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      DROP CONSTRAINT IF EXISTS user_milestones_user_code_uq`);

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT user_milestones_user_code_uq UNIQUE (user_id, code)`);

  // A leitura da aba Marcos é sempre "os meus, do mais recente para o mais
  // antigo" — o índice serve exatamente essa pergunta.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_user_milestones_user_unlocked
      ON ${TABLE} (user_id, unlocked_at DESC)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS ${TABLE}`);
};
