import pool from '../../config/database';
import logger from '../../lib/logger';
import { computeReadinessLens } from './readiness.engine';
import type { ReadinessLens } from './readiness.engine';

interface TodayCheckinRow {
  feeling: string | null;
  slept_well: boolean | null;
  in_pain: boolean | null;
  stressed: boolean | null;
  hydration_ok: boolean | null;
  nutrition_level: string | null;
  mental_load_level: string | null;
}

async function getTodayCheckinSignals(userId: number): Promise<TodayCheckinRow | null> {
  const { rows } = await pool.query(
    `SELECT feeling, slept_well, in_pain, stressed, hydration_ok, nutrition_level, mental_load_level
     FROM user_daily_checkins
     WHERE user_id = $1 AND date_key = CURRENT_DATE
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

async function getMetabolicSnapshot(userId: number): Promise<{ score: number; delta7d: number | null }> {
  const { rows } = await pool.query(
    `SELECT score, snapshot_date FROM user_metabolism_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC LIMIT 8`,
    [userId],
  );
  const score = rows[0]?.score ?? 50;
  let delta7d: number | null = null;
  if (rows.length >= 2) {
    // Find a snapshot ~7 days ago
    const now = new Date();
    const old = rows.find(r => {
      const d = new Date(r.snapshot_date);
      const diff = (now.getTime() - d.getTime()) / 86400000;
      return diff >= 5;
    });
    if (old) delta7d = rows[0].score - old.score;
  }
  return { score, delta7d };
}

async function getCachedLens(userId: number): Promise<ReadinessLens | null> {
  const { rows } = await pool.query(
    `SELECT level, factors FROM user_readiness_snapshot
     WHERE user_id = $1 AND snapshot_date = CURRENT_DATE LIMIT 1`,
    [userId],
  );
  if (!rows[0]) return null;
  return {
    level: rows[0].level,
    factors: rows[0].factors,
    // Regenerate headline/microcopy from level + top factor (not stored to keep slim)
    headline: rows[0].level === 'red' ? 'Hoje é recuperação'
      : rows[0].level === 'yellow' ? 'Dia de pegar leve'
      : 'Pronto pra treinar',
    microcopy: '',
  };
}

async function upsertLens(userId: number, lens: ReadinessLens): Promise<void> {
  await pool.query(
    `INSERT INTO user_readiness_snapshot (user_id, snapshot_date, level, factors)
     VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (user_id, snapshot_date)
     DO UPDATE SET level = EXCLUDED.level, factors = EXCLUDED.factors`,
    [userId, lens.level, JSON.stringify(lens.factors)],
  );
}

export async function invalidateReadinessSnapshot(userId: number): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM user_readiness_snapshot WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
      [userId],
    );
  } catch (err) {
    logger.error({ err }, '[readiness] invalidate snapshot error');
  }
}

export async function getReadinessLensToday(userId: number): Promise<ReadinessLens | null> {
  const checkin = await getTodayCheckinSignals(userId);
  if (!checkin) return null;

  // Try cache first (only valid if checkin hasn't been invalidated)
  const cached = await getCachedLens(userId);
  if (cached) {
    // Re-attach the real microcopy by rerunning the pure fn on cached level
    // (cheap, no DB cost)
    const { score, delta7d } = await getMetabolicSnapshot(userId);
    const full = computeReadinessLens({
      metabolicScore: score,
      metabolismDelta7d: delta7d,
      feeling: normalizeFeeling(checkin.feeling),
      sleptWell: checkin.slept_well,
      inPain: checkin.in_pain,
      stressed: checkin.stressed,
      nutritionLevel: normalizeNutrition(checkin.nutrition_level),
      mentalLoadLevel: normalizeMentalLoad(checkin.mental_load_level),
    });
    return full;
  }

  const { score, delta7d } = await getMetabolicSnapshot(userId);
  const lens = computeReadinessLens({
    metabolicScore: score,
    metabolismDelta7d: delta7d,
    feeling: normalizeFeeling(checkin.feeling),
    sleptWell: checkin.slept_well,
    inPain: checkin.in_pain,
    stressed: checkin.stressed,
    nutritionLevel: normalizeNutrition(checkin.nutrition_level),
    mentalLoadLevel: normalizeMentalLoad(checkin.mental_load_level),
  });

  void upsertLens(userId, lens).catch(err =>
    logger.error({ err }, '[readiness] upsert snapshot error'),
  );

  return lens;
}

function normalizeFeeling(f: string | null): 'energized' | 'neutral' | 'tired' | null {
  if (f === 'energized' || f === 'neutral' || f === 'tired') return f;
  return null;
}

function normalizeNutrition(n: string | null): 'poor' | 'ok' | 'good' | null {
  if (n === 'poor' || n === 'ok' || n === 'good') return n;
  return null;
}

function normalizeMentalLoad(m: string | null): 'low' | 'medium' | 'high' | null {
  if (m === 'low' || m === 'medium' || m === 'high') return m;
  return null;
}
