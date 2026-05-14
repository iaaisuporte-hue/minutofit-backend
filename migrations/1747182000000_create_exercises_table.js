/**
 * Cria a tabela global de exercícios da biblioteca MetaCore.
 * Exercícios são globais (sem academy_id) — apenas leitura para autenticados,
 * gravação restrita a admin.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('exercises', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    external_id: { type: 'text', notNull: false },
    source: { type: 'text', notNull: true, default: "'metacore'" },
    name: { type: 'text', notNull: true },
    normalized_name: { type: 'text', notNull: true },
    body_part: { type: 'text', notNull: true },
    target_muscle: { type: 'text', notNull: true },
    secondary_muscles: { type: 'text[]', notNull: false, default: "'{}'" },
    equipment: { type: 'text', notNull: true },
    tags: { type: 'text[]', notNull: false, default: "'{}'" },
    instructions: { type: 'jsonb', notNull: false, default: "'[]'" },
    tips: { type: 'jsonb', notNull: false, default: "'[]'" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('exercises', 'exercises_source_external_id_unique', {
    unique: ['source', 'external_id'],
    predicate: 'WHERE external_id IS NOT NULL',
  });

  pgm.createIndex('exercises', 'normalized_name');
  pgm.createIndex('exercises', 'body_part');
  pgm.createIndex('exercises', 'equipment');
  pgm.createIndex('exercises', 'target_muscle');
};

exports.down = (pgm) => {
  pgm.dropTable('exercises');
};
