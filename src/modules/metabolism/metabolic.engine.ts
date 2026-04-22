import { ActivityLevel, MetabolicHistory, MetabolicHistoryPoint, MetabolicInput, MetabolicOutput, MetabolicStatus, MetabolicTrend } from './metabolic.types';

function calculateScore(input: MetabolicInput): number {
  let score = 50;

  if (input.workoutsPerWeek >= 4) {
    score += 20;
  } else if (input.workoutsPerWeek >= 2) {
    score += 10;
  }

  if (input.activityLevel === 'high') {
    score += 15;
  } else if (input.activityLevel === 'low') {
    score -= 10;
  }

  if (input.age > 40) {
    score -= 5;
  }

  return Math.min(100, Math.max(0, score));
}

function resolveStatus(score: number): MetabolicStatus {
  if (score <= 39) return 'low';
  if (score <= 69) return 'moderate';
  return 'high';
}

function resolveRecommendations(score: number): string[] {
  if (score < 40) return ['increase activity', 'start light workouts'];
  if (score <= 70) return ['stay consistent', 'add 1 extra workout'];
  return ['maintain intensity', 'focus on recovery'];
}

export function generateMockHistory(baseScore: number, days = 14): MetabolicHistory {
  const history: MetabolicHistoryPoint[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    const iso = date.toISOString().slice(0, 10);

    // deterministic oscillation: sin wave with day index as phase
    const oscillation = Math.round(Math.sin(i * 0.8) * 6);
    const score = Math.min(100, Math.max(0, baseScore + oscillation));

    history.push({ date: iso, score });
  }

  return history;
}

export function computeMetabolism(input: MetabolicInput): MetabolicOutput {
  const score = calculateScore(input);
  const status = resolveStatus(score);
  const recommendations = resolveRecommendations(score);
  // TODO: derive trend from historical scores once tracking is available
  const trend: MetabolicTrend = 'stable';

  return { score, status, trend, recommendations };
}
