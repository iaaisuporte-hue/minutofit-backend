/**
 * Área Nutri MVP — Fase 1
 * Tabela: nutrition_observations
 *
 * Observações clínicas da nutri sobre o paciente.
 * Livres, sem schema fixo — texto puro.
 * Isoladas por (nutri_id, patient_id) para evitar leitura cruzada.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable(
    'nutrition_observations',
    {
      id:         'id',
      nutri_id:   { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
      patient_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
      body:       { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('nutrition_observations', ['nutri_id', 'patient_id'],
    { name: 'no_nutri_patient_idx', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('nutrition_observations', [], { name: 'no_nutri_patient_idx', ifExists: true });
  pgm.dropTable('nutrition_observations', { ifExists: true });
};
