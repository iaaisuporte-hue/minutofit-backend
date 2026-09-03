/**
 * Alternativas de substituição definidas pelo Personal (Sprint P2A, D3).
 *
 * Estrutura MÍNIMA para o motor de sugestões ter onde LER o tier
 * `PERSONAL_DEFINED` — nenhum endpoint de escrita nasce nesta sprint (não há
 * caso de uso definido ainda para o Personal cadastrar isso manualmente,
 * ver FUTURE_WORK do harness `docs/sprints/P2A_SMART_EXERCISE_SUBSTITUTION.md`).
 * A tabela nasce vazia e o motor degrada graciosamente: o tier
 * `PERSONAL_DEFINED` simplesmente não tem candidatos até uma sprint futura
 * implementar a gestão.
 *
 * `personal_id` é o dono da relação, não do exercício — o mesmo par
 * (original, alternativa) pode ser cadastrado por personais diferentes com
 * pesos/preferências distintos, por isso entra na UNIQUE em vez de bastar
 * (original, alternativa). CASCADE nos três lados: se o exercício original,
 * o alternativo ou o personal saírem do sistema, a linha de alternativa não
 * tem mais sentido — não é execução real como `workout_set_logs`, é só uma
 * preferência de catálogo.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS exercise_replacement_alternatives (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      original_exercise_id    UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      alternative_exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      personal_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pgm.db.query(`
    ALTER TABLE exercise_replacement_alternatives
      DROP CONSTRAINT IF EXISTS exercise_replacement_alternatives_uq,
      DROP CONSTRAINT IF EXISTS exercise_replacement_alternatives_distinct_chk`);

  await pgm.db.query(`
    ALTER TABLE exercise_replacement_alternatives
      ADD CONSTRAINT exercise_replacement_alternatives_uq
        UNIQUE (original_exercise_id, alternative_exercise_id, personal_id),
      -- Um exercício não é "alternativa de si mesmo" — sem isto, um dado
      -- malformado (cópia/colar do mesmo id nos dois campos) entraria como
      -- linha válida e o motor sugeriria trocar o exercício por ele mesmo.
      ADD CONSTRAINT exercise_replacement_alternatives_distinct_chk
        CHECK (original_exercise_id <> alternative_exercise_id)`);

  // Padrão de leitura do motor (FILTER_RULES + tier PERSONAL_DEFINED): dado
  // um exercício original e o personal "dono do contexto" do viewer
  // (resolvido por `resolveViewerPersonalId`), buscar as alternativas dele.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_exercise_replacement_alternatives_lookup
      ON exercise_replacement_alternatives (original_exercise_id, personal_id)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS exercise_replacement_alternatives`);
};
