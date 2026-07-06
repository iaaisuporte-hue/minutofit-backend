/**
 * Registro retroativo de treino (Spec 024).
 *
 * Permite corrigir o diário: registrar um treino feito nos últimos 3 dias que o
 * aluno esqueceu de marcar. Correção de diário, NÃO substituto do fluxo ao vivo.
 *
 * - performed_at: quando o treino ACONTECEU (canônico de aderência). No retro,
 *   started_at/ended_at também recebem a data real (todos os leitores usam
 *   started_at), e created_at (default NOW) fica como base de auditoria — nunca
 *   sobrescrito.
 * - is_retroactive: marca registros feitos após o dia do treino.
 * - retroactive_reason: motivo opcional informado pelo aluno.
 * - confirmation_accepted: aceite de honestidade persistido (auditoria).
 * - source += 'user_retroactive': o servidor stampa esse valor quando retroativo
 *   (a origem do conteúdo — ficha/sugerido/avulso — fica em plan_id/prescribed).
 *
 * Sem CHECK de janela no banco: a validação da janela (72h/futuro) depende de
 * NOW(), que não é imutável em constraint — fica no serviço.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── colunas novas (nullable primeiro p/ backfill seguro) ────────────────────
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ADD COLUMN IF NOT EXISTS performed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS is_retroactive BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS retroactive_reason TEXT,
      ADD COLUMN IF NOT EXISTS confirmation_accepted BOOLEAN NOT NULL DEFAULT false
  `);

  // Backfill: sessões legadas aconteceram quando começaram. Precede o DEFAULT
  // volátil (senão o NOW() da migration preencheria as linhas antigas).
  await pgm.db.query(`
    UPDATE workout_sessions SET performed_at = started_at WHERE performed_at IS NULL
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ALTER COLUMN performed_at SET DEFAULT NOW(),
      ALTER COLUMN performed_at SET NOT NULL
  `);

  // ── source += 'user_retroactive' ────────────────────────────────────────────
  await pgm.db.query(`
    ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_source_check
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ADD CONSTRAINT workout_sessions_source_check
      CHECK (source IN ('personal', 'suggested', 'academy', 'free', 'movement_lab', 'user_retroactive'))
  `);

  // Leitura dominante: histórico por usuário ordenado pela data real.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_performed
      ON workout_sessions (user_id, performed_at DESC)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_workout_sessions_user_performed`);
  await pgm.db.query(`
    ALTER TABLE workout_sessions DROP CONSTRAINT IF EXISTS workout_sessions_source_check
  `);
  // Reverte o CHECK ao estado da migration 1811 (sem 'user_retroactive').
  await pgm.db.query(`
    UPDATE workout_sessions SET source = 'free' WHERE source = 'user_retroactive'
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      ADD CONSTRAINT workout_sessions_source_check
      CHECK (source IN ('personal', 'suggested', 'academy', 'free', 'movement_lab'))
  `);
  await pgm.db.query(`
    ALTER TABLE workout_sessions
      DROP COLUMN IF EXISTS confirmation_accepted,
      DROP COLUMN IF EXISTS retroactive_reason,
      DROP COLUMN IF EXISTS is_retroactive,
      DROP COLUMN IF EXISTS performed_at
  `);
};
