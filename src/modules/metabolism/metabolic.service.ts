import { computeMetabolism } from './metabolic.engine';
import { buildRecommendations } from './metabolic.recommendations';
import {
  invalidateTodaySnapshot,
  loadActivityMetrics,
  loadSnapshots,
  loadStreakInfo,
  loadTodaySnapshot,
  loadUserProfile,
  upsertSnapshot,
} from './metabolic.repository';
import type { MetabolicHistory, MetabolicInput, MetabolicOutput, MetabolicTrendBlock } from './metabolic.types';
import pool from '../../config/database';

const SNAPSHOT_CACHE_SECONDS = 6 * 60 * 60; // 6h

function trendBlockFromAvgs(cur: number | null, prev: number | null): MetabolicTrendBlock {
  if (cur == null || prev == null) return { delta: 0, direction: 'stable' };
  const delta = Math.round((cur - prev) * 10) / 10;
  if (Math.abs(delta) < 0.75) return { delta, direction: 'stable' };
  return { delta, direction: delta > 0 ? 'up' : 'down' };
}

async function loadScoreTrendBlocks(userId: number): Promise<{ trend7d: MetabolicTrendBlock; trend30d: MetabolicTrendBlock }> {
  const r = await pool.query<{
    cur7: string | null;
    prev7: string | null;
    cur30: string | null;
    prev30: string | null;
    n: string;
  }>(
    `WITH series AS (
       SELECT snapshot_date::date AS d, score::float8 AS score
       FROM user_metabolism_snapshots
       WHERE user_id = $1 AND snapshot_date >= CURRENT_DATE - INTERVAL '70 days'
     ),
     c7 AS (SELECT AVG(score) AS a FROM series WHERE d > CURRENT_DATE - INTERVAL '7 days'),
     p7 AS (
       SELECT AVG(score) AS a FROM series
       WHERE d <= CURRENT_DATE - INTERVAL '7 days' AND d > CURRENT_DATE - INTERVAL '14 days'
     ),
     c30 AS (SELECT AVG(score) AS a FROM series WHERE d > CURRENT_DATE - INTERVAL '30 days'),
     p30 AS (
       SELECT AVG(score) AS a FROM series
       WHERE d <= CURRENT_DATE - INTERVAL '30 days' AND d > CURRENT_DATE - INTERVAL '60 days'
     ),
     cnt AS (SELECT COUNT(*)::int AS n FROM series)
     SELECT (SELECT a FROM c7) AS cur7, (SELECT a FROM p7) AS prev7,
            (SELECT a FROM c30) AS cur30, (SELECT a FROM p30) AS prev30,
            (SELECT n FROM cnt) AS n`,
    [userId],
  );
  const row = r.rows[0];
  const n = row ? Number(row.n ?? 0) : 0;
  if (!row || n < 4) {
    return {
      trend7d: { delta: 0, direction: 'stable' },
      trend30d: { delta: 0, direction: 'stable' },
    };
  }
  return {
    trend7d: trendBlockFromAvgs(row.cur7 != null ? Number(row.cur7) : null, row.prev7 != null ? Number(row.prev7) : null),
    trend30d: trendBlockFromAvgs(row.cur30 != null ? Number(row.cur30) : null, row.prev30 != null ? Number(row.prev30) : null),
  };
}

async function attachTrends(userId: number, base: Omit<MetabolicOutput, 'trend7d' | 'trend30d'>): Promise<MetabolicOutput> {
  const { trend7d, trend30d } = await loadScoreTrendBlocks(userId);
  return { ...base, trend7d, trend30d };
}

export async function getMetabolismForUser(userId: number): Promise<MetabolicOutput> {
  const [cached, trends] = await Promise.all([loadTodaySnapshot(userId), loadScoreTrendBlocks(userId)]);

  if (cached) {
    const ageSeconds = (Date.now() - new Date(cached.created_at).getTime()) / 1000;
    if (ageSeconds < SNAPSHOT_CACHE_SECONDS) {
      return {
        score: cached.score,
        status: cached.status,
        trend: cached.trend,
        factors: cached.factors ?? [],
        recommendations: buildRecommendations(cached.inputs ?? {}, { score: cached.score, status: cached.status }, cached.factors ?? []),
        trend7d: trends.trend7d,
        trend30d: trends.trend30d,
      };
    }
  }

  const [profile, metrics, streak, previousSnapshots] = await Promise.all([
    loadUserProfile(userId),
    loadActivityMetrics(userId),
    loadStreakInfo(userId),
    loadSnapshots(userId, 14),
  ]);

  const input: MetabolicInput = {
    ageYears: profile.ageYears,
    fitnessGoal: profile.fitnessGoal,
    experienceLevel: profile.experienceLevel,
    ...metrics,
    ...streak,
  };

  const result = computeMetabolism(input, previousSnapshots);
  const recommendations = buildRecommendations(input, result, result.factors);

  await upsertSnapshot(userId, result.score, result.status, result.trend, result.factors, input);

  return attachTrends(userId, { ...result, recommendations });
}

export async function getMetabolismHistoryForUser(userId: number): Promise<MetabolicHistory> {
  return loadSnapshots(userId, 14);
}

export async function invalidateMetabolismSnapshot(userId: number): Promise<void> {
  await invalidateTodaySnapshot(userId);
}
