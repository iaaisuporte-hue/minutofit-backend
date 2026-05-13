import pool from '../config/database';

/**
 * Schema operacional da Recepção.
 *
 * Mantém presença física separada de user_daily_checkins, que continua sendo
 * sinal de gamificação/bem-estar/treino do aluno.
 */
export async function ensureReceptionSchema(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academy_access_events (
        id            SERIAL PRIMARY KEY,
        academy_id    INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
        unit_id       INTEGER REFERENCES academy_units(id) ON DELETE SET NULL,
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        visitor_id    INTEGER,
        event_type    VARCHAR(30) NOT NULL
                        CHECK (event_type IN ('checkin','exception','denied','visitor')),
        source        VARCHAR(40) NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','qr','facial','catraca_vendor_webhook')),
        reason        TEXT,
        performed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS academy_visitors (
        id             SERIAL PRIMARY KEY,
        academy_id     INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
        unit_id        INTEGER REFERENCES academy_units(id) ON DELETE SET NULL,
        name           VARCHAR(200) NOT NULL,
        document       VARCHAR(80),
        visitor_type   VARCHAR(40) NOT NULL DEFAULT 'visitor'
                         CHECK (visitor_type IN ('visitor','external_personal')),
        valid_until    TIMESTAMPTZ,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE academy_access_events ADD COLUMN IF NOT EXISTS visitor_id INTEGER`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'academy_access_events_visitor_id_fkey'
        ) THEN
          ALTER TABLE academy_access_events
            ADD CONSTRAINT academy_access_events_visitor_id_fkey
            FOREIGN KEY (visitor_id) REFERENCES academy_visitors(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_academy_access_events_academy_created
        ON academy_access_events(academy_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_academy_access_events_academy_user_created
        ON academy_access_events(academy_id, user_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_academy_access_events_academy_type_created
        ON academy_access_events(academy_id, event_type, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_academy_visitors_academy_created
        ON academy_visitors(academy_id, created_at DESC)
    `);

    console.log('[db] ensureReceptionSchema: OK');
  } catch (err) {
    console.error('[db] ensureReceptionSchema:', err);
    throw err;
  }
}
