import pool from '../config/database';
import type { SportProfile } from '../types/sport';
import { isValidSportKey } from './sportsEngine';

export async function getSportProfile(userId: number): Promise<SportProfile | null> {
  const { rows } = await pool.query<SportProfile>(
    `SELECT user_id, primary_sport, sport_level, graduation_rank,
            weekly_frequency, competes, primary_goal,
            current_weight_kg, target_weight_kg,
            coach_name, nutri_name, active, created_at, updated_at
     FROM user_sport_profile WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function upsertSportProfile(
  userId: number,
  data: Partial<Omit<SportProfile, 'user_id' | 'created_at' | 'updated_at'>>,
): Promise<SportProfile> {
  if (data.primary_sport && !isValidSportKey(data.primary_sport)) {
    throw Object.assign(new Error(`Sport '${data.primary_sport}' not registered`), { status: 400 });
  }

  const { rows } = await pool.query<SportProfile>(
    `INSERT INTO user_sport_profile
       (user_id, primary_sport, sport_level, graduation_rank, weekly_frequency,
        competes, primary_goal, current_weight_kg, target_weight_kg,
        coach_name, nutri_name, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
     ON CONFLICT (user_id) DO UPDATE SET
       primary_sport     = COALESCE(EXCLUDED.primary_sport, user_sport_profile.primary_sport),
       sport_level       = COALESCE(EXCLUDED.sport_level, user_sport_profile.sport_level),
       graduation_rank   = COALESCE(EXCLUDED.graduation_rank, user_sport_profile.graduation_rank),
       weekly_frequency  = COALESCE(EXCLUDED.weekly_frequency, user_sport_profile.weekly_frequency),
       competes          = COALESCE(EXCLUDED.competes, user_sport_profile.competes),
       primary_goal      = COALESCE(EXCLUDED.primary_goal, user_sport_profile.primary_goal),
       current_weight_kg = EXCLUDED.current_weight_kg,
       target_weight_kg  = EXCLUDED.target_weight_kg,
       coach_name        = EXCLUDED.coach_name,
       nutri_name        = EXCLUDED.nutri_name,
       active            = true,
       updated_at        = NOW()
     RETURNING user_id, primary_sport, sport_level, graduation_rank,
               weekly_frequency, competes, primary_goal,
               current_weight_kg, target_weight_kg,
               coach_name, nutri_name, active, created_at, updated_at`,
    [
      userId,
      data.primary_sport ?? 'jiu_jitsu',
      data.sport_level ?? 'intermediate',
      data.graduation_rank ?? null,
      data.weekly_frequency ?? 3,
      data.competes ?? false,
      data.primary_goal ?? 'performance',
      data.current_weight_kg ?? null,
      data.target_weight_kg ?? null,
      data.coach_name ?? null,
      data.nutri_name ?? null,
    ],
  );
  return rows[0];
}

export async function deactivateSportProfile(userId: number): Promise<void> {
  await pool.query(
    `UPDATE user_sport_profile SET active = false, updated_at = NOW() WHERE user_id = $1`,
    [userId],
  );
}
