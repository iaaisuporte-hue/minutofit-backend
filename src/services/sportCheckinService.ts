import pool from '../config/database';
import type { PreWorkoutCheckinData } from '../types/sport';

export async function createPreWorkoutCheckin(
  userId: number,
  data: PreWorkoutCheckinData,
): Promise<PreWorkoutCheckinData & { id: number; checkin_date: string }> {
  const { rows } = await pool.query(
    `INSERT INTO athlete_pre_workout_checkin
       (user_id, sleep_quality, energy_level, muscle_soreness, joint_soreness,
        stress_level, hydration_ok, weight_kg, motivation, perceived_readiness)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, checkin_date) DO UPDATE SET
       sleep_quality       = EXCLUDED.sleep_quality,
       energy_level        = EXCLUDED.energy_level,
       muscle_soreness     = EXCLUDED.muscle_soreness,
       joint_soreness      = EXCLUDED.joint_soreness,
       stress_level        = EXCLUDED.stress_level,
       hydration_ok        = EXCLUDED.hydration_ok,
       weight_kg           = EXCLUDED.weight_kg,
       motivation          = EXCLUDED.motivation,
       perceived_readiness = EXCLUDED.perceived_readiness
     RETURNING *`,
    [
      userId,
      data.sleep_quality,
      data.energy_level,
      data.muscle_soreness,
      data.joint_soreness,
      data.stress_level,
      data.hydration_ok,
      data.weight_kg ?? null,
      data.motivation,
      data.perceived_readiness,
    ],
  );

  // Invalidate readiness snapshot so it gets recalculated
  await pool.query(
    `DELETE FROM athlete_readiness_snapshot WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
    [userId],
  );

  return rows[0];
}

export async function listPreWorkoutCheckins(
  userId: number,
  from?: string,
  to?: string,
): Promise<(PreWorkoutCheckinData & { id: number; checkin_date: string })[]> {
  let query = `SELECT * FROM athlete_pre_workout_checkin WHERE user_id = $1`;
  const params: unknown[] = [userId];

  if (from) {
    params.push(from);
    query += ` AND checkin_date >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    query += ` AND checkin_date <= $${params.length}`;
  }
  query += ` ORDER BY checkin_date DESC LIMIT 60`;

  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getTodayCheckin(
  userId: number,
): Promise<(PreWorkoutCheckinData & { id: number; checkin_date: string }) | null> {
  const { rows } = await pool.query(
    `SELECT * FROM athlete_pre_workout_checkin WHERE user_id = $1 AND checkin_date = CURRENT_DATE LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}
