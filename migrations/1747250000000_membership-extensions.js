/**
 * Extends user_products → user_product_memberships
 *
 * 1. Rename table (idempotent: only if user_products still exists)
 * 2. Add missing columns: academy_id, professional_id, plan_id, started_at, ended_at, metadata
 * 3. Extend status CHECK to include 'paused'
 * 4. Create supporting indexes
 * 5. Idempotent backfill: populate memberships from academy_users + personal_student_assignments
 *
 * Down: reverts rename + drops added columns (data preserved except new cols).
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 1. Rename only if old name still exists
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_products'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_product_memberships'
      ) THEN
        ALTER TABLE user_products RENAME TO user_product_memberships;
      END IF;
    END;
    $$;
  `);

  // 2. If fresh install — table doesn't exist yet → create it with full schema
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_product_memberships (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_key         VARCHAR(40) NOT NULL REFERENCES products(key),
      status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'paused', 'suspended', 'cancelled', 'expired')),
      source              VARCHAR(30) NOT NULL DEFAULT 'corefit'
                            CHECK (source IN ('corefit', 'academy_bootstrap', 'direct_purchase')),
      source_academy_id   INTEGER REFERENCES academies(id),
      granted_by_user_id  INTEGER REFERENCES users(id),
      granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ,
      revoked_by_user_id  INTEGER REFERENCES users(id),
      notes               TEXT,
      academy_id          INTEGER REFERENCES academies(id),
      professional_id     INTEGER REFERENCES users(id),
      plan_id             INTEGER,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at            TIMESTAMPTZ,
      metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (user_id, product_key)
    )
  `);

  // 3. Add new columns to existing renamed table (idempotent)
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS academy_id INTEGER REFERENCES academies(id)`);
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS professional_id INTEGER REFERENCES users(id)`);
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS plan_id INTEGER`);
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`);
  pgm.sql(`ALTER TABLE user_product_memberships ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);

  // 4. Extend status CHECK (drop old, add new that includes 'paused' + 'expired')
  pgm.sql(`ALTER TABLE user_product_memberships DROP CONSTRAINT IF EXISTS user_products_status_check`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP CONSTRAINT IF EXISTS user_product_memberships_status_check`);
  pgm.sql(`
    ALTER TABLE user_product_memberships
      ADD CONSTRAINT user_product_memberships_status_check
      CHECK (status IN ('active', 'paused', 'suspended', 'cancelled', 'expired'))
  `);

  // 5. Rename legacy indexes
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_products_user_id') THEN
        ALTER INDEX idx_user_products_user_id RENAME TO idx_upm_user_id;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_products_status') THEN
        ALTER INDEX idx_user_products_status RENAME TO idx_upm_status;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_products_source_academy') THEN
        ALTER INDEX idx_user_products_source_academy RENAME TO idx_upm_source_academy;
      END IF;
    END;
    $$;
  `);

  // 6. New supporting indexes
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_upm_user_product_active ON user_product_memberships(user_id, product_key) WHERE status = 'active'`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_upm_academy ON user_product_memberships(academy_id) WHERE academy_id IS NOT NULL`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_upm_professional ON user_product_memberships(professional_id) WHERE professional_id IS NOT NULL`);

  // 7. Backfill memberships from academy_users (ACADEMIA product)
  //
  // DISTINCT ON (au.user_id): mesmo user_id pode estar ativo em N academias
  // (academy_users tem UNIQUE (user_id, academy_id), não user_id puro).
  // Sem o DISTINCT, o SELECT produz múltiplas linhas (user_id, 'academia')
  // e o ON CONFLICT DO UPDATE explode com 21000 (cardinality_violation).
  // ORDER BY mais recente DESC = backfill pega a "academia atual" do user.
  pgm.sql(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, academy_id, source_academy_id, started_at)
    SELECT DISTINCT ON (au.user_id)
      au.user_id,
      'academia',
      'active',
      'academy_bootstrap',
      au.academy_id,
      au.academy_id,
      COALESCE(au.joined_at, au.created_at, NOW())
    FROM academy_users au
    WHERE au.is_active = TRUE AND au.status = 'active'
    ORDER BY au.user_id, COALESCE(au.joined_at, au.created_at) DESC NULLS LAST
    ON CONFLICT (user_id, product_key) DO UPDATE
      SET
        academy_id        = EXCLUDED.academy_id,
        source_academy_id = EXCLUDED.source_academy_id,
        status            = 'active'
  `);

  // 8. Backfill memberships from personal_student_assignments (PERSONAL product)
  //
  // DISTINCT ON (psa.student_id): mesmo aluno pode ter sido atribuído a N personals
  // (constraint é UNIQUE (personal_id, student_id), não student_id puro).
  // ORDER BY created_at DESC = backfill pega o personal mais recente do aluno.
  pgm.sql(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, professional_id, academy_id, started_at)
    SELECT DISTINCT ON (psa.student_id)
      psa.student_id,
      'personal',
      'active',
      'corefit',
      psa.personal_id,
      psa.academy_id,
      COALESCE(psa.created_at, NOW())
    FROM personal_student_assignments psa
    WHERE psa.status = 'active'
    ORDER BY psa.student_id, psa.created_at DESC NULLS LAST
    ON CONFLICT (user_id, product_key) DO UPDATE
      SET
        professional_id = EXCLUDED.professional_id,
        status          = 'active'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_upm_user_product_active`);
  pgm.sql(`DROP INDEX IF EXISTS idx_upm_academy`);
  pgm.sql(`DROP INDEX IF EXISTS idx_upm_professional`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS metadata`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS ended_at`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS started_at`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS plan_id`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS professional_id`);
  pgm.sql(`ALTER TABLE user_product_memberships DROP COLUMN IF EXISTS academy_id`);
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_product_memberships'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_products'
      ) THEN
        ALTER TABLE user_product_memberships RENAME TO user_products;
      END IF;
    END;
    $$;
  `);
};
