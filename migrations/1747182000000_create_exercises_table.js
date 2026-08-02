/**
 * Cria a tabela global de exercícios da biblioteca CoreFit.
 * Exercícios são globais (sem academy_id) — apenas leitura para autenticados,
 * gravação restrita a admin.
 *
 * Idempotente: ifNotExists em createTable/createIndex protege contra
 * execução em BDs onde ensureExercisesSchema.ts já criou a tabela.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'exercises',
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      external_id: { type: 'text', notNull: false },
      // `default` com string simples é ESCAPADO por node-pg-migrate: passar
      // "'corefit'" gera DEFAULT '''corefit''' (valor com aspas dentro) e
      // "'{}'" num text[] estoura "malformed array literal". Expressões SQL
      // precisam de pgm.func().
      source: { type: 'text', notNull: true, default: pgm.func("'corefit'") },
      name: { type: 'text', notNull: true },
      normalized_name: { type: 'text', notNull: true },
      body_part: { type: 'text', notNull: true },
      target_muscle: { type: 'text', notNull: true },
      secondary_muscles: { type: 'text[]', notNull: false, default: pgm.func("'{}'::text[]") },
      equipment: { type: 'text', notNull: true },
      tags: { type: 'text[]', notNull: false, default: pgm.func("'{}'::text[]") },
      instructions: { type: 'jsonb', notNull: false, default: pgm.func("'[]'::jsonb") },
      tips: { type: 'jsonb', notNull: false, default: pgm.func("'[]'::jsonb") },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  // Add unique constraint idempotently — may already exist from ensureExercisesSchema
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'exercises_source_external_id_unique'
          AND conrelid = 'exercises'::regclass
      ) THEN
        ALTER TABLE exercises
          ADD CONSTRAINT exercises_source_external_id_unique
          UNIQUE (source, external_id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END$$
  `);

  pgm.createIndex('exercises', 'normalized_name', { ifNotExists: true });
  pgm.createIndex('exercises', 'body_part', { ifNotExists: true });
  pgm.createIndex('exercises', 'equipment', { ifNotExists: true });
  pgm.createIndex('exercises', 'target_muscle', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('exercises');
};
