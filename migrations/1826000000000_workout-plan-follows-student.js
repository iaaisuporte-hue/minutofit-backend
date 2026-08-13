/**
 * A ficha operacional não sobrevive ao aluno (hardening pós-QA, ago/2026).
 *
 * ## O que estava errado
 *
 * `personal_workout_plans.student_id` era `ON DELETE SET NULL`. Apagar uma conta
 * deixava a ficha para trás, viva, sem dono — com os dias, os exercícios e o
 * título intactos. O QA de produção encontrou o efeito ao criar e destruir uma
 * conta de demonstração: as contas sumiram, os consentimentos e os vínculos
 * sumiram, e quatro fichas ficaram.
 *
 * ## Por que CASCADE é a resposta certa aqui
 *
 * A dúvida legítima seria: a ficha guarda histórico que precisa sobreviver ao
 * titular? Não guarda. O histórico executado mora em `workout_sessions` (com
 * `workout_session_metrics`, `user_pr_events` e o `prescribed_snapshot` de cada
 * sessão), e `workout_sessions.user_id` JÁ é `CASCADE`: quando o aluno é
 * apagado, a execução dele é apagada junto. Uma ficha órfã, portanto, não
 * retinha nada — era prescrição sem prescrito e sem execução, ocupando as
 * listagens do personal.
 *
 * As FKs de ENTRADA continuam coerentes depois desta mudança:
 * - `personal_workout_plan_days` e `workout_adaptation_log` são CASCADE e vão
 *   junto com a ficha, como já iam;
 * - `workout_sessions.plan_id` e `workout_reviews.workout_plan_id` são SET
 *   NULL, então nada que sobreviva ao aluno perde a própria linha por causa
 *   disto.
 *
 * ## O que NÃO muda: `personal_id`
 *
 * Continua `SET NULL`, e de propósito. Quando o PERSONAL encerra a conta, o
 * aluno não pode perder a prescrição que está seguindo — a ficha é dele
 * também. Trocar as duas colunas de uma vez seria confundir "quem escreveu" com
 * "de quem é".
 *
 * ## Reversão
 *
 * O `down` devolve `SET NULL`. Fiel, e sem recuperar as linhas que o CASCADE
 * tiver apagado — o que é a natureza de reverter uma política de exclusão, e
 * está dito aqui para que ninguém conte com o contrário.
 */

const TABLE = 'personal_workout_plans';
const FK = 'personal_workout_plans_student_id_fkey';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.${TABLE}') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${FK}`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT ${FK}
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  const exists = await pgm.db.query(`SELECT to_regclass('public.${TABLE}') AS oid`);
  if (exists.rows[0]?.oid == null) return;

  await pgm.db.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${FK}`);
  await pgm.db.query(`
    ALTER TABLE ${TABLE}
      ADD CONSTRAINT ${FK}
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE SET NULL`);
};
