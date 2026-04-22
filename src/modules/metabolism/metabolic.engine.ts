import {
  MetabolicFactor,
  MetabolicHistory,
  MetabolicInput,
  MetabolicOutput,
  MetabolicStatus,
  MetabolicTrend,
} from './metabolic.types';

const BASE_SCORE = 45;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeFactors(input: MetabolicInput): MetabolicFactor[] {
  const factors: MetabolicFactor[] = [];

  // Frequência semanal
  if (input.workoutsLast7Days >= 4) {
    factors.push({ id: 'frequency.high', label: 'Frequência alta', delta: 18, hint: `${input.workoutsLast7Days} treinos nos últimos 7 dias` });
  } else if (input.workoutsLast7Days >= 2) {
    factors.push({ id: 'frequency.mid', label: 'Frequência moderada', delta: 10, hint: `${input.workoutsLast7Days} treinos nos últimos 7 dias` });
  } else if (input.workoutsLast7Days === 0) {
    factors.push({ id: 'frequency.zero', label: 'Sem treinos recentes', delta: -12, hint: 'Nenhum treino registrado nos últimos 7 dias' });
  } else {
    factors.push({ id: 'frequency.low', label: 'Frequência baixa', delta: 3, hint: `${input.workoutsLast7Days} treino nos últimos 7 dias` });
  }

  // Volume mensal (0 a +12, linear sobre 0–12 treinos em 28 dias)
  const volumeDelta = Math.round(clamp(input.workoutsLast28Days, 0, 12));
  if (volumeDelta > 0) {
    factors.push({ id: 'volume.monthly', label: 'Volume mensal', delta: volumeDelta, hint: `${input.workoutsLast28Days} treinos nos últimos 28 dias` });
  }

  // Variedade muscular (0 a +8)
  const varietyDelta = Math.round(clamp(input.distinctMuscleGroupsLast14Days / 6, 0, 1) * 8);
  if (varietyDelta > 0) {
    factors.push({ id: 'variety', label: 'Variedade muscular', delta: varietyDelta, hint: `${input.distinctMuscleGroupsLast14Days} grupos musculares distintos em 14 dias` });
  }

  // Consistência / streak (0 a +10)
  const streakDelta = Math.round(clamp(input.currentStreakDays, 0, 14) * 0.7);
  if (streakDelta > 0) {
    factors.push({ id: 'consistency.streak', label: 'Consistência', delta: streakDelta, hint: `Sequência de ${input.currentStreakDays} dia${input.currentStreakDays !== 1 ? 's' : ''}` });
  }

  // Recência
  if (input.daysSinceLastActivity !== null) {
    if (input.daysSinceLastActivity > 14) {
      factors.push({ id: 'recency.cold', label: 'Inatividade prolongada', delta: -20, hint: `${input.daysSinceLastActivity} dias sem atividade registrada` });
    } else if (input.daysSinceLastActivity > 7) {
      factors.push({ id: 'recency.stale', label: 'Pausa longa', delta: -10, hint: `${input.daysSinceLastActivity} dias desde a última atividade` });
    }
  }

  // Cardio (0 a +6)
  if (input.cardioSessionsLast14Days >= 2) {
    factors.push({ id: 'cardio', label: 'Cardio', delta: 6, hint: `${input.cardioSessionsLast14Days} sessões de cardio em 14 dias` });
  } else if (input.cardioSessionsLast14Days === 1) {
    factors.push({ id: 'cardio', label: 'Cardio', delta: 3, hint: '1 sessão de cardio em 14 dias' });
  }

  // Minutos de atividade (0 a +6)
  if (input.activityMinutesLast7Days >= 150) {
    factors.push({ id: 'activity.minutes', label: 'Minutos ativos', delta: 6, hint: `${input.activityMinutesLast7Days} min de atividade nos últimos 7 dias` });
  } else if (input.activityMinutesLast7Days >= 75) {
    factors.push({ id: 'activity.minutes', label: 'Minutos ativos', delta: 3, hint: `${input.activityMinutesLast7Days} min de atividade nos últimos 7 dias` });
  }

  // Idade
  const age = input.ageYears;
  if (age !== null) {
    if (age > 50) {
      factors.push({ id: 'age', label: 'Faixa etária', delta: -6, hint: 'Metabolismo naturalmente mais lento acima dos 50' });
    } else if (age > 40) {
      factors.push({ id: 'age', label: 'Faixa etária', delta: -3, hint: 'Metabolismo com leve redução após os 40' });
    } else if (age > 30) {
      factors.push({ id: 'age', label: 'Faixa etária', delta: -1, hint: 'Leve redução metabólica após os 30' });
    }
  }

  return factors;
}

function resolveStatus(score: number): MetabolicStatus {
  if (score <= 39) return 'low';
  if (score <= 69) return 'moderate';
  return 'high';
}

function resolveTrend(previousSnapshots: MetabolicHistory): MetabolicTrend {
  if (previousSnapshots.length < 5) return 'stable';

  const n = previousSnapshots.length;
  const xMean = (n - 1) / 2;
  const yMean = previousSnapshots.reduce((s, p) => s + p.score, 0) / n;

  let num = 0;
  let den = 0;
  previousSnapshots.forEach((p, i) => {
    num += (i - xMean) * (p.score - yMean);
    den += (i - xMean) ** 2;
  });

  const slope = den === 0 ? 0 : num / den;

  if (slope >= 0.3) return 'up';
  if (slope <= -0.3) return 'down';
  return 'stable';
}

export function computeMetabolism(
  input: MetabolicInput,
  previousSnapshots: MetabolicHistory = [],
): MetabolicOutput {
  const factors = computeFactors(input);
  const totalDelta = factors.reduce((sum, f) => sum + f.delta, 0);
  const score = clamp(BASE_SCORE + totalDelta, 0, 100);
  const status = resolveStatus(score);
  const trend = resolveTrend(previousSnapshots);

  return { score, status, trend, factors, recommendations: [] };
}
