/**
 * Lab de Movimento — Modo Guiado pela Ficha (Spec 022, P1).
 *
 * Conecta o Lab (pose estimation) à ficha prescrita: o aluno abre o Lab de um
 * exercício do Modo Treino, conta séries/reps e grava a execução real
 * reaproveitando workout_sessions/workout_set_logs (Spec 010).
 *
 * - workout_sessions.source: passa a aceitar 'movement_lab'.
 * - exercises.movement_lab_exercise_id: qual perfil de captura do Lab
 *   (biceps_curl, squat, …) aquele exercício da biblioteca usa. Backfill
 *   best-effort por normalized_name (nullable — sem match = sem botão no app).
 * - workout_set_capture: satélite 1:1 de workout_set_logs com os dados de
 *   captura (reps detectadas antes da correção, form score, simetria, confiança).
 *   reps_done em workout_set_logs continua sendo a verdade (valor corrigido).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── source += 'movement_lab' ────────────────────────────────────────────────
  await pgm.db.query(`
    ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_source_check
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ADD CONSTRAINT workout_sessions_source_check
      CHECK (source IN ('personal', 'suggested', 'academy', 'free', 'movement_lab'))
  `);

  // ── mapeamento exercício da biblioteca → perfil de captura do Lab ────────────
  await pgm.db.query(`
    ALTER TABLE exercises ADD COLUMN IF NOT EXISTS movement_lab_exercise_id VARCHAR(50)
  `);

  // Backfill best-effort dos 5 exercícios do Lab (P1). normalized_name é
  // lowercase + sem acento. Só preenche linhas ainda NULL. Sem match → coluna
  // fica NULL e o app simplesmente não oferece o botão do Lab.
  const MAP = [
    ['biceps_curl', 'rosca direta%'],
    ['lateral_raise', 'elevacao lateral%'],
    ['push_up', 'flexao de braco%'],
    ['squat', 'agachamento livre%'],
    ['lunge', 'afundo%'],
  ];
  for (const [labId, pattern] of MAP) {
    await pgm.db.query(
      `UPDATE exercises
         SET movement_lab_exercise_id = $1
       WHERE movement_lab_exercise_id IS NULL
         AND normalized_name ILIKE $2`,
      [labId, pattern],
    );
  }

  // ── satélite de captura (1:1 com a série) ───────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS workout_set_capture (
      id              SERIAL PRIMARY KEY,
      set_log_id      INTEGER     NOT NULL REFERENCES workout_set_logs(id) ON DELETE CASCADE,
      detected_reps   SMALLINT,
      corrected       BOOLEAN     NOT NULL DEFAULT false,
      avg_form_score  SMALLINT,
      avg_symmetry    SMALLINT,
      confidence      VARCHAR(8),
      flags           JSONB       NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (set_log_id)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS workout_set_capture`);
  await pgm.db.query(`ALTER TABLE exercises DROP COLUMN IF EXISTS movement_lab_exercise_id`);
  await pgm.db.query(`
    ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_source_check
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ADD CONSTRAINT workout_sessions_source_check
      CHECK (source IN ('personal', 'suggested', 'academy', 'free'))
  `);
};
