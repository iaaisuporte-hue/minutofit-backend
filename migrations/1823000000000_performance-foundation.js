/**
 * Fundação do módulo Performance (Spec 033, Onda P1).
 *
 * ## O que falta hoje
 *
 * A execução do treino já é rica desde a Spec 010: `workout_set_logs` guarda
 * reps, carga e RPE por série. O que nunca existiu é a camada que responde
 * "o aluno está evoluindo?" — recordes, consistência, metas e score. Esta
 * migration cria as quatro tabelas dessa camada. Só a primeira é escrita nesta
 * onda pelo caminho quente (write-through do `createSession`); as outras três
 * ficam prontas para as ondas P2–P4 e são preenchidas por elas.
 *
 * ## Por que satélite, e não colunas em `workout_sessions`
 *
 * `workout_sessions` é append-only e imutável por decisão de produto. Métricas
 * derivadas mudam quando a FÓRMULA muda — e aí precisam ser recomputadas. Numa
 * tabela satélite isso é `DELETE WHERE formula_version < N` + reprocesso, sem
 * encostar no histórico de execução. Cada linha carrega `formula_version`
 * justamente para permitir esse recomputo seletivo.
 *
 * ## Quatro desvios conscientes do texto da spec
 *
 * 1. **`session_id` é INTEGER, não BIGINT.** `workout_sessions.id` é SERIAL
 *    (integer) — a spec dizia BIGINT. FK com tipo divergente funciona no
 *    Postgres, mas obriga cast em todo JOIN e desperdiça o índice. Espelhar o
 *    tipo referenciado é o correto.
 *
 * 2. **`tonnage_kg` e `value` são NUMERIC(12,2), não (10,2).** Os clamps do
 *    `workoutSessionService` permitem 999 reps × 9999,99 kg × 200 séries, o que
 *    dá ~2e9 — acima do teto de NUMERIC(10,2) (~1e8). Como o INSERT acontece
 *    DENTRO da transação que grava o treino, um overflow não devolveria só um
 *    erro: derrubaria a sessão inteira e o aluno perderia o treino que acabou
 *    de fazer. É exatamente a classe de defeito que `clampReps`/`clampLoadKg`
 *    já corrigiram. A coluna precisa caber no que os clamps deixam entrar.
 *
 * 3. **`user_pr_events` ganha UNIQUE (user_id, exercise_id, kind, value).**
 *    A spec descreve o ledger como "monotônico por construção" (só insere quando
 *    supera o melhor atual), o que torna a tupla única por definição. Encodar
 *    isso como constraint dá idempotência REAL de graça — ao backfill aqui e à
 *    detecção online da P2 ("zero duplicado" é critério de aceite dela). O
 *    índice dessa constraint também serve a busca do recorde atual, então o
 *    índice `(user_id, exercise_id, kind, value DESC)` da spec fica redundante
 *    e não é criado (btree lê para trás sem custo).
 *
 * 4. **`user_pr_events.exercise_id` é NULLABLE com ON DELETE SET NULL**, e não
 *    NOT NULL com CASCADE como a spec dizia.
 *
 *    Um recorde pertence ao ALUNO, não ao catálogo. Com CASCADE, remover uma
 *    linha da biblioteca global de exercícios apagaria a marca que o aluno
 *    conquistou — e o repo tem uma duplicação conhecida de `exercises` cuja
 *    limpeza um dia vai deletar linhas. `workout_set_logs.exercise_id` já
 *    resolveu isso do jeito certo (SET NULL, migration 1802), preservando o
 *    histórico com o `exercise_name` guardado na própria linha; aqui é o mesmo
 *    problema e passa a ser a mesma resposta.
 *
 *    **Efeito no UNIQUE:** no Postgres, NULL não é igual a NULL num índice
 *    único (NULLS DISTINCT é o padrão). Depois que o exercício some, as linhas
 *    órfãs deixam de ser cobertas pela constraint — e está certo assim: ela
 *    existe para garantir idempotência enquanto o exercício VIVE (é o período
 *    em que backfill e detecção online escrevem). Sem exercício não há mais o
 *    que detectar, então o ledger apenas repousa: legível e imutável.
 *    `NULLS NOT DISTINCT` seria pior — colapsaria recordes de exercícios
 *    excluídos DIFERENTES que por acaso compartilhassem `(kind, value)`.
 *
 *    O backfill também não ressuscita nem duplica esses eventos: ele lê de
 *    `workout_set_logs` filtrando `exercise_id IS NOT NULL`, e essas séries
 *    ficaram com NULL pela mesma cascata. Reexecutá-lo é seguro.
 *
 * ## Backfill
 *
 * Reconstrói `workout_session_metrics` e `user_pr_events` para 100% das sessões
 * `completed`/`partial` já existentes, num `INSERT ... SELECT` só.
 *
 * ATENÇÃO PARA A ONDA P2: o ledger de PR fica CONGELADO entre P1 e P2 — nada
 * escreve nele depois deste backfill, porque a detecção online é escopo da P2.
 * Antes de ligar a detecção, reexecute este backfill; senão o "melhor atual"
 * lido do ledger estará defasado e a primeira sessão que superar o recorde
 * antigo emitirá um PR falso. O INSERT é idempotente e pode rodar populado.
 *
 * Volume atual é pequeno e a operação roda em segundos. Snapshots NÃO são
 * backfillados: seriam fotografias fabricadas de dias que ninguém mediu — o
 * histórico de score começa honestamente vazio.
 */

/** Versão das fórmulas gravadas por esta migration. Ver docs/performance-formulas.md. */
const FORMULA_VERSION = 1;

async function tableExists(pgm, table) {
  const r = await pgm.db.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
  return r.rows[0]?.oid != null;
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── 1. Métricas por sessão (satélite 1:1) ─────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS workout_session_metrics (
      session_id          INTEGER PRIMARY KEY REFERENCES workout_sessions(id) ON DELETE CASCADE,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      performed_at        TIMESTAMPTZ NOT NULL,
      sets_done           SMALLINT NOT NULL,
      reps_total          INTEGER NOT NULL,
      tonnage_kg          NUMERIC(12,2),
      duration_min        SMALLINT,
      srpe                SMALLINT,
      effort_load         NUMERIC(10,2),
      effort_load_method  TEXT,
      formula_version     SMALLINT NOT NULL DEFAULT 1,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // CHECKs em statement separado + DROP antes de ADD: o CREATE TABLE tem
  // IF NOT EXISTS, então numa tabela pré-existente as constraints inline seriam
  // silenciosamente puladas.
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      DROP CONSTRAINT IF EXISTS workout_session_metrics_method_chk`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      ADD CONSTRAINT workout_session_metrics_method_chk
      CHECK (effort_load_method IS NULL OR effort_load_method IN ('srpe_duration','srpe_sets'))`);
  // effort_load e o método andam juntos: um sem o outro é linha inconsistente.
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      DROP CONSTRAINT IF EXISTS workout_session_metrics_load_pair_chk`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      ADD CONSTRAINT workout_session_metrics_load_pair_chk
      CHECK ((effort_load IS NULL) = (effort_load_method IS NULL))`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      DROP CONSTRAINT IF EXISTS workout_session_metrics_duration_chk`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      ADD CONSTRAINT workout_session_metrics_duration_chk
      CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 240)`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      DROP CONSTRAINT IF EXISTS workout_session_metrics_srpe_chk`);
  await pgm.db.query(`
    ALTER TABLE workout_session_metrics
      ADD CONSTRAINT workout_session_metrics_srpe_chk
      CHECK (srpe IS NULL OR srpe BETWEEN 1 AND 10)`);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_wsm_user_performed
      ON workout_session_metrics (user_id, performed_at DESC)`);

  // ── 2. Ledger de recordes (append-only) ───────────────────────────────────
  //
  // `exercise_id` é NULLABLE com ON DELETE SET NULL — ver desvio 4 no topo.
  // O recorde é do ALUNO, não do catálogo: apagar um exercício da biblioteca
  // não pode apagar a marca que ele conquistou. `exercise_name` é NOT NULL e
  // preserva o contexto histórico quando o vínculo se perde.
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_pr_events (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise_id     UUID REFERENCES exercises(id) ON DELETE SET NULL,
      exercise_name   TEXT NOT NULL,
      kind            TEXT NOT NULL,
      value           NUMERIC(12,2) NOT NULL,
      reps            SMALLINT,
      load_kg         NUMERIC(6,2),
      previous_value  NUMERIC(12,2),
      is_first        BOOLEAN NOT NULL DEFAULT false,
      session_id      INTEGER REFERENCES workout_sessions(id) ON DELETE CASCADE,
      achieved_at     TIMESTAMPTZ NOT NULL,
      formula_version SMALLINT NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE user_pr_events DROP CONSTRAINT IF EXISTS user_pr_events_kind_chk`);
  await pgm.db.query(`
    ALTER TABLE user_pr_events
      ADD CONSTRAINT user_pr_events_kind_chk
      CHECK (kind IN ('max_load','best_e1rm','session_volume','max_reps'))`);
  // Idempotência real do ledger — ver desvio 3 no topo do arquivo.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_events_user_exercise_kind_value
      ON user_pr_events (user_id, exercise_id, kind, value)`);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pr_events_user_created
      ON user_pr_events (user_id, created_at DESC)`);

  // ── 3. Metas do aluno (P4 usa; criada aqui para fechar a fundação) ────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_performance_goals (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      exercise_id   UUID REFERENCES exercises(id) ON DELETE SET NULL,
      exercise_name TEXT,
      target_value  NUMERIC(8,2) NOT NULL,
      unit          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      starts_on     DATE NOT NULL,
      due_on        DATE,
      achieved_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals DROP CONSTRAINT IF EXISTS user_performance_goals_kind_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals
      ADD CONSTRAINT user_performance_goals_kind_chk
      CHECK (kind IN ('weekly_frequency','monthly_frequency','exercise_load','exercise_e1rm','streak'))`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals DROP CONSTRAINT IF EXISTS user_performance_goals_unit_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals
      ADD CONSTRAINT user_performance_goals_unit_chk
      CHECK (unit IN ('sessions','kg','days'))`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals DROP CONSTRAINT IF EXISTS user_performance_goals_status_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals
      ADD CONSTRAINT user_performance_goals_status_chk
      CHECK (status IN ('active','achieved','abandoned','expired'))`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals DROP CONSTRAINT IF EXISTS user_performance_goals_target_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals
      ADD CONSTRAINT user_performance_goals_target_chk CHECK (target_value > 0)`);
  // Meta de exercício sem exercício é meta sem sujeito.
  await pgm.db.query(`
    ALTER TABLE user_performance_goals DROP CONSTRAINT IF EXISTS user_performance_goals_exercise_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_goals
      ADD CONSTRAINT user_performance_goals_exercise_chk
      CHECK (kind NOT LIKE 'exercise\\_%' OR exercise_id IS NOT NULL)`);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_goals_user_status
      ON user_performance_goals (user_id, status)`);

  // ── 4. Snapshots do Progress Score (P3 usa) ───────────────────────────────
  // Espelha user_metabolism_snapshots, com duas diferenças deliberadas:
  // `score` é NULLABLE (null = "ainda não dá para dizer", nunca 0) e há
  // `formula_version` (o motor metabólico não tem, e por isso não sabe quais
  // snapshots vieram de qual fórmula).
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_performance_snapshots (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date   DATE NOT NULL,
      score           SMALLINT,
      status          TEXT NOT NULL,
      trend           TEXT NOT NULL DEFAULT 'stable',
      factors         JSONB NOT NULL DEFAULT '[]',
      inputs          JSONB NOT NULL DEFAULT '{}',
      formula_version SMALLINT NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, snapshot_date)
    )
  `);
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots DROP CONSTRAINT IF EXISTS user_performance_snapshots_status_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots
      ADD CONSTRAINT user_performance_snapshots_status_chk
      CHECK (status IN ('onboarding','ok'))`);
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots DROP CONSTRAINT IF EXISTS user_performance_snapshots_score_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots
      ADD CONSTRAINT user_performance_snapshots_score_chk
      CHECK (score IS NULL OR score BETWEEN 0 AND 100)`);
  // Invariante do produto: score exibido SEMPRE vem com breakdown. Um score
  // sem fator seria o "número mágico" que a decisão de produto proíbe.
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots DROP CONSTRAINT IF EXISTS user_performance_snapshots_factors_chk`);
  await pgm.db.query(`
    ALTER TABLE user_performance_snapshots
      ADD CONSTRAINT user_performance_snapshots_factors_chk
      CHECK (score IS NULL OR jsonb_array_length(factors) > 0)`);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_snap_user_date
      ON user_performance_snapshots (user_id, snapshot_date DESC)`);

  // ── 5. Backfill de métricas ───────────────────────────────────────────────
  // Só sessões com ao menos uma série 'done': métrica de sessão sem execução
  // seria zero artificial poluindo qualquer média futura.
  //
  // `duration_min`: hoje o cliente registra a sessão inteira no fim, então
  // started_at = ended_at = performed_at e a duração real é desconhecida
  // (0 segundos). NULL é a resposta honesta — e é por isso que effort_load tem
  // o fallback por séries. Quando existir um "iniciar treino" de verdade, a
  // coluna passa a ser preenchida sem mudança de schema.
  await pgm.db.query(
    `
    WITH agg AS (
      SELECT sl.session_id,
             COUNT(*) FILTER (WHERE sl.status = 'done')::int AS sets_done,
             COALESCE(SUM(sl.reps_done) FILTER (WHERE sl.status = 'done'), 0)::int AS reps_total,
             SUM(sl.reps_done * sl.load_done_kg)
               FILTER (WHERE sl.status = 'done'
                         AND sl.load_done_kg IS NOT NULL
                         AND sl.reps_done IS NOT NULL) AS tonnage_kg,
             ROUND(AVG(sl.rpe) FILTER (WHERE sl.status = 'done' AND sl.rpe IS NOT NULL)) AS avg_rpe
        FROM workout_set_logs sl
       GROUP BY sl.session_id
    ),
    base AS (
      SELECT ws.id AS session_id,
             ws.user_id,
             ws.performed_at,
             a.sets_done,
             a.reps_total,
             -- CASE, e não LEAST direto: no Postgres LEAST(NULL, x) devolve
             -- x, porque LEAST IGNORA nulos. Sem esta guarda, todo treino de
             -- peso corporal (tonelagem legitimamente NULL) era gravado com
             -- ~1e10 kg — número fabricado que iria alimentar o fator de volume
             -- do Progress Score na P3.
             CASE WHEN a.tonnage_kg IS NULL THEN NULL
                  ELSE LEAST(a.tonnage_kg, 9999999999.99) END AS tonnage_kg,
             CASE
               WHEN ws.is_retroactive THEN NULL
               WHEN ws.ended_at IS NULL THEN NULL
               WHEN EXTRACT(EPOCH FROM (ws.ended_at - ws.started_at)) < 60 THEN NULL
               ELSE LEAST(240, GREATEST(5,
                      ROUND(EXTRACT(EPOCH FROM (ws.ended_at - ws.started_at)) / 60)))
             END::smallint AS duration_min,
             COALESCE(ws.session_rpe, a.avg_rpe)::smallint AS srpe
        FROM workout_sessions ws
        JOIN agg a ON a.session_id = ws.id
       WHERE ws.status IN ('completed', 'partial')
         AND a.sets_done > 0
    )
    INSERT INTO workout_session_metrics
      (session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg,
       duration_min, srpe, effort_load, effort_load_method, formula_version)
    SELECT session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg,
           duration_min, srpe,
           CASE WHEN srpe IS NULL THEN NULL
                WHEN duration_min IS NOT NULL THEN srpe * duration_min
                ELSE srpe * sets_done * 4 END,
           CASE WHEN srpe IS NULL THEN NULL
                WHEN duration_min IS NOT NULL THEN 'srpe_duration'
                ELSE 'srpe_sets' END,
           $1
      FROM base
    ON CONFLICT (session_id) DO NOTHING
  `,
    [FORMULA_VERSION],
  );

  // ── 6. Backfill de recordes ───────────────────────────────────────────────
  // Uma passada só: agrega o melhor de cada sessão por exercício, empilha as
  // quatro categorias, e emite evento onde o valor supera o máximo ANTERIOR
  // (janela até a linha anterior). `is_first` marca a estreia, que não é
  // recorde — não celebra nem pontua.
  //
  // e1RM (Epley) só entre 1 e 12 reps: acima disso a extrapolação degrada e
  // viraria número inventado. Arredondado a 0,5 kg.
  //
  // `max_reps` só para séries SEM carga (peso corporal) — com carga, quem mede
  // progresso é o e1RM.
  //
  // reps/load_kg (contexto) ficam NULL no backfill: reconstruí-los exigiria
  // localizar a série exata de cada recorde, e o valor em si já é preciso. A
  // detecção online da P2 preenche o contexto.
  await pgm.db.query(
    `
    WITH per_session AS (
      SELECT ws.user_id,
             sl.exercise_id,
             MIN(sl.exercise_name) AS exercise_name,
             ws.id AS session_id,
             ws.performed_at,
             MAX(sl.load_done_kg) FILTER (WHERE sl.load_done_kg > 0) AS max_load,
             MAX(ROUND((sl.load_done_kg * (1 + sl.reps_done / 30.0)) * 2) / 2)
               FILTER (WHERE sl.load_done_kg > 0 AND sl.reps_done BETWEEN 1 AND 12) AS best_e1rm,
             SUM(sl.reps_done * sl.load_done_kg)
               FILTER (WHERE sl.load_done_kg > 0 AND sl.reps_done IS NOT NULL) AS session_volume,
             MAX(sl.reps_done) FILTER (WHERE sl.load_done_kg IS NULL AND sl.reps_done > 0) AS max_reps
        FROM workout_set_logs sl
        JOIN workout_sessions ws ON ws.id = sl.session_id
       WHERE sl.status = 'done'
         AND sl.exercise_id IS NOT NULL
         AND ws.status IN ('completed', 'partial')
       GROUP BY ws.user_id, sl.exercise_id, ws.id, ws.performed_at
    ),
    stacked AS (
      SELECT user_id, exercise_id, exercise_name, session_id, performed_at,
             'max_load' AS kind, max_load AS value
        FROM per_session WHERE max_load IS NOT NULL
      UNION ALL
      SELECT user_id, exercise_id, exercise_name, session_id, performed_at,
             'best_e1rm', best_e1rm FROM per_session WHERE best_e1rm IS NOT NULL
      UNION ALL
      SELECT user_id, exercise_id, exercise_name, session_id, performed_at,
             'session_volume', LEAST(session_volume, 9999999999.99)
        FROM per_session WHERE session_volume IS NOT NULL
      UNION ALL
      SELECT user_id, exercise_id, exercise_name, session_id, performed_at,
             'max_reps', max_reps FROM per_session WHERE max_reps IS NOT NULL
    ),
    ranked AS (
      SELECT s.*,
             MAX(value) OVER (
               PARTITION BY user_id, exercise_id, kind
               ORDER BY performed_at, session_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ) AS prev_max
        FROM stacked s
    )
    INSERT INTO user_pr_events
      (user_id, exercise_id, exercise_name, kind, value, previous_value,
       is_first, session_id, achieved_at, formula_version)
    SELECT user_id, exercise_id, exercise_name, kind, value, prev_max,
           prev_max IS NULL, session_id, performed_at, $1
      FROM ranked
     WHERE prev_max IS NULL OR value > prev_max
    ON CONFLICT (user_id, exercise_id, kind, value) DO NOTHING
  `,
    [FORMULA_VERSION],
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Reversão real: as quatro tabelas são 100% deriváveis das tabelas-fonte
  // (execução) ou são dado de onda ainda não lançada. Nenhum dado do aluno se
  // perde — metrics e PRs voltam idênticos no próximo `up`, porque o backfill
  // reconstrói a partir de `workout_set_logs`, que não é tocado aqui.
  for (const table of [
    'user_performance_snapshots',
    'user_performance_goals',
    'user_pr_events',
    'workout_session_metrics',
  ]) {
    if (await tableExists(pgm, table)) {
      await pgm.db.query(`DROP TABLE ${table}`);
    }
  }
};
