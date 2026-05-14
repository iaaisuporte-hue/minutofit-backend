/**
 * Cria a tabela de mídia associada aos exercícios da biblioteca MetaCore.
 * media_type: 'gif' | 'image' | 'video' | 'youtube'
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('exercise_media', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    exercise_id: {
      type: 'uuid',
      notNull: true,
      references: '"exercises"',
      onDelete: 'CASCADE',
    },
    media_type: { type: 'text', notNull: true },
    url: { type: 'text', notNull: true },
    source: { type: 'text', notNull: false },
    is_primary: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('exercise_media', 'exercise_id');
  pgm.createIndex('exercise_media', ['exercise_id', 'is_primary'], {
    name: 'exercise_media_primary_idx',
    where: 'is_primary = true',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('exercise_media');
};
