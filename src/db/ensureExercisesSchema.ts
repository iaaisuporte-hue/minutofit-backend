import pool from '../config/database';

/**
 * Cria as tabelas exercises e exercise_media caso não existam.
 * Executado automaticamente no boot do servidor.
 * Idempotente — IF NOT EXISTS em todas as queries.
 */
export async function ensureExercisesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercises (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source       VARCHAR(64)  NOT NULL DEFAULT 'metacore',
      external_id  VARCHAR(255),
      name         VARCHAR(255) NOT NULL,
      normalized_name VARCHAR(255) NOT NULL,
      body_part    VARCHAR(100) NOT NULL DEFAULT '',
      target_muscle   VARCHAR(200) NOT NULL DEFAULT '',
      secondary_muscles TEXT[] NOT NULL DEFAULT '{}',
      equipment    VARCHAR(100) NOT NULL DEFAULT '',
      tags         TEXT[] NOT NULL DEFAULT '{}',
      instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
      tips         JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT exercises_name_source_uq UNIQUE (normalized_name, source)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exercises_normalized_name
    ON exercises (normalized_name)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exercises_body_part
    ON exercises (body_part)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exercises_equipment
    ON exercises (equipment)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercise_media (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      media_type  VARCHAR(16) NOT NULL CHECK (media_type IN ('gif','image','video','youtube')),
      url         TEXT NOT NULL,
      source      VARCHAR(64),
      is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT exercise_media_exercise_url_uq UNIQUE (exercise_id, url)
    )
  `);

  // Add unique constraint idempotently on existing tables that may not have it
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'exercise_media_exercise_url_uq'
      ) THEN
        ALTER TABLE exercise_media
          ADD CONSTRAINT exercise_media_exercise_url_uq UNIQUE (exercise_id, url);
      END IF;
    END$$
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exercise_media_exercise_id
    ON exercise_media (exercise_id)
  `);
}
