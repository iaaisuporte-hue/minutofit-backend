/**
 * Triagem de saúde do aluno: parar de responder no lugar dele (QA ago/2026, P1-1 + P1-2).
 *
 * Duas correções na mesma zona:
 *
 * 1. `DEFAULT true` nas 5 declarações de saúde. O formulário de cadastro do SPA
 *    nunca envia `healthFlags`, então todo usuário nascia com "sem histórico de
 *    hipertensão / sem histórico cardíaco / sem restrição médica / apto para
 *    atividade física / aceito a responsabilidade" gravado como declaração dele —
 *    sem nunca ter sido perguntado. Passa a NULL = "não respondeu", que é a
 *    verdade. `deriveClearance` já trata != true como `incomplete_health_flags`,
 *    então o comportamento do gate não muda para quem já respondeu.
 *
 *    O backfill só limpa quem NÃO assinou o PAR-Q (`parq_signed_at IS NULL`):
 *    esses valores são artefato do default, não resposta. Quem assinou passou
 *    pelo painel e marcou as caixas de fato — fica intacto. E como quem não
 *    assinou já tinha clearance inválido por `never_signed`, ninguém perde acesso
 *    que tivesse antes.
 *
 * 2. `parq_medical_release_at`: a saída para quem responde "sim" no PAR-Q.
 *    Hoje `parq_any_yes` é calculado, gravado, hasheado como evidência — e
 *    ignorado: responder "sim" a "sente dor no peito?" liberava o treino igual.
 *    Bloquear sem oferecer caminho só ensinaria o aluno a mentir no formulário,
 *    então o bloqueio vem junto com a declaração de liberação médica: o aluno
 *    confirma que obteve liberação de um profissional e a data fica registrada.
 */

const HEALTH_FLAG_COLUMNS = [
  'sem_historico_hipertensao',
  'sem_historico_cardiaco',
  'sem_restricao_medica_exercicio',
  'apto_para_atividade_fisica',
  'aceita_responsabilidade_informacoes',
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // Guarda de existência: `users` e as colunas de triagem nascem do
  // seedDatabase/ensure*, que rodam DEPOIS das migrations no boot. Em banco novo
  // esta migration passa reto e o schema final sai correto pelos ensure*.
  const { rows } = await pgm.db.query(`
    SELECT to_regclass('public.users') IS NOT NULL AS has_table
  `);
  if (!rows[0]?.has_table) return;

  const { rows: colRows } = await pgm.db.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
       AND column_name = ANY($1::text[])
  `, [HEALTH_FLAG_COLUMNS]);
  const present = new Set(colRows.map((r) => r.column_name));

  for (const col of HEALTH_FLAG_COLUMNS) {
    if (!present.has(col)) continue;
    // NOT NULL vinha do seedDatabase legado e impede gravar "não respondeu".
    await pgm.db.query(`ALTER TABLE users ALTER COLUMN ${col} DROP NOT NULL`);
    await pgm.db.query(`ALTER TABLE users ALTER COLUMN ${col} DROP DEFAULT`);
  }

  if (present.size === HEALTH_FLAG_COLUMNS.length) {
    await pgm.db.query(`
      UPDATE users
         SET sem_historico_hipertensao           = NULL,
             sem_historico_cardiaco              = NULL,
             sem_restricao_medica_exercicio      = NULL,
             apto_para_atividade_fisica          = NULL,
             aceita_responsabilidade_informacoes = NULL
       WHERE role = 'user'
         AND parq_signed_at IS NULL
    `);
  }

  await pgm.db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS parq_medical_release_at TIMESTAMPTZ
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS parq_medical_release_at`);
  for (const col of HEALTH_FLAG_COLUMNS) {
    await pgm.db.query(`ALTER TABLE users ALTER COLUMN ${col} SET DEFAULT true`);
  }
  // O backfill não é revertido de propósito: NULL ("não respondeu") é mais
  // correto que `true` fabricado, e restaurá-lo recriaria a declaração falsa.
};
