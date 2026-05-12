import pool from '../config/database';

/**
 * Daily well-being signals (Onda 4) + source value `wellbeing` for mood-only check-ins.
 * All new columns nullable for backward compatibility.
 */
export async function ensureDailyCheckinSignalsSchema(): Promise<void> {
  await pool.query(`
    ALTER TABLE user_daily_checkins
      DROP CONSTRAINT IF EXISTS user_daily_checkins_source_check
  `);
  await pool.query(`
    ALTER TABLE user_daily_checkins
      ADD CONSTRAINT user_daily_checkins_source_check
      CHECK (source IN ('workout', 'activity', 'wellbeing'))
  `);

  await pool.query(`
    ALTER TABLE user_daily_checkins ADD COLUMN IF NOT EXISTS feeling VARCHAR(20)
  `);
  await pool.query(`
    ALTER TABLE user_daily_checkins ADD COLUMN IF NOT EXISTS slept_well BOOLEAN
  `);
  await pool.query(`
    ALTER TABLE user_daily_checkins ADD COLUMN IF NOT EXISTS in_pain BOOLEAN
  `);
  await pool.query(`
    ALTER TABLE user_daily_checkins ADD COLUMN IF NOT EXISTS stressed BOOLEAN
  `);
  await pool.query(`
    ALTER TABLE user_daily_checkins ADD COLUMN IF NOT EXISTS notes TEXT
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_daily_checkins_feeling_check'
      ) THEN
        ALTER TABLE user_daily_checkins
          ADD CONSTRAINT user_daily_checkins_feeling_check
          CHECK (feeling IS NULL OR feeling IN ('energized', 'neutral', 'tired'));
      END IF;
    END $$;
  `);
}
