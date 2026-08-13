/**
 * Alinha o índice da linha do tempo de recordes com a query que existe de fato
 * (Spec 033, Onda P2).
 *
 * ## O defeito
 *
 * A P1 criou `idx_pr_events_user_created (user_id, created_at DESC)` prevendo
 * uma "timeline". Quando a P2 escreveu a leitura de verdade, ela ficou assim:
 *
 *     WHERE user_id = $1 AND achieved_at >= $2
 *     ORDER BY achieved_at DESC, id DESC
 *
 * `achieved_at`, não `created_at` — e a diferença não é cosmética. Num recorde
 * batido em sessão retroativa, `achieved_at` é o dia em que o aluno treinou e
 * `created_at` é o dia em que ele registrou. A linha do tempo tem que contar a
 * história do treino, não a do formulário.
 *
 * Resultado: o índice da P1 não é usado por consulta nenhuma (nenhum código lê
 * `created_at` desta tabela), enquanto a consulta que existe paga ordenação
 * sem índice. É peso morto na escrita e ausência na leitura.
 *
 * ## Por que trocar em vez de somar
 *
 * Manter os dois deixaria um índice que ninguém consulta encarecendo todo
 * INSERT de recorde — e o INSERT acontece dentro da transação que grava o
 * treino do aluno. A contagem de índices não muda; só passa a apontar para a
 * coluna certa.
 *
 * O `down` recria exatamente o índice anterior, então a reversão é fiel.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.user_pr_events') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pr_events_user_achieved
      ON user_pr_events (user_id, achieved_at DESC, id DESC)`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_pr_events_user_created`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.user_pr_events') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pr_events_user_created
      ON user_pr_events (user_id, created_at DESC)`);
  await pgm.db.query(`DROP INDEX IF EXISTS idx_pr_events_user_achieved`);
};
