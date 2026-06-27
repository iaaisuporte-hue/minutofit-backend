/**
 * Spec 017 — CRUD de Unidades/Filiais. A tabela academy_units já existe
 * (ensureAcademiesSchema); aqui adicionamos a noção de unidade principal.
 * Índice parcial garante no máximo 1 principal por academia. Backfill marca a
 * unidade mais antiga de cada academia como principal (idempotente).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE academy_units
      ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false
  `);

  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_academy_units_primary
      ON academy_units (academy_id) WHERE is_primary
  `);

  // Backfill: a unidade mais antiga (menor id) de cada academia que ainda não
  // tem principal vira a principal. Idempotente.
  await pgm.db.query(`
    UPDATE academy_units u
       SET is_primary = true
      FROM (
        SELECT DISTINCT ON (academy_id) id
          FROM academy_units
         ORDER BY academy_id, id ASC
      ) first
     WHERE u.id = first.id
       AND NOT EXISTS (
         SELECT 1 FROM academy_units p
          WHERE p.academy_id = u.academy_id AND p.is_primary
       )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS uq_academy_units_primary`);
  await pgm.db.query(`ALTER TABLE academy_units DROP COLUMN IF EXISTS is_primary`);
};
