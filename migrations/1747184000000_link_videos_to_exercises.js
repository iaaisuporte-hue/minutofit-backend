/**
 * Adiciona coluna exercise_id opcional na tabela videos.
 * Permite vincular vídeos institucionais (com flags de acessibilidade) a
 * exercícios da biblioteca MetaCore sem quebrar vídeos legados.
 *
 * Idempotente: IF NOT EXISTS protege contra execução em BDs onde
 * a coluna/índice já existem.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS exercise_id uuid
      REFERENCES exercises(id) ON DELETE SET NULL
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS videos_exercise_id_idx
    ON videos (exercise_id)
    WHERE exercise_id IS NOT NULL
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS videos_exercise_id_idx`);
  pgm.dropColumn('videos', 'exercise_id');
};
