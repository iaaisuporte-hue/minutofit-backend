/**
 * Ledger de XP (Spec 034, Onda C0).
 *
 * ## O defeito que isto fecha
 *
 * Até aqui o XP era controlado pelo CLIENTE: `POST /gamification/checkins`
 * aceitava `xp` no corpo da requisição, sem teto, sem registro por evento e sem
 * chave de idempotência. Cada tela decidia quanto vale um treino (uma mandava
 * 20, outra 30, o tracker calculava sozinho). O streak sempre foi bem
 * defendido; o XP nunca foi — e a Spec 034 vai construir desafios e marcos em
 * cima dele, então um cliente modificado ganharia o desafio sem treinar.
 *
 * ## O que a tabela garante
 *
 * - **Idempotência**: `UNIQUE (event_key)`. A chave é natural do fato
 *   (`session:{id}`, `workout-day:{userId}:{dia}`), então reprocessar a mesma
 *   sessão não paga duas vezes — o replay que a Spec 033 já deduplica no treino
 *   deixa de ser recompensa dupla aqui.
 * - **Auditabilidade**: cada crédito é uma linha com tipo, valor e dia. O saldo
 *   em `user_gamification_stats.xp` continua sendo o agregado exibido, mas
 *   passa a ter extrato — recalibrar valores no futuro é recomputável.
 * - **Cap diário**: `awarded_on` guarda o DIA DO ALUNO (`dayKey`, não UTC), e o
 *   índice `(user_id, awarded_on)` serve a consulta do teto.
 *
 * ## `kind` inclui `activity` (desvio documentado da spec)
 *
 * A tabela da spec lista 5 tipos. O tracker de atividades (corrida/GPS) já paga
 * XP hoje; sem um tipo próprio, ou ele perderia XP em silêncio (mudança de
 * produto que não é desta onda) ou continuaria fora do ledger (o buraco de
 * novo). `weekly_goal`, `pr`, `challenge_completed` e `milestone` entram no
 * CHECK agora para as ondas seguintes não precisarem de migration — mas só
 * `workout_session` e `activity` são pagos na C0.
 *
 * O `down` derruba a tabela. O saldo agregado em `user_gamification_stats` não
 * é tocado em nenhuma direção — o ledger nasce como extrato dos créditos
 * futuros, não como reescrita do passado.
 */

const TABLE = 'xp_events';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      amount     SMALLINT NOT NULL,
      event_key  TEXT NOT NULL,
      awarded_on DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      DROP CONSTRAINT IF EXISTS xp_events_kind_chk,
      DROP CONSTRAINT IF EXISTS xp_events_amount_chk,
      DROP CONSTRAINT IF EXISTS xp_events_event_key_uq`);

  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT xp_events_kind_chk CHECK (kind IN (
        'workout_session', 'activity', 'weekly_goal', 'pr',
        'challenge_completed', 'milestone')),
      -- Positivo estrito: não existe débito. "Ausência não retira XP" é regra
      -- de produto, e aqui ela é do banco — nenhum caminho grava redução.
      ADD CONSTRAINT xp_events_amount_chk CHECK (amount > 0),
      ADD CONSTRAINT xp_events_event_key_uq UNIQUE (event_key)`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_xp_events_user_day
      ON ${TABLE} (user_id, awarded_on)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS ${TABLE}`);
};
