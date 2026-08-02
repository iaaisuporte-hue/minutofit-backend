import pool from '../../config/database';
import type { MetabolicFactor, MetabolicHistory, MetabolicInput } from './metabolic.types';

interface UserProfile {
  ageYears: number | null;
  accountAgeDays: number | null;
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
       experience_level,
       (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::int AS account_age_days
     FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    ageYears: row?.age_years ?? null,
    accountAgeDays: row?.account_age_days ?? null,
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
  // Frequência de treino conta DIAS DISTINTOS de duas fontes, sem dobrar (padrão
  // Spec 009): o check-in de gamificação (user_workout_logs) E a execução real
  // (workout_sessions, status completed/partial). Antes só contava o primeiro —
  // sessões reais viravam "dado fantasma" para o score metabólico.
  const [w7, w28, muscles, minutes, cardio, lastActivity] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT date_trunc('day', completed_at) AS day FROM user_workout_logs
           WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '7 days'
         UNION
         SELECT date_trunc('day', started_at) AS day FROM workout_sessions
           WHERE user_id = $1 AND status IN ('completed', 'partial')
             AND started_at >= NOW() - INTERVAL '7 days'
       ) d`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT date_trunc('day', completed_at) AS day FROM user_workout_logs
           WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '28 days'
         UNION
         SELECT date_trunc('day', started_at) AS day FROM workout_sessions
           WHERE user_id = $1 AND status IN ('completed', 'partial')
             AND started_at >= NOW() - INTERVAL '28 days'
       ) d`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT mg)::int AS count
       FROM user_workout_logs, unnest(muscle_groups) AS mg
       WHERE user_id = $1 AND completed_at >= NOW() - INTERVAL '14 days'`,
      [userId],
    ),
    // Atividade (GPS) vem de DUAS tabelas: `activity_sessions` (a sessão rica,
    // gravada por POST /activities) e `user_activity_logs` (a projeção do
    // check-in de gamificação). O Tracker escreve nas duas para a MESMA corrida,
    // então somar direto dobraria. Dedupe por (dia, tipo) pegando o maior valor —
    // mesmo padrão que a frequência de treino já usa acima. Antes o motor lia só
    // a projeção: se o check-in falhasse, a corrida sumia do score.
    pool.query(
      `SELECT COALESCE(SUM(secs) / 60, 0)::int AS minutes FROM (
         SELECT day, activity_type, MAX(duration_seconds) AS secs FROM (
           SELECT date_trunc('day', created_at) AS day, activity_type, duration_seconds
             FROM user_activity_logs
             WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
           UNION ALL
           SELECT date_trunc('day', started_at) AS day, activity_type, duration_seconds
             FROM activity_sessions
             WHERE user_id = $1 AND started_at >= NOW() - INTERVAL '7 days'
         ) a GROUP BY day, activity_type
       ) d`,
      [userId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT date_trunc('day', created_at) AS day, activity_type
           FROM user_activity_logs
           WHERE user_id = $1 AND activity_type IN ('run', 'cycling', 'cardio')
             AND created_at >= NOW() - INTERVAL '14 days'
         UNION
         SELECT date_trunc('day', started_at) AS day, activity_type
           FROM activity_sessions
           WHERE user_id = $1 AND activity_type IN ('run', 'cycling', 'cardio')
             AND started_at >= NOW() - INTERVAL '14 days'
       ) d`,
      [userId],
    ),
    // Dias desde a atividade MAIS RECENTE entre as três fontes (workout log,
    // sessão executada, atividade). Corrige também o agregado anterior, que usava
    // GREATEST de dois MAX (retornava a atividade MENOS recente).
    pool.query(
      `SELECT (EXTRACT(EPOCH FROM (NOW() - MAX(ts))) / 86400)::int AS days
       FROM (
         SELECT completed_at AS ts FROM user_workout_logs WHERE user_id = $1
         UNION ALL
         SELECT started_at AS ts FROM workout_sessions
           WHERE user_id = $1 AND status IN ('completed', 'partial')
         UNION ALL
         SELECT created_at AS ts FROM user_activity_logs WHERE user_id = $1
         UNION ALL
         SELECT started_at AS ts FROM activity_sessions WHERE user_id = $1
       ) t`,
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
