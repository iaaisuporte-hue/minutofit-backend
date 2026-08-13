/**
 * Metas de performance — o que faltava para elas funcionarem (Spec 033, P4).
 *
 * A tabela `user_performance_goals` já existe desde a P1 (migration
 * 1823000000000), criada com o desenho da spec e nunca escrita por código
 * nenhum: a P1 preparou o terreno, a P4 é quem planta. Esta migration não cria
 * tabela — ela conserta um CHECK e acrescenta as colunas sem as quais uma meta
 * não consegue responder "quanto falta?".
 *
 * ## 1. O CHECK que impedia excluir exercício (defeito latente da P1)
 *
 * A P1 gravou, junto:
 *
 *     exercise_id UUID REFERENCES exercises(id) ON DELETE SET NULL
 *     CHECK (kind NOT LIKE 'exercise\_%' OR exercise_id IS NOT NULL)
 *
 * As duas regras se contradizem. No dia em que alguém remove um exercício da
 * biblioteca, o SET NULL zera a coluna e o CHECK recusa a linha: o DELETE falha
 * inteiro, com erro de constraint sobre uma tabela que o admin nem sabia que
 * existia. Hoje não explode só porque não há uma linha sequer — a P4 é
 * exatamente o momento em que passa a haver.
 *
 * Este repo já pagou o mesmo padrão duas vezes: `workout_protocols` (migration
 * 1819000000000 — personal autônomo não salvava ficha alguma) e a exclusão de
 * conta (migration 1822000000000 — 12 FKs sem ação de delete, `DELETE
 * /api/user/account` respondendo 500 em 100% das contas).
 *
 * O predicado correto exige a **identidade histórica**, `exercise_name`, que é
 * justamente o que nunca some. "Chegar a 100 kg no supino" continua legível
 * depois de o supino sair do catálogo — o que a meta precisa contar é o nome,
 * não a chave.
 *
 * ## 2. Colunas novas
 *
 * - **`baseline_value`** — o ponto de partida, capturado na criação e nunca
 *   mais alterado. Sem ele "faltam 17,5 kg" é incalculável e a barra não tem
 *   denominador. Se o baseline acompanhasse o aluno, o progresso ficaria
 *   eternamente em zero.
 * - **`best_value`** — metas de carga medem o MELHOR já feito, não o último.
 *   Sem coluna própria, um treino leve depois de um pesado faria o progresso
 *   andar para trás. Quais tipos usam: `goals.engine.ts`.
 * - **`target_reps`** — o tipo `exercise_reps_at_load` ("30 kg × 12 reps") tem
 *   DOIS alvos. O CHECK amarra os dois lados para que ninguém grave uma meta de
 *   carga com um número de repetições pendurado que nenhum código lê.
 * - **`metric_version`** — congela a fórmula que deu origem ao alvo, para que
 *   uma meta antiga não mude de significado quando a fórmula evoluir.
 *
 * ## 3. Índice único parcial contra meta duplicada
 *
 * Duas metas ativas idênticas não são recurso: são a mesma intenção contada
 * duas vezes, que completariam juntas e dariam o bônus do Progress Score em
 * dobro. Parcial (`WHERE status = 'active'`) de propósito — repetir a meta
 * depois de concluí-la é legítimo, e é o caso comum de quem bateu 100 kg e
 * agora quer 110.
 *
 * ## Reversão
 *
 * O `down` devolve a tabela ao desenho da P1, **inclusive o CHECK defeituoso**:
 * reverter é voltar ao estado anterior, não a um estado melhor que nunca
 * existiu. Quem desfizer esta migration reencontra o defeito — e é isso que
 * torna a reversão fiel.
 */

const TABLE = 'user_performance_goals';
const CHK_EXERCISE = 'user_performance_goals_exercise_chk';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.${TABLE}') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD COLUMN IF NOT EXISTS baseline_value NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS best_value     NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS target_reps    SMALLINT,
      ADD COLUMN IF NOT EXISTS metric_version SMALLINT NOT NULL DEFAULT 1`);

  // Identidade histórica no lugar da chave estrangeira. Ver o bloco 1 do topo.
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHK_EXERCISE}`);
  await pgm.db.query(`
    UPDATE ${TABLE}
       SET exercise_name = COALESCE(exercise_name, 'Exercício')
     WHERE kind LIKE 'exercise\\_%' AND exercise_name IS NULL`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT ${CHK_EXERCISE} CHECK (
        (kind LIKE 'exercise\\_%' AND exercise_name IS NOT NULL)
        OR (kind NOT LIKE 'exercise\\_%' AND exercise_id IS NULL))`);

  // Tipo novo: "30 kg × 12 reps". A P1 fechou o enum sem ele.
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS user_performance_goals_kind_chk`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT user_performance_goals_kind_chk CHECK (kind IN (
        'weekly_frequency', 'monthly_frequency',
        'exercise_load', 'exercise_e1rm', 'exercise_reps_at_load', 'streak'))`);

  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS chk_perf_goal_reps`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT chk_perf_goal_reps CHECK (
        (kind = 'exercise_reps_at_load' AND target_reps IS NOT NULL AND target_reps BETWEEN 1 AND 100)
        OR (kind <> 'exercise_reps_at_load' AND target_reps IS NULL))`);

  // Data de conquista e status andam juntos: um sem o outro é uma meta que diz
  // ter sido atingida sem dizer quando, ou o contrário.
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS chk_perf_goal_achieved`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT chk_perf_goal_achieved CHECK (
        (status = 'achieved' AND achieved_at IS NOT NULL)
        OR (status <> 'achieved' AND achieved_at IS NULL))`);

  // A avaliação pós-treino busca metas ativas de UM exercício. Parcial porque
  // meta concluída nunca é reavaliada.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_goals_active_exercise
      ON ${TABLE} (user_id, exercise_id)
      WHERE status = 'active' AND exercise_id IS NOT NULL`);

  // COALESCE no nome cobre a meta cujo exercício já saiu do catálogo: sem ele,
  // NULL <> NULL deixaria duas metas órfãs idênticas escaparem do índice.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_perf_goal_active
      ON ${TABLE} (
        user_id, kind,
        COALESCE(exercise_id::text, exercise_name, ''),
        target_value,
        COALESCE(target_reps, 0))
      WHERE status = 'active'`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.${TABLE}') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`DROP INDEX IF EXISTS uniq_perf_goal_active`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_perf_goals_active_exercise`);

  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS chk_perf_goal_achieved`);
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS chk_perf_goal_reps`);

  // Metas do tipo novo não cabem no enum antigo: sem removê-las, o CHECK da P1
  // não pode ser recriado e o `down` falharia no meio.
  await pgm.db.query(`DELETE FROM ${TABLE} WHERE kind = 'exercise_reps_at_load'`);
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS user_performance_goals_kind_chk`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT user_performance_goals_kind_chk CHECK (kind IN (
        'weekly_frequency', 'monthly_frequency', 'exercise_load', 'exercise_e1rm', 'streak'))`);

  // Volta ao predicado da P1 — inclusive o defeito. Ver "Reversão" no topo.
  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHK_EXERCISE}`);
  await pgm.db.query(`DELETE FROM ${TABLE} WHERE kind LIKE 'exercise\\_%' AND exercise_id IS NULL`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT ${CHK_EXERCISE} CHECK (
        kind NOT LIKE 'exercise\\_%' OR exercise_id IS NOT NULL)`);

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      DROP COLUMN IF EXISTS metric_version,
      DROP COLUMN IF EXISTS target_reps,
      DROP COLUMN IF EXISTS best_value,
      DROP COLUMN IF EXISTS baseline_value`);
};
