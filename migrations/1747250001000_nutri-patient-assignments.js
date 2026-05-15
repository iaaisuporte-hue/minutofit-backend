/**
 * Creates nutri_patient_assignments table.
 *
 * Analogue to personal_student_assignments but for nutritionists.
 * academy_id is nullable to support autonomous nutri (no academy context).
 *
 * Also creates nutri_direct_invites — parallel to personal_direct_invites —
 * for the "nutri convida paciente direto" flow.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS nutri_patient_assignments (
      id           SERIAL PRIMARY KEY,
      nutri_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      patient_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id   INTEGER REFERENCES academies(id),
      status       VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'inactive', 'paused', 'cancelled')),
      notes        TEXT,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at     TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (nutri_id, patient_id)
    )
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_npa_nutri    ON nutri_patient_assignments(nutri_id)    WHERE status = 'active'`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_npa_patient  ON nutri_patient_assignments(patient_id)  WHERE status = 'active'`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_npa_academy  ON nutri_patient_assignments(academy_id)  WHERE academy_id IS NOT NULL`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS nutri_direct_invites (
      id               SERIAL PRIMARY KEY,
      nutri_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token            VARCHAR(64) UNIQUE NOT NULL,
      invited_email    VARCHAR(255),
      invited_name     VARCHAR(255),
      status           VARCHAR(16) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
      accepted_user_id INTEGER REFERENCES users(id),
      expires_at       TIMESTAMP NOT NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      accepted_at      TIMESTAMP
    )
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_nutri_direct_invites_nutri_id ON nutri_direct_invites(nutri_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_nutri_direct_invites_token    ON nutri_direct_invites(token)`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS nutri_direct_invites`);
  pgm.sql(`DROP TABLE IF EXISTS nutri_patient_assignments`);
};
