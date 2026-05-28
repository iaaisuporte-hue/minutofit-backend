import type { SportConfig, SportContext, SportFactor, RiskLevel, PreWorkoutCheckinData } from '../../types/sport';

interface ReadinessInput {
  sportConfig: SportConfig;
  checkin: PreWorkoutCheckinData;
  weeklyLoadCount: number;
  campDaysRemaining: number | null;
}

export function computeSportReadiness(input: ReadinessInput): SportContext {
  const { sportConfig, checkin, weeklyLoadCount, campDaysRemaining } = input;
  const w = sportConfig.factorWeights;

  const factors: SportFactor[] = [];
  let modifier = 0;

  // Joint soreness: principal penalidade para JJ (risco de lesão)
  if (checkin.joint_soreness >= 4) {
    const delta = -w.joint_soreness;
    modifier += delta;
    factors.push({ id: 'joint_soreness', label: 'Dor articular elevada', delta, hint: 'Considere trabalho técnico leve sem carga.' });
  } else if (checkin.joint_soreness === 3) {
    const delta = -Math.round(w.joint_soreness * 0.5);
    modifier += delta;
    factors.push({ id: 'joint_soreness', label: 'Dor articular moderada', delta });
  }

  // Muscle soreness
  if (checkin.muscle_soreness >= 4) {
    const delta = -w.muscle_soreness;
    modifier += delta;
    factors.push({ id: 'muscle_soreness', label: 'Fadiga muscular alta', delta });
  } else if (checkin.muscle_soreness === 3) {
    const delta = -Math.round(w.muscle_soreness * 0.4);
    modifier += delta;
    factors.push({ id: 'muscle_soreness', label: 'Fadiga muscular moderada', delta });
  }

  // Stress
  if (checkin.stress_level >= 4) {
    const delta = -w.stress_level;
    modifier += delta;
    factors.push({ id: 'stress_level', label: 'Estresse elevado', delta, hint: 'Prefira técnica ao invés de sparring.' });
  }

  // Low motivation — pequena penalidade
  if (checkin.motivation <= 2) {
    const delta = -w.motivation;
    modifier += delta;
    factors.push({ id: 'motivation', label: 'Motivação baixa', delta });
  } else if (checkin.motivation >= 5) {
    const delta = Math.round(w.motivation * 0.5);
    modifier += delta;
    factors.push({ id: 'motivation', label: 'Alta motivação', delta });
  }

  // Camp proximity bonus/pressure
  if (campDaysRemaining !== null) {
    if (campDaysRemaining <= 7) {
      // Peak/taper: reduz intensidade, mantém readiness technique
      const delta = Math.round(w.camp_proximity * 0.5);
      modifier += delta;
      factors.push({ id: 'camp_proximity', label: `Camp: ${campDaysRemaining}d para competição`, delta, hint: 'Semana de taper — priorize velocidade e técnica.' });
    } else if (campDaysRemaining <= 21) {
      // Peak phase: boost leve
      const delta = w.camp_proximity;
      modifier += delta;
      factors.push({ id: 'camp_proximity', label: `Camp Mode: ${campDaysRemaining}d restantes`, delta });
    }
  }

  // Weekly load
  if (weeklyLoadCount > 5) {
    const delta = -w.weekly_load_penalty;
    modifier += delta;
    factors.push({ id: 'weekly_load', label: `Carga alta na semana (${weeklyLoadCount} treinos)`, delta, hint: 'Considere recuperação ativa.' });
  } else if (weeklyLoadCount >= 3) {
    const delta = w.weekly_load_threshold;
    modifier += delta;
    factors.push({ id: 'weekly_load', label: `Frequência consistente (${weeklyLoadCount} treinos)`, delta });
  }

  // Hydration bonus
  if (!checkin.hydration_ok) {
    modifier -= 5;
    factors.push({ id: 'hydration', label: 'Hidratação insuficiente', delta: -5 });
  }

  // Clamp modifier to [-60, +40]
  modifier = Math.max(-60, Math.min(40, modifier));

  const risk_level: RiskLevel =
    modifier <= -30 ? 'high' : modifier <= -10 ? 'moderate' : 'low';

  const recommendation =
    risk_level === 'low'
      ? sportConfig.microcopy.readinessHigh
      : risk_level === 'moderate'
      ? sportConfig.microcopy.readinessModerate
      : sportConfig.microcopy.readinessLow;

  return { factors, modifier, recommendation, risk_level };
}
