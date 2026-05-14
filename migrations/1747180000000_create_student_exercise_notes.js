/**
 * Migration piloto — student_exercise_notes
 * Equivalente ao ensureStudentExerciseNotesSchema.ts, mas gerenciado
 * pelo node-pg-migrate (up/down, auditável, reversível).
 *
 * Este arquivo é a referência canônica para novas tabelas.
 * Não criar novos ensure*.ts para tabelas criadas a partir daqui.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'student_exercise_notes',
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
      exercise_key: { type: 'varchar(96)' },
      exercise_name: { type: 'varchar(160)', notNull: true },
      kind: { type: 'varchar(24)', notNull: true },
      note: { type: 'text', notNull: true },
      severity: { type: 'smallint' },
      load_kg: { type: 'numeric(6,2)' },
      reps: { type: 'varchar(24)' },
      sets: { type: 'varchar(24)' },
      recorded_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
      },
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

  pgm.createIndex('student_exercise_notes', ['student_id', 'recorded_at'], {
    name: 'sxn_student_recent_idx',
    order: { recorded_at: 'DESC' },
    ifNotExists: true,
  });

  pgm.createIndex('student_exercise_notes', ['student_id', 'exercise_key', 'recorded_at'], {
    name: 'sxn_student_exercise_idx',
    order: { recorded_at: 'DESC' },
    ifNotExists: true,
  });

  pgm.createIndex('student_exercise_notes', ['personal_id', 'recorded_at'], {
    name: 'sxn_personal_idx',
    order: { recorded_at: 'DESC' },
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('student_exercise_notes', [], { name: 'sxn_student_recent_idx', ifExists: true });
  pgm.dropIndex('student_exercise_notes', [], { name: 'sxn_student_exercise_idx', ifExists: true });
  pgm.dropIndex('student_exercise_notes', [], { name: 'sxn_personal_idx', ifExists: true });
  pgm.dropTable('student_exercise_notes', { ifExists: true });
};
