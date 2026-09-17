/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B corrective — "Consulta + Edição de
 * Refeição Registrada").
 *
 * A tabela nunca precisou de `updated_at` porque só existiam INSERT (criar)
 * e dois UPDATEs de campo único (`deleted_at`/`is_favorite`, nenhum dos dois
 * é "o usuário editou o que comeu"). Esta correção adiciona edição real de
 * conteúdo (`label`/`items`/totais) — `updated_at` é o registro mínimo de
 * "isto foi editado", sem virar histórico/versionamento (§7/§14: nenhuma
 * tabela de auditoria nova, nenhum "quem editou o quê e quando" além deste
 * timestamp único). NULL até a primeira edição — nunca setado no INSERT.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_nutrition_intake_logs
      DROP COLUMN IF EXISTS updated_at
  `);
};
