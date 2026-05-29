import pool from '../config/database';

export type WorkoutType = 'sparring' | 'technical' | 'physical' | 'competition' | 'other';
export type FatigueLevel = 'low' | 'moderate' | 'high';

export interface PostWorkoutCheckinData {
  duration_min: number;
  workout_type: WorkoutType;
  rpe: number;
  muscle_soreness_post: number;
  joint_soreness_post: number;
}

export interface PostWorkoutCheckin extends PostWorkoutCheckinData {
  id: number;
  user_id: number;
  checkin_date: string;
  estimated_load: number | null;
  recovery_gap: number | null;
  created_at: string;
  updated_at: string;
}

export interface Fatigue7dResult {
  fatigue_7d: number;
  level: FatigueLevel;
  sessions_7d: number;
}

const TYPE_FACTOR: Record<WorkoutType, number> = {
  sparring: 1.2,
  competition: 1.5,
  technical: 0.8,
  physical: 1.0,
  other: 1.0,
};

export function calcEstimatedLoad(rpe: number, durationMin: number, workoutType: WorkoutType): number {
  const factor = TYPE_FACTOR[workoutType] ?? 1.0;
  return Math.min(100, Math.max(0, rpe * (durationMin / 60) * factor));
}

export function calcFatigueLevel(fatigue7d: number): FatigueLevel {
  if (fatigue7d >= 80) return 'high';
  if (fatigue7d >= 60) return 'moderate';
  return 'low';
}

export async function createPostWorkoutCheckin(
  userId: number,
  data: PostWorkoutCheckinData,
): Promise<PostWorkoutCheckin> {
  const estimatedLoad = calcEstimatedLoad(data.rpe, data.duration_min, data.workout_type);

  // Look up pre-workout readiness final_score for today (recovery_gap = readiness - load)
  const preResult = await pool.query<{ final_score: number }>(
    `SELECT final_score FROM athlete_readiness_snapshot
     WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
    [userId],
  );
  const recoveryGap =
    preResult.rows.length > 0 ? preResult.rows[0].final_score - estimatedLoad : null;

  const { rows } = await pool.query<PostWorkoutCheckin>(
    `INSERT INTO athlete_post_workout_checkin
       (user_id, checkin_date, duration_min, workout_type, rpe,
        muscle_soreness_post, joint_soreness_post, estimated_load, recovery_gap)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, checkin_date) DO UPDATE SET
       duration_min         = EXCLUDED.duration_min,
       workout_type         = EXCLUDED.workout_type,
       rpe                  = EXCLUDED.rpe,
       muscle_soreness_post = EXCLUDED.muscle_soreness_post,
       joint_soreness_post  = EXCLUDED.joint_soreness_post,
       estimated_load       = EXCLUDED.estimated_load,
       recovery_gap         = EXCLUDED.recovery_gap,
       updated_at           = NOW()
     RETURNING *`,
    [
      userId,
      data.duration_min,
      data.workout_type,
      data.rpe,
      data.muscle_soreness_post,
      data.joint_soreness_post,
      estimatedLoad,
      recoveryGap,
    ],
  );
  return rows[0];
}

export async function listPostWorkoutCheckins(
  userId: number,
  from?: string,
  to?: string,
): Promise<PostWorkoutCheckin[]> {
  const conditions = ['user_id = $1'];
  const params: (number | string)[] = [userId];

  if (from) {
    params.push(from);
    conditions.push(`checkin_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`checkin_date <= $${params.length}`);
  }

  const { rows } = await pool.query<PostWorkoutCheckin>(
    `SELECT * FROM athlete_post_workout_checkin
     WHERE ${conditions.join(' AND ')}
     ORDER BY checkin_date DESC`,
    params,
  );
  return rows;
}

export async function getFatigue7d(userId: number): Promise<Fatigue7dResult> {
  const { rows } = await pool.query<{ fatigue_7d: string; sessions_7d: string }>(
    `SELECT COALESCE(AVG(estimated_load), 0)::numeric(5,2) AS fatigue_7d,
            COUNT(*) AS sessions_7d
     FROM athlete_post_workout_checkin
     WHERE user_id = $1
       AND checkin_date >= CURRENT_DATE - INTERVAL '6 days'
       AND estimated_load IS NOT NULL`,
    [userId],
  );

  const fatigue7d = parseFloat(rows[0].fatigue_7d ?? '0');
  const sessions7d = parseInt(rows[0].sessions_7d ?? '0', 10);

  return {
    fatigue_7d: fatigue7d,
    level: calcFatigueLevel(fatigue7d),
    sessions_7d: sessions7d,
  };
}

export async function getLastRecoveryGap(userId: number): Promise<number | null> {
  const { rows } = await pool.query<{ recovery_gap: string | null }>(
    `SELECT recovery_gap
     FROM athlete_post_workout_checkin
     WHERE user_id = $1 AND recovery_gap IS NOT NULL
     ORDER BY checkin_date DESC
     LIMIT 1`,
    [userId],
  );
  if (rows.length === 0 || rows[0].recovery_gap === null) return null;
  return parseFloat(rows[0].recovery_gap);
}
