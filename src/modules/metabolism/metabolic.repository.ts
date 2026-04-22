import pool from '../../config/database';
import type { MetabolicFactor, MetabolicHistory, MetabolicInput } from './metabolic.types';

interface UserProfile {
  ageYears: number | null;
  fitnessGoal: string | null;
  experienceLevel: string | null;
}

export async function loadUserProfile(userId: number): Promise<UserProfile> {
  const result = await pool.query(
    `SELECT
       CASE WHEN date_of_birth IS NOT NULL
         THEN EXTRACT(YEAR FROM AGE(date_of_birth))::int
         ELSE NULL
       END AS age_years,
       fitness_goal,
       experience_level
     FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    ageYears: row?.age_years ?? null,
    fitnessGoal: row?.fitness_goal ?? null,
    experienceLevel: row?.experience_level ?? null,
  };
}

export async function loadActivityMetrics(userId: number): Promise<{
  workoutsLast7Days: number;
  workoutsLast28Days: number;
  distinctMuscleGroupsLast14Days: number;
  activityMinutesLast7Days: number;
  cardioSessionsLast14Days: number;
  daysSinceLastActivity: number | null;
}> {
  const [w7, w28, muscles, minutes, cardio, lastActivity] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM user_workout_logs
       WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '7 days'`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM user_workout_logs
       WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '28 days'`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT mg)::int AS count
       FROM user_workout_logs, unnest(muscle_groups) AS mg
       WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '14 days'`,
      [userId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(duration_seconds) / 60, 0)::int AS minutes
       FROM user_activity_logs
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM user_activity_logs
       WHERE user_id = $1
         AND activity_type IN ('run', 'cycling', 'cardio')
         AND created_at >= NOW() - INTERVAL '14 days'`,
      [userId],
    ),
    pool.query(
      `SELECT GREATEST(
         EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 86400,
         EXTRACT(EPOCH FROM (NOW() - MAX(al.created_at))) / 86400
       )::int AS days
       FROM user_workout_logs wl
       FULL OUTER JOIN user_activity_logs al ON al.user_id = wl.user_id AND al.user_id = $1
       WHERE wl.user_id = $1 OR al.user_id = $1`,
      [userId],
    ),
  ]);

  return {
    workoutsLast7Days: w7.rows[0]?.count ?? 0,
    workoutsLast28Days: w28.rows[0]?.count ?? 0,
    distinctMuscleGroupsLast14Days: muscles.rows[0]?.count ?? 0,
    activityMinutesLast7Days: minutes.rows[0]?.minutes ?? 0,
    cardioSessionsLast14Days: cardio.rows[0]?.count ?? 0,
    daysSinceLastActivity: lastActivity.rows[0]?.days ?? null,
  };
}

export async function loadStreakInfo(userId: number): Promise<{ currentStreakDays: number }> {
  const result = await pool.query(
    `SELECT COALESCE(current_streak, 0)::int AS current_streak
     FROM user_gamification_stats WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return { currentStreakDays: result.rows[0]?.current_streak ?? 0 };
}

export async function loadSnapshots(userId: number, days = 14): Promise<MetabolicHistory> {
  const result = await pool.query(
    `SELECT snapshot_date::text AS date, score
     FROM user_metabolism_snapshots
     WHERE user_id = $1 AND snapshot_date >= NOW() - ($2 || ' days')::interval
     ORDER BY snapshot_date ASC`,
    [userId, days],
  );
  return result.rows.map((r) => ({ date: r.date, score: Number(r.score) }));
}

export async function loadTodaySnapshot(userId: number) {
  const result = await pool.query(
    `SELECT score, status, trend, factors, inputs, created_at
     FROM user_metabolism_snapshots
     WHERE user_id = $1 AND snapshot_date = CURRENT_DATE
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function upsertSnapshot(
  userId: number,
  score: number,
  status: string,
  trend: string,
  factors: MetabolicFactor[],
  inputs: MetabolicInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_metabolism_snapshots (user_id, snapshot_date, score, status, trend, factors, inputs)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, snapshot_date) DO UPDATE
       SET score = EXCLUDED.score,
           status = EXCLUDED.status,
           trend = EXCLUDED.trend,
           factors = EXCLUDED.factors,
           inputs = EXCLUDED.inputs,
           created_at = NOW()`,
    [userId, score, status, trend, JSON.stringify(factors), JSON.stringify(inputs)],
  );
}

export async function invalidateTodaySnapshot(userId: number): Promise<void> {
  await pool.query(
    `DELETE FROM user_metabolism_snapshots WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
    [userId],
  );
}
