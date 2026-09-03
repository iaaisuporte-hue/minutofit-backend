/* eslint-disable camelcase */

/**
 * Snapshot diário do S2CORE Readiness (SPEC Mobile P3 §34, §35, §36).
 *
 * Tabela NOVA e separada de `user_readiness_snapshot` (Spec 008), de propósito.
 * Aquela guarda o nível qualitativo verde/amarelo/vermelho do Lens, que
 * continua sendo a fonte da adaptação de treino sob a política CREF do
 * Personal. Esta guarda a leitura numérica e o breakdown. Fundi-las obrigaria a
 * versionar as duas juntas, e são conceitos que evoluem em ritmos diferentes.
 *
 * ## O CHECK que é a regra de produto, não uma validação
 *
 * `chk_readiness_has_components` recusa gravar score sem breakdown. É a mesma
 * amarra que `user_performance_snapshots` usa para o Progress Score, e existe
 * pela mesma razão: o CLAUDE.md proíbe número-resumo sem interpretação, e uma
 * regra que vive só na UI é uma regra que a próxima rota esquece. Aqui é o
 * banco que recusa.
 *
 * ## Por que o histórico é imutável
 *
 * A §36 proíbe recalcular o passado quando o algoritmo mudar. `algorithm_version`
 * é NOT NULL e faz parte da identidade da linha: um snapshot de `1.0` continua
 * sendo `1.0` para sempre. É a única forma de comparar previsão e realidade
 * (§45, §47) sem contaminar a série com uma fórmula que ainda não existia.
 *
 * ## Estilo: SQL cru e idempotente
 *
 * Ver o cabeçalho de 1834000000000 — o helper de integração reexecuta estas
 * migrations com um `pgm` mínimo (só `db.query`).
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS readiness_snapshot (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Dia do ALUNO (fuso do app), não UTC.
      snapshot_date     DATE        NOT NULL,
      -- 0–100, ou NULL em cold start / sem componente. NULL é resultado válido
      -- e significativo: "não dá para afirmar" (§11).
      score             INTEGER,
      state             TEXT        NOT NULL,
      recommendation    TEXT        NOT NULL,
      confidence        TEXT        NOT NULL,
      -- Soma dos pesos presentes, 0..1 (§8).
      data_completeness NUMERIC(4,3) NOT NULL,
      -- cold_start | building | established (§11).
      mode              TEXT        NOT NULL,
      -- Breakdown técnico para auditoria (§33). Obrigatório — ver CHECK abaixo.
      components        JSONB       NOT NULL,
      -- Fatores em linguagem de produto (§32).
      factors           JSONB       NOT NULL DEFAULT '[]'::jsonb,
      -- Estado por grupo muscular (§16).
      muscle_recovery   JSONB       NOT NULL DEFAULT '[]'::jsonb,
      algorithm_version TEXT        NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const check = async (nome, expr) => {
    await pgm.db.query(`ALTER TABLE readiness_snapshot DROP CONSTRAINT IF EXISTS ${nome}`);
    await pgm.db.query(`ALTER TABLE readiness_snapshot ADD CONSTRAINT ${nome} CHECK (${expr})`);
  };

  await check('chk_readiness_score_range', 'score IS NULL OR (score BETWEEN 0 AND 100)');
  await check('chk_readiness_state',
    "state IN ('ready_intense','ready','moderate','light','recover','calibrating')");
  await check('chk_readiness_recommendation',
    "recommendation IN ('INTENSE','NORMAL','MODERATE','LIGHT','RECOVERY','CHECKIN_FIRST')");
  await check('chk_readiness_confidence', "confidence IN ('high','medium','low')");
  await check('chk_readiness_mode', "mode IN ('cold_start','building','established')");
  await check('chk_readiness_completeness', 'data_completeness BETWEEN 0 AND 1');
  // A amarra do CLAUDE.md, imposta pelo banco: score exige breakdown.
  await check('chk_readiness_has_components',
    'score IS NULL OR jsonb_array_length(components) > 0');

  // Um snapshot por dia. Recalcular ATUALIZA o do dia; nunca cria um segundo.
  //
  // O nome carrega `_v1` porque índices são globais no schema do Postgres, e
  // `uq_readiness_user_date` já pertence a `user_readiness_snapshot` (Spec 008).
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_readiness_v1_user_date
      ON readiness_snapshot (user_id, snapshot_date)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_readiness_snapshot_user_date
      ON readiness_snapshot (user_id, snapshot_date)
  `);

  /**
   * Feedback pós-treino (§46) — insumo de calibração futura (§45, §47).
   *
   * Guardado agora e NÃO consumido pelo motor: a §47 é explícita sobre
   * registrar a divergência entre previsão e realidade sem alterar o modelo
   * automaticamente nesta fase. Sem coletar desde já, a calibração da v2
   * começaria do zero.
   */
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS workout_effort_feedback (
      id                       SERIAL PRIMARY KEY,
      user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id               INTEGER REFERENCES workout_sessions(id) ON DELETE CASCADE,
      perceived                TEXT    NOT NULL,
      -- Readiness previsto no dia — congelado aqui para a comparação (§47).
      predicted_score          INTEGER,
      predicted_recommendation TEXT,
      algorithm_version        TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`ALTER TABLE workout_effort_feedback DROP CONSTRAINT IF EXISTS chk_effort_perceived`);
  await pgm.db.query(`
    ALTER TABLE workout_effort_feedback ADD CONSTRAINT chk_effort_perceived
      CHECK (perceived IN ('very_light','light','adequate','hard','very_hard'))
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_effort_feedback_user
      ON workout_effort_feedback (user_id, created_at)
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS workout_effort_feedback`);
  await pgm.db.query(`DROP TABLE IF EXISTS readiness_snapshot`);
};
