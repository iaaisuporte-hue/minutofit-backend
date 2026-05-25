/**
 * Rede de Profissionais — MVP
 *
 * Sem checkout/comissao/ranking. Cria perfil curado, politica por academia
 * e permite solicitacoes originadas da Rede (`requested_via = discovery`).
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS professional_network_profiles (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      professional_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      professional_role     VARCHAR(16) NOT NULL CHECK (professional_role IN ('personal','nutri')),
      credential_code       VARCHAR(32) NOT NULL,
      credential_status     VARCHAR(24) NOT NULL DEFAULT 'pending_review'
                              CHECK (credential_status IN ('pending_review','approved','rejected')),
      publication_status    VARCHAR(24) NOT NULL DEFAULT 'draft'
                              CHECK (publication_status IN ('draft','pending_review','approved','disabled')),
      admin_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
      display_name          VARCHAR(120) NOT NULL,
      bio                   TEXT,
      photo_url             TEXT,
      specialties           JSONB NOT NULL DEFAULT '[]',
      metabolic_focus       VARCHAR(200),
      modality              VARCHAR(16) CHECK (modality IN ('in_person','online','hybrid')),
      city                  VARCHAR(120),
      state_uf              CHAR(2),
      availability_status   VARCHAR(24) NOT NULL DEFAULT 'available'
                              CHECK (availability_status IN ('available','limited','unavailable')),
      reviewed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at           TIMESTAMPTZ,
      review_notes          TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_pnp_visible
      ON professional_network_profiles(professional_role, availability_status, updated_at DESC)
      WHERE publication_status = 'approved'
        AND credential_status = 'approved'
        AND admin_enabled = TRUE
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS academy_professional_network_policies (
      academy_id          INTEGER PRIMARY KEY REFERENCES academies(id) ON DELETE CASCADE,
      mode                VARCHAR(16) NOT NULL DEFAULT 'block' CHECK (mode IN ('allow','block')),
      updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    ALTER TABLE student_professional_requests
      DROP CONSTRAINT IF EXISTS student_professional_requests_requested_via_check
  `);
  pgm.sql(`
    ALTER TABLE student_professional_requests
      ADD CONSTRAINT student_professional_requests_requested_via_check
        CHECK (requested_via IN ('email','code','link','discovery'))
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_personal_per_student
      ON personal_student_assignments(student_id)
      WHERE status = 'active'
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_nutri_per_patient
      ON nutri_patient_assignments(patient_id)
      WHERE status = 'active'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS uniq_active_nutri_per_patient`);
  pgm.sql(`DROP INDEX IF EXISTS uniq_active_personal_per_student`);
  pgm.sql(`
    ALTER TABLE student_professional_requests
      DROP CONSTRAINT IF EXISTS student_professional_requests_requested_via_check
  `);
  pgm.sql(`
    ALTER TABLE student_professional_requests
      ADD CONSTRAINT student_professional_requests_requested_via_check
        CHECK (requested_via IN ('email','code','link'))
  `);
  pgm.sql(`DROP TABLE IF EXISTS academy_professional_network_policies`);
  pgm.sql(`DROP TABLE IF EXISTS professional_network_profiles`);
};
