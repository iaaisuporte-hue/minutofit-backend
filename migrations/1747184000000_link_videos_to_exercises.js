/**
 * Adiciona coluna exercise_id opcional na tabela videos.
 * Permite vincular vídeos institucionais (com flags de acessibilidade) a
 * exercícios da biblioteca MetaCore sem quebrar vídeos legados.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('videos', {
    exercise_id: {
      type: 'uuid',
      notNull: false,
      references: '"exercises"',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('videos', 'exercise_id', {
    name: 'videos_exercise_id_idx',
    where: 'exercise_id IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('videos', 'exercise_id', { name: 'videos_exercise_id_idx' });
  pgm.dropColumn('videos', 'exercise_id');
};
