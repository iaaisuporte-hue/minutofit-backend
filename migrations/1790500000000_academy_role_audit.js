/**
 * A6 — Auditoria de mudanças em academy_roles
 *
 * Cria tabela academy_role_audit e trigger AFTER INSERT/UPDATE/DELETE
 * em academy_roles para registrar quem/quando alterou permissões de role.
 *
 * Por que: roles hardcoded por design no MVP, mas mudanças precisam de rastreabilidade
 * para responder a "quem alterou a permissão X da role Y na academia Z e quando?".
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS academy_role_audit (
      id          BIGSERIAL PRIMARY KEY,
      academy_id  INTEGER REFERENCES academies(id) ON DELETE CASCADE,
      role_id     INTEGER,
      operation   TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
      old_data    JSONB,
      new_data    JSONB,
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_academy_role_audit_academy ON academy_role_audit(academy_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_academy_role_audit_role    ON academy_role_audit(role_id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_academy_role_audit_at      ON academy_role_audit(changed_at DESC);`);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION fn_audit_academy_role()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO academy_role_audit (academy_id, role_id, operation, old_data, new_data)
      VALUES (
        COALESCE(NEW.academy_id, OLD.academy_id),
        COALESCE(NEW.id,         OLD.id),
        TG_OP,
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
      );
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END;
    $$;
  `);

  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_audit_academy_role'
          AND tgrelid = 'academy_roles'::regclass
      ) THEN
        CREATE TRIGGER trg_audit_academy_role
        AFTER INSERT OR UPDATE OR DELETE ON academy_roles
        FOR EACH ROW EXECUTE FUNCTION fn_audit_academy_role();
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_audit_academy_role ON academy_roles;`);
  pgm.sql(`DROP FUNCTION IF EXISTS fn_audit_academy_role;`);
  pgm.sql(`DROP TABLE IF EXISTS academy_role_audit;`);
};
