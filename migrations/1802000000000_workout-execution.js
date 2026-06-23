/**
 * Camada de EXECUÇÃO real do treino (Spec 010).
 *
 * Fecha o loop da tese: planejado (personal_workout_plan_days) → adaptado
 * (workout_adaptation_log) → EXECUTADO (estas tabelas). A sessão guarda
 * snapshot do prescrito + vínculo a plano/dia/adaptação/readiness do dia,
 * tornando comparável "intenção × realidade" de forma imutável (append-only).
 *
 *  - workout_sessions   : cabeçalho (status, source, readiness, snapshot)
 *  - workout_set_logs   : detalhe por SÉRIE (carga/reps reais — base de stats)
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS workout_sessions (
      id                  SERIAL PRIMARY KEY,
      user_id             INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id          INT          REFERENCES academies(id) ON DELETE SET NULL,
      personal_id         INT          REFERENCES users(id) ON DELETE SET NULL,
      source              TEXT         NOT NULL
                          CHECK (source IN ('personal', 'suggested', 'academy', 'free')),
      plan_id             INT          REFERENCES personal_workout_plans(id) ON DELETE SET NULL,
      day_index           INT,
      adaptation_log_id   INT          REFERENCES workout_adaptation_log(id) ON DELETE SET NULL,
      readiness_level     TEXT         CHECK (readiness_level IN ('green', 'yellow', 'red')),
      prescribed_snapshot JSONB        NOT NULL DEFAULT '[]',
      status              TEXT         NOT NULL
                          CHECK (status IN ('started', 'completed', 'partial', 'abandoned')),
      session_rpe         SMALLINT     CHECK (session_rpe BETWEEN 1 AND 10),
      title               TEXT,
      started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      ended_at            TIMESTAMPTZ,
      notes               TEXT,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_started
      ON workout_sessions (user_id, started_at DESC)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_plan
      ON workout_sessions (plan_id)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_status
      ON workout_sessions (user_id, status)
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS workout_set_logs (
      id                  SERIAL PRIMARY KEY,
      session_id          INT          NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
      exercise_id         UUID         REFERENCES exercises(id) ON DELETE SET NULL,
      exercise_name       TEXT         NOT NULL,
      order_index         SMALLINT     NOT NULL DEFAULT 0,
      set_index           SMALLINT     NOT NULL DEFAULT 1,
      planned_reps        TEXT,
      reps_done           SMALLINT,
      planned_load_kg     NUMERIC(6,2),
      load_done_kg        NUMERIC(6,2),
      planned_rest_s      SMALLINT,
      rest_done_s         SMALLINT,
      rpe                 SMALLINT     CHECK (rpe BETWEEN 1 AND 10),
      discomfort          TEXT,
      substituted_from_exercise_id UUID REFERENCES exercises(id) ON DELETE SET NULL,
      substitution_reason TEXT,
      status              TEXT         NOT NULL DEFAULT 'done'
                          CHECK (status IN ('done', 'skipped')),
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_set_logs_session
      ON workout_set_logs (session_id)
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_set_logs_exercise
      ON workout_set_logs (exercise_id, created_at)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS workout_set_logs`);
  await pgm.db.query(`DROP TABLE IF EXISTS workout_sessions`);
};
