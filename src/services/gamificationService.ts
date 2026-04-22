import pool from '../config/database';
import { invalidateMetabolismSnapshot } from '../modules/metabolism/metabolic.service';

type CheckinSource = 'workout' | 'activity';
type MuscleGroup =
  | 'chest'
  | 'back'
  | 'legs'
  | 'shoulders'
  | 'arms'
  | 'core'
  | 'full_body'
  | 'cardio'
  | 'mobility';

type RecordCheckinInput = {
  userId: number;
  source: CheckinSource;
  xp: number;
  workout?: {
    workoutId: string;
    title: string;
    muscleGroups: MuscleGroup[];
  };
  activity?: {
    type: 'walk' | 'run' | 'cycling';
    durationSeconds: number;
    distanceKm: number;
    pace: number;
  };
};

function todayDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeLevel(xp: number) {
  return Math.max(1, Math.floor(xp / 100) + 1);
}

export async function recordGamificationCheckin(input: RecordCheckinInput) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
       VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId]
    );

    if (input.workout) {
      await client.query(
        `INSERT INTO user_workout_logs (user_id, workout_id, title, muscle_groups)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, input.workout.workoutId, input.workout.title, input.workout.muscleGroups]
      );
    }

    if (input.activity) {
      await client.query(
        `INSERT INTO user_activity_logs (user_id, activity_type, duration_seconds, distance_km, pace)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.userId, input.activity.type, input.activity.durationSeconds, input.activity.distanceKm, input.activity.pace]
      );
    }

    const dateKey = todayDateKey();
    const existingCheckin = await client.query(
      `SELECT id FROM user_daily_checkins WHERE user_id = $1 AND date_key = $2`,
      [input.userId, dateKey]
    );

    let alreadyCheckedIn = existingCheckin.rows.length > 0;

    if (!alreadyCheckedIn) {
      await client.query(
        `INSERT INTO user_daily_checkins (user_id, date_key, source, xp_awarded)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, dateKey, input.source, input.xp]
      );

      const statsResult = await client.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1
         FOR UPDATE`,
        [input.userId]
      );

      const stats = statsResult.rows[0] || { xp: 0, current_streak: 0, last_checkin_date: null };
      const previousDate = stats.last_checkin_date ? new Date(stats.last_checkin_date) : null;
      const currentDate = new Date(dateKey);

      let nextStreak = Number(stats.current_streak || 0);
      if (!previousDate) {
        nextStreak = 1;
      } else {
        const previousUtc = Date.UTC(previousDate.getFullYear(), previousDate.getMonth(), previousDate.getDate());
        const currentUtc = Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const diffDays = Math.floor((currentUtc - previousUtc) / (1000 * 60 * 60 * 24));
        nextStreak = diffDays === 1 ? nextStreak + 1 : 1;
      }

      const nextXp = Number(stats.xp || 0) + input.xp;
      await client.query(
        `UPDATE user_gamification_stats
         SET xp = $2, current_streak = $3, last_checkin_date = $4, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [input.userId, nextXp, nextStreak, dateKey]
      );
    }

    await client.query('COMMIT');

    // Invalida snapshot do dia para que o próximo GET recalcule com os dados atualizados
    void invalidateMetabolismSnapshot(input.userId).catch((err) =>
      console.error('[metabolism] invalidate snapshot error:', err),
    );

    return await getGamificationSummary(input.userId, alreadyCheckedIn);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getGamificationSummary(userId: number, alreadyCheckedIn = false) {
  const statsResult = await pool.query(
    `SELECT xp, current_streak, last_checkin_date
     FROM user_gamification_stats
     WHERE user_id = $1`,
    [userId]
  );

  const stats = statsResult.rows[0] || { xp: 0, current_streak: 0, last_checkin_date: null };

  const checkinResult = await pool.query(
    `SELECT date_key FROM user_daily_checkins
     WHERE user_id = $1
     ORDER BY date_key DESC
     LIMIT 7`,
    [userId]
  );

  const lastWorkoutResult = await pool.query(
    `SELECT workout_id, title, muscle_groups, completed_at
     FROM user_workout_logs
     WHERE user_id = $1
     ORDER BY completed_at DESC
     LIMIT 1`,
    [userId]
  );

  return {
    xp: Number(stats.xp || 0),
    level: normalizeLevel(Number(stats.xp || 0)),
    streak: Number(stats.current_streak || 0),
    todayCheckedIn: checkinResult.rows.some((row: any) => row.date_key?.toISOString?.().slice(0, 10) === todayDateKey()),
    alreadyCheckedIn,
    heatmap: checkinResult.rows.map((row: any) => row.date_key?.toISOString?.().slice(0, 10)).filter(Boolean),
    lastWorkout: lastWorkoutResult.rows[0]
      ? {
          workoutId: lastWorkoutResult.rows[0].workout_id,
          title: lastWorkoutResult.rows[0].title,
          muscleGroups: lastWorkoutResult.rows[0].muscle_groups || [],
          completedAt: lastWorkoutResult.rows[0].completed_at,
        }
      : null,
  };
}
