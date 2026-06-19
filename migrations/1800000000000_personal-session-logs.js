/**
 * Cria a tabela personal_session_logs.
 * O personal registra presença/ausência/parcial do aluno (Veio · Faltou · Parcial).
 * As queries de frequência do personalDashboardService passam a fazer UNION com esta
 * tabela — o motor de risco existente acende sem depender do aluno abrir o app.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_session_logs (
      id           SERIAL PRIMARY KEY,
      personal_id  INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id   INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id   INT          REFERENCES academies(id) ON DELETE SET NULL,
      status       TEXT         NOT NULL
                   CHECK (status IN ('present', 'absent', 'partial')),
      session_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      tags         JSONB        NOT NULL DEFAULT '[]',
      note         TEXT,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_psl_personal_at
      ON personal_session_logs (personal_id, session_at DESC)
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_psl_student_at
      ON personal_session_logs (student_id, session_at DESC)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS personal_session_logs`);
};
