import pool from '../config/database';
import { invalidateMetabolismSnapshot } from '../modules/metabolism/metabolic.service';
import logger from '../lib/logger';

type CheckinSource = 'workout' | 'activity' | 'wellbeing';
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

export type WellbeingSignals = {
  /** API / DB: energized | neutral | tired */
  feeling?: 'tired' | 'neutral' | 'energized' | null;
  sleptWell?: boolean | null;
  inPain?: boolean | null;
  stressed?: boolean | null;
  notes?: string | null;
};

export type RecordCheckinInput = {
  userId: number;
  academyId?: number | null;
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
  signals?: WellbeingSignals | null;
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

    const academyId = input.academyId ?? null;
    const dateKey = todayDateKey();
    const xpEarned = Math.max(0, Number(input.xp || 0));

    await client.query(
      `INSERT INTO user_gamification_stats (user_id, academy_id, xp, current_streak)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId, academyId],
    );

    if (input.workout) {
      await client.query(
        `INSERT INTO user_workout_logs (user_id, academy_id, workout_id, title, muscle_groups)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.userId, academyId, input.workout.workoutId, input.workout.title, input.workout.muscleGroups],
      );
    }

    if (input.activity) {
      await client.query(
        `INSERT INTO user_activity_logs (user_id, academy_id, activity_type, duration_seconds, distance_km, pace)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.userId,
          academyId,
          input.activity.type,
          input.activity.durationSeconds,
          input.activity.distanceKm,
          input.activity.pace,
        ],
      );
    }

    const existingCheckin = await client.query<{ id: number }>(
      `SELECT id FROM user_daily_checkins WHERE user_id = $1 AND date_key = $2`,
      [input.userId, dateKey],
    );
    const hadRow = existingCheckin.rows.length > 0;

    const sig = input.signals ?? null;
    const feelingVal = sig?.feeling ?? null;
    const sleptWell = sig?.sleptWell;
    const inPain = sig?.inPain;
    const stressed = sig?.stressed;
    const notesVal = sig?.notes?.trim() ? sig.notes.trim() : null;

    const sourceForRow: CheckinSource =
      input.source === 'wellbeing' ? 'wellbeing' : input.source;

    const xpForThisEvent = input.source === 'wellbeing' ? 0 : xpEarned;

    await client.query(
      `INSERT INTO user_daily_checkins (
         user_id, academy_id, date_key, source, xp_awarded,
         feeling, slept_well, in_pain, stressed, notes
       ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, date_key) DO UPDATE SET
         xp_awarded = user_daily_checkins.xp_awarded + EXCLUDED.xp_awarded,
         source = CASE
           WHEN EXCLUDED.source IN ('workout', 'activity') THEN EXCLUDED.source::varchar
           ELSE user_daily_checkins.source::varchar
         END,
         feeling = COALESCE(EXCLUDED.feeling, user_daily_checkins.feeling),
         slept_well = CASE
           WHEN EXCLUDED.slept_well IS NOT NULL THEN EXCLUDED.slept_well
           ELSE user_daily_checkins.slept_well
         END,
         in_pain = CASE
           WHEN EXCLUDED.in_pain IS NOT NULL THEN EXCLUDED.in_pain
           ELSE user_daily_checkins.in_pain
         END,
         stressed = CASE
           WHEN EXCLUDED.stressed IS NOT NULL THEN EXCLUDED.stressed
           ELSE user_daily_checkins.stressed
         END,
         notes = COALESCE(EXCLUDED.notes, user_daily_checkins.notes)`,
      [
        input.userId,
        academyId,
        dateKey,
        sourceForRow,
        xpForThisEvent,
        feelingVal,
        sleptWell ?? null,
        inPain ?? null,
        stressed ?? null,
        notesVal,
      ],
    );

    if (!hadRow) {
      const statsResult = await client.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1
         FOR UPDATE`,
        [input.userId],
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

      const nextXp = Number(stats.xp || 0) + xpForThisEvent;
      await client.query(
        `UPDATE user_gamification_stats
         SET xp = $2, current_streak = $3, last_checkin_date = $4::date, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [input.userId, nextXp, nextStreak, dateKey],
      );
    } else if (xpForThisEvent > 0) {
      await client.query(
        `UPDATE user_gamification_stats
         SET xp = xp + $2, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [input.userId, xpForThisEvent],
      );
    }

    await client.query('COMMIT');

    void invalidateMetabolismSnapshot(input.userId).catch((err) =>
      logger.error({ err }, '[metabolism] invalidate snapshot error'),
    );

    return await getGamificationSummary(input.userId, hadRow, academyId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getGamificationSummary(userId: number, alreadyCheckedIn = false, academyId: number | null = null) {
  const statsResult = academyId
    ? await pool.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1 AND academy_id = $2`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1`,
        [userId],
      );

  const stats = statsResult.rows[0] || { xp: 0, current_streak: 0, last_checkin_date: null };

  const checkinResult = academyId
    ? await pool.query(
        `SELECT date_key FROM user_daily_checkins
         WHERE user_id = $1 AND academy_id = $2
         ORDER BY date_key DESC
         LIMIT 7`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT date_key FROM user_daily_checkins
         WHERE user_id = $1
         ORDER BY date_key DESC
         LIMIT 7`,
        [userId],
      );

  const lastWorkoutResult = academyId
    ? await pool.query(
        `SELECT workout_id, title, muscle_groups, completed_at
         FROM user_workout_logs
         WHERE user_id = $1 AND academy_id = $2
         ORDER BY completed_at DESC
         LIMIT 1`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT workout_id, title, muscle_groups, completed_at
         FROM user_workout_logs
         WHERE user_id = $1
         ORDER BY completed_at DESC
         LIMIT 1`,
        [userId],
      );

  return {
    xp: Number(stats.xp || 0),
    level: normalizeLevel(Number(stats.xp || 0)),
    streak: Number(stats.current_streak || 0),
    todayCheckedIn: checkinResult.rows.some((row: { date_key?: Date }) =>
      row.date_key instanceof Date
        ? row.date_key.toISOString().slice(0, 10) === todayDateKey()
        : String(row.date_key).slice(0, 10) === todayDateKey(),
    ),
    alreadyCheckedIn,
    heatmap: checkinResult.rows
      .map((row: { date_key?: Date }) =>
        row.date_key instanceof Date ? row.date_key.toISOString().slice(0, 10) : String(row.date_key).slice(0, 10),
      )
      .filter(Boolean),
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
