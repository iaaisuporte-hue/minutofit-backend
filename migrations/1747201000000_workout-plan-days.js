/**
 * personal_workout_plan_days — tabela filha de personal_workout_plans.
 *
 * Cada ficha (plano pai) pode ter N dias estruturados.
 * Fichas legadas (payload_json no pai, sem filhos) continuam funcionando —
 * o serviço sintetiza um dia único na camada de leitura.
 *
 * Idempotente: ifNotExists protege contra re-execução.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'personal_workout_plan_days',
    {
      id: 'id',
      plan_id: {
        type: 'integer',
        notNull: true,
        references: '"personal_workout_plans"',
        onDelete: 'CASCADE',
      },
      day_index: {
        type: 'integer',
        notNull: true,
      },
      name: {
        type: 'varchar(120)',
        notNull: true,
        default: "'Dia'",
      },
      focus: {
        type: 'varchar(120)',
      },
      payload_json: {
        type: 'jsonb',
        notNull: true,
        default: "'[]'",
      },
      created_at: {
        type: 'timestamptz',
        default: pgm.func('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: 'timestamptz',
        default: pgm.func('CURRENT_TIMESTAMP'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('personal_workout_plan_days', ['plan_id', 'day_index'], {
    unique: true,
    name: 'uq_workout_plan_days_plan_day',
    ifNotExists: true,
  });

  pgm.createIndex('personal_workout_plan_days', ['plan_id'], {
    name: 'idx_workout_plan_days_plan_id',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('personal_workout_plan_days', { ifExists: true });
};
