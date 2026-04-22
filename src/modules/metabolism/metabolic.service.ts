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
import type { MetabolicHistory, MetabolicInput, MetabolicOutput } from './metabolic.types';

const SNAPSHOT_CACHE_SECONDS = 6 * 60 * 60; // 6h

export async function getMetabolismForUser(userId: number): Promise<MetabolicOutput> {
  const cached = await loadTodaySnapshot(userId);
  if (cached) {
    const ageSeconds = (Date.now() - new Date(cached.created_at).getTime()) / 1000;
    if (ageSeconds < SNAPSHOT_CACHE_SECONDS) {
      return {
        score: cached.score,
        status: cached.status,
        trend: cached.trend,
        factors: cached.factors ?? [],
        recommendations: buildRecommendations(cached.inputs ?? {}, { score: cached.score, status: cached.status }, cached.factors ?? []),
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

  return { ...result, recommendations };
}

export async function getMetabolismHistoryForUser(userId: number): Promise<MetabolicHistory> {
  return loadSnapshots(userId, 14);
}

export async function invalidateMetabolismSnapshot(userId: number): Promise<void> {
  await invalidateTodaySnapshot(userId);
}
