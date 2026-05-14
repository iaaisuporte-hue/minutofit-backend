/**
 * Retention Intelligence — tabelas relacionais do módulo Personal.
 *
 * personal_relationship_actions : timeline de ações do personal sobre cada aluno
 * personal_message_templates    : templates de mensagem (metacore / academia / personal)
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // -------------------------------------------------------------------------
  // personal_relationship_actions
  // -------------------------------------------------------------------------
  pgm.createTable(
    'personal_relationship_actions',
    {
      id: 'id',
      personal_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      student_id: {
        type: 'integer',
        notNull: true,
        references: '"users"',
        onDelete: 'CASCADE',
      },
      academy_id: {
        type: 'integer',
        references: '"academies"',
        onDelete: 'SET NULL',
      },
      action_type: {
        type: 'varchar(40)',
        notNull: true,
        check: `action_type IN ('follow_up_marked','observation','bonus_offered','light_workout_offered','gradual_return_offered','message_sent','quick_nudge')`,
      },
      payload_json: {
        type: 'jsonb',
        notNull: true,
        default: pgm.func("'{}'::jsonb"),
      },
      source: {
        type: 'varchar(20)',
        notNull: true,
        default: 'manual',
      },
      due_at: { type: 'timestamptz' },
      resolved_at: { type: 'timestamptz' },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex(
    'personal_relationship_actions',
    ['personal_id', 'student_id', 'created_at'],
    { name: 'idx_pra_personal_student', order: { created_at: 'DESC' }, ifNotExists: true }
  );
  pgm.createIndex('personal_relationship_actions', ['academy_id'], {
    name: 'idx_pra_academy',
    ifNotExists: true,
  });
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_pra_due
      ON personal_relationship_actions (personal_id, due_at)
      WHERE due_at IS NOT NULL AND resolved_at IS NULL;
  `);

  // -------------------------------------------------------------------------
  // personal_message_templates
  // -------------------------------------------------------------------------
  pgm.createTable(
    'personal_message_templates',
    {
      id: 'id',
      personal_id: {
        type: 'integer',
        references: '"users"',
        onDelete: 'CASCADE',
      },
      academy_id: {
        type: 'integer',
        references: '"academies"',
        onDelete: 'SET NULL',
      },
      scope: {
        type: 'varchar(20)',
        notNull: true,
        check: `scope IN ('personal','academy','metacore')`,
      },
      category: { type: 'varchar(40)', notNull: true },
      title: { type: 'varchar(120)', notNull: true },
      body: { type: 'text', notNull: true },
      is_default: { type: 'boolean', notNull: true, default: false },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('personal_message_templates', ['personal_id'], {
    name: 'idx_pmt_personal',
    ifNotExists: true,
  });
  pgm.createIndex('personal_message_templates', ['scope', 'category'], {
    name: 'idx_pmt_scope',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('personal_message_templates', [], { name: 'idx_pmt_scope', ifExists: true });
  pgm.dropIndex('personal_message_templates', [], { name: 'idx_pmt_personal', ifExists: true });
  pgm.dropTable('personal_message_templates', { ifExists: true });

  pgm.dropIndex('personal_relationship_actions', [], { name: 'idx_pra_due', ifExists: true });
  pgm.dropIndex('personal_relationship_actions', [], { name: 'idx_pra_academy', ifExists: true });
  pgm.dropIndex('personal_relationship_actions', [], {
    name: 'idx_pra_personal_student',
    ifExists: true,
  });
  pgm.dropTable('personal_relationship_actions', { ifExists: true });
};
