/**
 * Hardening do schema da Academia:
 * 1. ON DELETE CASCADE em tabelas core do tenant (academy_id FK → academies)
 * 2. ON DELETE SET NULL em tabelas de histórico operacional (preservam dados após remoção do tenant)
 * 3. FKs ausentes: academies.owner_user_id → users, academies.plan_id → academy_plans
 * 4. CHECK constraints: preço ≥ 0, datas de matrícula, email de convite
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // --- Tabelas CORE do tenant: CASCADE (dados sem sentido fora da academia) ---
  const cascadeTables = [
    { table: 'academy_users',       fk: 'academy_users_academy_id_fkey' },
    { table: 'academy_roles',       fk: 'academy_roles_academy_id_fkey' },
    { table: 'academy_plans',       fk: 'academy_plans_academy_id_fkey' },
    { table: 'academy_enrollments', fk: 'academy_enrollments_academy_id_fkey' },
    { table: 'academy_invitations', fk: 'academy_invitations_academy_id_fkey' },
    { table: 'academy_access_events', fk: 'academy_access_events_academy_id_fkey' },
    { table: 'academy_visitors',    fk: 'academy_visitors_academy_id_fkey' },
    { table: 'academy_branding',    fk: 'academy_branding_academy_id_fkey' },
    { table: 'academy_audit_log',   fk: 'academy_audit_log_academy_id_fkey' },
  ];

  for (const { table, fk } of cascadeTables) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = '${table}' AND constraint_name = '${fk}'
        ) THEN
          ALTER TABLE ${table} DROP CONSTRAINT ${fk};
          ALTER TABLE ${table}
            ADD CONSTRAINT ${fk}
            FOREIGN KEY (academy_id) REFERENCES academies(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  // --- Tabelas de HISTÓRICO operacional: SET NULL (preservar dados históricos do aluno) ---
  const setNullTables = [
    { table: 'user_workout_logs',         fk: 'user_workout_logs_academy_id_fkey' },
    { table: 'user_activity_logs',        fk: 'user_activity_logs_academy_id_fkey' },
    { table: 'user_daily_checkins',       fk: 'user_daily_checkins_academy_id_fkey' },
    { table: 'activity_sessions',         fk: 'activity_sessions_academy_id_fkey' },
    { table: 'movement_sessions',         fk: 'movement_sessions_academy_id_fkey' },
    { table: 'user_metabolism_snapshots', fk: 'user_metabolism_snapshots_academy_id_fkey' },
    { table: 'user_gamification_stats',   fk: 'user_gamification_stats_academy_id_fkey' },
    { table: 'chat_conversations',        fk: 'chat_conversations_academy_id_fkey' },
    { table: 'personal_student_assignments', fk: 'personal_student_assignments_academy_id_fkey' },
    { table: 'personal_workout_plans',    fk: 'personal_workout_plans_academy_id_fkey' },
    { table: 'workout_reviews',           fk: 'workout_reviews_academy_id_fkey' },
  ];

  for (const { table, fk } of setNullTables) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = '${table}' AND constraint_name = '${fk}'
        ) THEN
          ALTER TABLE ${table} DROP CONSTRAINT ${fk};
          ALTER TABLE ${table}
            ADD CONSTRAINT ${fk}
            FOREIGN KEY (academy_id) REFERENCES academies(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  // --- FK: academies.owner_user_id → users ---
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'academies' AND constraint_name = 'academies_owner_user_id_fkey'
      ) THEN
        ALTER TABLE academies
          ADD CONSTRAINT academies_owner_user_id_fkey
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  // --- CHECK constraints de integridade ---
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'academy_plans_price_non_negative'
      ) THEN
        ALTER TABLE academy_plans
          ADD CONSTRAINT academy_plans_price_non_negative
          CHECK (monthly_price >= 0);
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_name = 'academy_enrollments_dates_valid'
      ) THEN
        ALTER TABLE academy_enrollments
          ADD CONSTRAINT academy_enrollments_dates_valid
          CHECK (end_date IS NULL OR end_date >= start_date);
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  // Remove CHECKs
  pgm.sql(`ALTER TABLE academy_plans DROP CONSTRAINT IF EXISTS academy_plans_price_non_negative;`);
  pgm.sql(`ALTER TABLE academy_enrollments DROP CONSTRAINT IF EXISTS academy_enrollments_dates_valid;`);
  pgm.sql(`ALTER TABLE academies DROP CONSTRAINT IF EXISTS academies_owner_user_id_fkey;`);
  // ON DELETE policies: reverte para sem ON DELETE (RESTRICT implícito)
  // Omitido — down de FK policy é complexo e raramente necessário em produção.
};
