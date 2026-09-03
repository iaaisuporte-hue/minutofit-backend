/**
 * Procedência da série executada — prescrita, substituída ou acrescentada.
 *
 * O aluno já podia trocar e acrescentar exercício durante a execução, mas o
 * banco não distinguia uma coisa da outra: `workout_set_logs` guardava as três
 * como linhas idênticas. A consequência é aritmética, não cosmética — a
 * aderência à ficha conta séries feitas contra séries prescritas, e uma série
 * que ninguém prescreveu inflava o numerador. Quem acrescentasse exercício por
 * conta própria aparecia para o personal como mais aderente ao plano do que o
 * plano permite.
 *
 * As três origens não são a mesma pergunta:
 *  - `prescribed`  : o que o personal pediu.
 *  - `replacement` : o aluno trocou o exercício (halteres ocupados, dor no
 *                    ombro) mas cumpriu o estímulo — CONTA na aderência.
 *  - `user_added`  : exercício extra, fora da ficha — NÃO conta na aderência,
 *                    e continua contando em volume, frequência e recorde.
 *
 * `substituted_from_exercise_id` (migration 1802) registra DE QUE exercício se
 * trocou; esta coluna registra o FATO da troca. São independentes de propósito:
 * o original pode sair do catálogo e o vínculo virar NULL sem que a substituição
 * deixe de ter acontecido.
 *
 * Sem backfill: o DEFAULT já classifica todo o histórico corretamente. Tudo que
 * existe hoje ou é execução da ficha, ou é sessão sem prescrição nenhuma
 * (treino livre, Lab) — que a aderência já ignora inteira, pelo denominador.
 *
 * Estilo: SQL cru e idempotente. Ver o cabeçalho de 1834000000000 — o helper de
 * integração reexecuta estas migrations com um `pgm` mínimo (só `db.query`).
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE workout_set_logs
      ADD COLUMN IF NOT EXISTS execution_source TEXT NOT NULL DEFAULT 'prescribed'
  `);

  await pgm.db.query(`
    ALTER TABLE workout_set_logs DROP CONSTRAINT IF EXISTS chk_set_log_execution_source
  `);
  await pgm.db.query(`
    ALTER TABLE workout_set_logs ADD CONSTRAINT chk_set_log_execution_source
      CHECK (execution_source IN ('prescribed', 'replacement', 'user_added'))
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE workout_set_logs DROP CONSTRAINT IF EXISTS chk_set_log_execution_source
  `);
  await pgm.db.query(`
    ALTER TABLE workout_set_logs DROP COLUMN IF EXISTS execution_source
  `);
};
