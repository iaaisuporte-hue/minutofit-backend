/**
 * Onda 1 — Minha Equipe MetaCore
 *
 * Cria: student_professional_requests, user_data_consents, data_access_audit
 * Altera: personal_student_assignments (initiated_by + status 'revoked')
 *         nutri_patient_assignments    (initiated_by + status 'revoked')
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // ── Altera personal_student_assignments ──────────────────────────────────
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(16) NOT NULL DEFAULT 'professional'
  `);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      DROP CONSTRAINT IF EXISTS personal_student_assignments_status_check
  `);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      ADD CONSTRAINT personal_student_assignments_status_check
        CHECK (status IN ('active','inactive','paused','cancelled','revoked'))
  `);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      ADD CONSTRAINT personal_student_assignments_initiated_by_check
        CHECK (initiated_by IN ('professional','student','academy'))
  `);

  // ── Altera nutri_patient_assignments ─────────────────────────────────────
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(16) NOT NULL DEFAULT 'professional'
  `);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      DROP CONSTRAINT IF EXISTS nutri_patient_assignments_status_check
  `);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      ADD CONSTRAINT nutri_patient_assignments_status_check
        CHECK (status IN ('active','inactive','paused','cancelled','revoked'))
  `);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      ADD CONSTRAINT nutri_patient_assignments_initiated_by_check
        CHECK (initiated_by IN ('professional','student','academy'))
  `);

  // ── Cria student_professional_requests ───────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS student_professional_requests (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_role  VARCHAR(16) NOT NULL
                           CHECK (professional_role IN ('personal','nutri')),
      requested_via      VARCHAR(16) NOT NULL
                           CHECK (requested_via IN ('email','code','link')),
      message            TEXT,
      status             VARCHAR(16) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
      requested_scopes   JSONB NOT NULL DEFAULT '[]',
      expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
      responded_at       TIMESTAMPTZ,
      rejection_reason   TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spr_pending_unique
      ON student_professional_requests(student_id, professional_id, professional_role)
      WHERE status = 'pending'
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_spr_professional_status
      ON student_professional_requests(professional_id, status)
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_spr_student_status
      ON student_professional_requests(student_id, status)
  `);

  // ── Cria user_data_consents ───────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_data_consents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_role VARCHAR(16) NOT NULL
                          CHECK (professional_role IN ('personal','nutri')),
      scope             VARCHAR(32) NOT NULL
                          CHECK (scope IN (
                            'profile','workouts','daily_checkins','metabolic',
                            'sleep','body_metrics','body_photos','nutrition',
                            'parq_anamnese','activity_logs','chat_history'
                          )),
      status            VARCHAR(16) NOT NULL DEFAULT 'granted'
                          CHECK (status IN ('granted','revoked','expired')),
      granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at        TIMESTAMPTZ,
      expires_at        TIMESTAMPTZ,
      UNIQUE (user_id, professional_id, professional_role, scope)
    )
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_udc_professional_user_status
      ON user_data_consents(professional_id, user_id, status)
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_udc_user_status
      ON user_data_consents(user_id, status)
  `);

  // ── Adiciona professional_code em users ──────────────────────────────────
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS professional_code VARCHAR(16) UNIQUE
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_users_professional_code
      ON users(professional_code) WHERE professional_code IS NOT NULL
  `);

  // ── Cria data_access_audit ────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS data_access_audit (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id         INTEGER NOT NULL REFERENCES users(id),
      subject_user_id  INTEGER NOT NULL REFERENCES users(id),
      event_type       VARCHAR(48) NOT NULL,
      event_payload    JSONB NOT NULL DEFAULT '{}',
      ip               INET,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_daa_subject_created
      ON data_access_audit(subject_user_id, created_at DESC)
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_daa_actor_created
      ON data_access_audit(actor_id, created_at DESC)
  `);

  // ── Backfill: professional_code para profissionais existentes ────────────
  // Código de 8 chars: 4 letras maiúsculas do nome + 4 chars do id base36.
  pgm.sql(`
    UPDATE users
    SET professional_code = UPPER(
      REGEXP_REPLACE(
        SUBSTRING(REGEXP_REPLACE(COALESCE(name,'PRO'),'[^a-zA-Z]','','g') FROM 1 FOR 4),
        '$', LPAD(TO_HEX(id), 4, '0')
      )
    )
    WHERE role IN ('personal','nutri') AND professional_code IS NULL
  `);

  // ── Backfill: granted consents para vínculos legados ─────────────────────
  // Vínculos criados antes desta migration (initiated_by='professional')
  // recebem consent granted nos escopos default para não quebrar fluxo legado.
  // Aluno pode revogar granularmente depois.
  pgm.sql(`
    INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
    SELECT
      psa.student_id,
      psa.personal_id,
      'personal',
      s.scope,
      'granted'
    FROM personal_student_assignments psa
    CROSS JOIN (
      VALUES ('profile'), ('workouts'), ('daily_checkins'),
             ('metabolic'), ('sleep'), ('body_metrics'),
             ('parq_anamnese'), ('activity_logs'), ('chat_history')
    ) AS s(scope)
    WHERE psa.status = 'active'
    ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
    SELECT
      npa.patient_id,
      npa.nutri_id,
      'nutri',
      s.scope,
      'granted'
    FROM nutri_patient_assignments npa
    CROSS JOIN (
      VALUES ('profile'), ('nutrition'), ('daily_checkins'),
             ('metabolic'), ('body_metrics'), ('parq_anamnese'),
             ('chat_history')
    ) AS s(scope)
    WHERE npa.status = 'active'
    ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS data_access_audit`);
  pgm.sql(`DROP TABLE IF EXISTS user_data_consents`);
  pgm.sql(`DROP TABLE IF EXISTS student_professional_requests`);

  pgm.sql(`ALTER TABLE nutri_patient_assignments DROP COLUMN IF EXISTS initiated_by`);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      DROP CONSTRAINT IF EXISTS nutri_patient_assignments_initiated_by_check
  `);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      DROP CONSTRAINT IF EXISTS nutri_patient_assignments_status_check
  `);
  pgm.sql(`
    ALTER TABLE nutri_patient_assignments
      ADD CONSTRAINT nutri_patient_assignments_status_check
        CHECK (status IN ('active','inactive','paused','cancelled'))
  `);

  pgm.sql(`ALTER TABLE personal_student_assignments DROP COLUMN IF EXISTS initiated_by`);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      DROP CONSTRAINT IF EXISTS personal_student_assignments_initiated_by_check
  `);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      DROP CONSTRAINT IF EXISTS personal_student_assignments_status_check
  `);
  pgm.sql(`
    ALTER TABLE personal_student_assignments
      ADD CONSTRAINT personal_student_assignments_status_check
        CHECK (status IN ('active','inactive'))
  `);
};
