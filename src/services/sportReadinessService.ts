import pool from '../config/database';
import type { ReadinessSnapshot } from '../types/sport';
import { getSportConfig, computeSportReadiness } from './sportsEngine';
import { getSportProfile } from './sportProfileService';
import { getTodayCheckin } from './sportCheckinService';

async function getWeeklyLoadCount(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM user_workout_logs
     WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '7 days'`,
    [userId],
  );
  return rows[0]?.cnt ?? 0;
}

async function getActiveCampDaysRemaining(userId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT event_date FROM athlete_competition_camp
     WHERE user_id = $1 AND status = 'active'
       AND event_date >= CURRENT_DATE
     ORDER BY event_date ASC LIMIT 1`,
    [userId],
  );
  if (!rows[0]) return null;
  const ms = new Date(rows[0].event_date).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

async function getCachedSnapshot(userId: number): Promise<ReadinessSnapshot | null> {
  const { rows } = await pool.query(
    `SELECT id, user_id, snapshot_date, metabolic_score, sport_modifier, final_score,
            sport_factors, recommendation, risk_level, created_at, updated_at
     FROM athlete_readiness_snapshot
     WHERE user_id = $1 AND snapshot_date = CURRENT_DATE LIMIT 1`,
    [userId],
  );
  if (!rows[0]) return null;
  return { ...rows[0], has_checkin_today: true };
}

async function getMetabolicScore(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT score FROM user_metabolism_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC LIMIT 1`,
    [userId],
  );
  return rows[0]?.score ?? 50;
}

export async function getReadinessToday(userId: number): Promise<ReadinessSnapshot | null> {
  // Return cached snapshot if present
  const cached = await getCachedSnapshot(userId);
  if (cached) return cached;

  const [profile, checkin] = await Promise.all([
    getSportProfile(userId),
    getTodayCheckin(userId),
  ]);

  if (!profile?.active || !checkin) return null;

  const sportConfig = getSportConfig(profile.primary_sport);
  if (!sportConfig) return null;

  const [weeklyLoadCount, campDaysRemaining, metabolicScore] = await Promise.all([
    getWeeklyLoadCount(userId),
    getActiveCampDaysRemaining(userId),
    getMetabolicScore(userId),
  ]);

  const sportContext = computeSportReadiness({
    sportConfig,
    checkin,
    weeklyLoadCount,
    campDaysRemaining,
  });

  const finalScore = Math.max(0, Math.min(100, metabolicScore + sportContext.modifier));

  // Persist snapshot
  const { rows } = await pool.query(
    `INSERT INTO athlete_readiness_snapshot
       (user_id, metabolic_score, sport_modifier, final_score,
        sport_factors, recommendation, risk_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
       metabolic_score = EXCLUDED.metabolic_score,
       sport_modifier  = EXCLUDED.sport_modifier,
       final_score     = EXCLUDED.final_score,
       sport_factors   = EXCLUDED.sport_factors,
       recommendation  = EXCLUDED.recommendation,
       risk_level      = EXCLUDED.risk_level,
       updated_at      = NOW()
     RETURNING id, user_id, snapshot_date, metabolic_score, sport_modifier,
               final_score, sport_factors, recommendation, risk_level, created_at, updated_at`,
    [
      userId,
      metabolicScore,
      sportContext.modifier,
      finalScore,
      JSON.stringify(sportContext.factors),
      sportContext.recommendation,
      sportContext.risk_level,
    ],
  );

  return { ...rows[0], has_checkin_today: true };
}
