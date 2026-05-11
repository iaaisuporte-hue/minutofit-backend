import pool from '../config/database';

/**
 * Idempotente — adiciona student_status a academy_users e cria
 * academy_plans + academy_enrollments para suportar a operação de alunos.
 *
 * Deve rodar APÓS ensureAcademiesSchema().
 */
export async function ensureStudentsSchema(): Promise<void> {
  try {
    // 1. student_status + campos operacionais na tabela de vínculo
    await pool.query(`
      ALTER TABLE academy_users
        ADD COLUMN IF NOT EXISTS student_status VARCHAR(20)
          CHECK (student_status IN ('lead','active','overdue','paused','cancelled'))
    `);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS payment_method VARCHAR(60)`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS main_goal TEXT`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS medical_restrictions TEXT`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(200)`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(30)`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE academy_users ADD COLUMN IF NOT EXISTS accepted_lgpd_at TIMESTAMPTZ`);

    // 1b. Campos demográficos no perfil do usuário
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`);

    // 2. Planos da academia
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academy_plans (
        id                  SERIAL PRIMARY KEY,
        academy_id          INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
        name                VARCHAR(200) NOT NULL,
        description         TEXT,
        monthly_price       NUMERIC(10,2) NOT NULL DEFAULT 0,
        billing_cycle_days  INTEGER NOT NULL DEFAULT 30,
        status              VARCHAR(20) NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','archived')),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (academy_id, name)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_academy_plans_academy_status ON academy_plans(academy_id, status)`);

    // 3. Matrículas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academy_enrollments (
        id          SERIAL PRIMARY KEY,
        academy_id  INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id     INTEGER REFERENCES academy_plans(id),
        start_date  DATE NOT NULL,
        end_date    DATE,
        status      VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','paused','cancelled')),
        notes       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_academy_enrollments_academy_user ON academy_enrollments(academy_id, user_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_academy_enrollments_academy_status ON academy_enrollments(academy_id, status)`);

    console.log('[db] ensureStudentsSchema: OK');
  } catch (err) {
    console.error('[db] ensureStudentsSchema:', err);
    throw err;
  }
}
