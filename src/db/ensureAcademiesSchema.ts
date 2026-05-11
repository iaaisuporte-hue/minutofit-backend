import pool from '../config/database';

/**
 * Fase 1 — Fundação multi-tenant.
 * Cria as 7 tabelas de academia se não existirem (idempotente).
 * Ordem importa: academies → academy_units → academy_roles →
 *   academy_users → academy_branding → academy_invitations → academy_audit_log
 */
export async function ensureAcademiesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS academies (
      id            SERIAL PRIMARY KEY,
      slug          VARCHAR(100) UNIQUE NOT NULL,
      legal_name    VARCHAR(255) NOT NULL,
      display_name  VARCHAR(255) NOT NULL,
      status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'cancelled', 'trial')),
      plan_id       INTEGER,
      owner_user_id INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_academies_slug   ON academies(slug);
    CREATE INDEX IF NOT EXISTS idx_academies_status ON academies(status);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_units (
      id          SERIAL PRIMARY KEY,
      academy_id  INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      name        VARCHAR(255) NOT NULL,
      address     TEXT,
      status      VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_academy_units_academy_id ON academy_units(academy_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_roles (
      id          SERIAL PRIMARY KEY,
      academy_id  INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      slug        VARCHAR(50) NOT NULL,
      label       VARCHAR(100) NOT NULL,
      permissions JSONB NOT NULL DEFAULT '[]',
      is_system   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (academy_id, slug)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_academy_roles_academy_id ON academy_roles(academy_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_users (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id       INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      academy_unit_id  INTEGER REFERENCES academy_units(id),
      role_id          INTEGER NOT NULL REFERENCES academy_roles(id),
      status           VARCHAR(20) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive', 'pending', 'suspended')),
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      invited_by       INTEGER REFERENCES users(id),
      joined_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, academy_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_academy_users_user_id    ON academy_users(user_id);
    CREATE INDEX IF NOT EXISTS idx_academy_users_academy_id ON academy_users(academy_id);
    CREATE INDEX IF NOT EXISTS idx_academy_users_active     ON academy_users(academy_id, is_active);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_branding (
      id              SERIAL PRIMARY KEY,
      academy_id      INTEGER NOT NULL UNIQUE REFERENCES academies(id) ON DELETE CASCADE,
      logo_url        VARCHAR(500),
      display_name    VARCHAR(255),
      primary_color   VARCHAR(7),
      primary_hover   VARCHAR(7),
      accent_color    VARCHAR(7),
      welcome_message TEXT,
      theme           VARCHAR(20) DEFAULT 'default'
                        CHECK (theme IN ('default', 'dark', 'light')),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_invitations (
      id          SERIAL PRIMARY KEY,
      academy_id  INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      email       VARCHAR(255) NOT NULL,
      role_id     INTEGER NOT NULL REFERENCES academy_roles(id),
      token       VARCHAR(128) UNIQUE NOT NULL,
      invited_by  INTEGER NOT NULL REFERENCES users(id),
      expires_at  TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_academy_invitations_token      ON academy_invitations(token);
    CREATE INDEX IF NOT EXISTS idx_academy_invitations_academy_id ON academy_invitations(academy_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS academy_audit_log (
      id          BIGSERIAL PRIMARY KEY,
      academy_id  INTEGER NOT NULL REFERENCES academies(id),
      user_id     INTEGER REFERENCES users(id),
      action      VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id   INTEGER,
      meta        JSONB,
      ip_address  INET,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_academy_created
      ON academy_audit_log(academy_id, created_at DESC);
  `);
}
