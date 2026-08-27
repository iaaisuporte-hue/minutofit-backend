/**
 * client_key em workout_sessions — idempotência da sessão SEM plano.
 *
 * `createSession` só deduplica quando existe `plan_id`: a chave natural é
 * aluno + ficha + dia da ficha + dia do aluno, serializada por advisory lock.
 * Sessão avulsa (treino livre, tracker, Lab) não tem chave natural nenhuma —
 * dois POSTs idênticos tanto podem ser dois treinos legítimos quanto o retry de
 * um cliente que perdeu a resposta por rede, e o servidor não tem como
 * distinguir. `client_key` é a chave que o CLIENTE gera uma vez por execução e
 * reenvia no retry.
 *
 * Índice PARCIAL: sessões antigas — e as que o cliente não carimbar — ficam com
 * NULL e não disputam unicidade entre si.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS client_key TEXT
  `);

  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_workout_sessions_user_client_key
      ON workout_sessions (user_id, client_key)
      WHERE client_key IS NOT NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS uniq_workout_sessions_user_client_key`);
  await pgm.db.query(`ALTER TABLE workout_sessions DROP COLUMN IF EXISTS client_key`);
};
