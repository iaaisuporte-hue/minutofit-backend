/**
 * Cleanup one-off: remove fichas órfãs (source_protocol_id IS NULL) que ficaram
 * no banco após o personal excluir o protocolo de origem ANTES do fix de
 * cascata atômica em deleteWorkoutProtocol (commit do mesmo dia).
 *
 * Risco controlado: deleta apenas fichas órfãs criadas há mais de 24 horas —
 * uma ficha legitimamente criada via fluxo manual sem protocolo ainda teria
 * source_protocol_id NULL, mas o backfill no boot (ensureProtocolBackfill)
 * já tenta relinkar; o que sobra é de fato órfão por delete prévio.
 *
 * IMPORTANTE: irreversível. user_workout_logs é independente (workout_id VARCHAR),
 * portanto histórico de execução do aluno é preservado mesmo com o DELETE.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM personal_workout_plans
    WHERE source_protocol_id IS NULL
      AND created_at < NOW() - INTERVAL '24 hours'
  `);
};

exports.down = () => {
  // Cleanup é destrutivo por design — rollback não recupera as fichas.
  // Para reverter, restaurar do backup do Render.
};
