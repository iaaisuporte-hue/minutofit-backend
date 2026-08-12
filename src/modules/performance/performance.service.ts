/**
 * Orquestração do módulo Performance (Spec 033).
 *
 * Nesta onda (P1) o serviço entrega apenas o que a fundação sustenta:
 * consistência de frequência e calendário de treino. `score` e `load` fazem
 * parte do contrato do overview mas nascem `null` — não são "campo esquecido",
 * são medida que ainda não existe (Progress Score e Training Load são P3).
 * Devolver `null` mantém o contrato estável para o cliente e deixa a P3
 * preenchendo os buracos sem quebrar nada.
 */
import { weeklyTargetFromPreset } from '../../services/personalDashboardService';
import { CONSISTENCY_WINDOW_DAYS } from './performance.constants';
import { computeConsistencyPct, resolveConsistencyTarget } from './consistency.engine';
import {
  countActiveDays,
  loadActivePlanTarget,
  loadFreeSummaryCounters,
  loadMonthCalendar,
} from './performance.repository';
import type { ActiveDay, ConsistencySummary } from './performance.types';

/**
 * Progress Score. A FORMA é a que a spec fixou; os VALORES chegam na P3.
 *
 * Declarado desde já para que a P3 seja puramente aditiva: tipar como o literal
 * `null` obrigaria a alargar o tipo público depois, e todo consumidor que
 * tivesse escrito `if (score)` estaria compilando contra um `never`.
 *
 * `factors` nunca vem vazio quando há `value` — é invariante de produto, e o
 * banco a impõe por CHECK em `user_performance_snapshots`.
 */
export interface ProgressScoreBlock {
  value: number | null;
  status: 'onboarding' | 'ok';
  trend: string;
  factors: { id: string; label: string; delta: number }[];
  changes7d: { id: string; label: string; delta: number }[];
}

/** Training Load. Mesma regra: forma agora, valores na P3. */
export interface TrainingLoadBlock {
  effortLoad7d: number | null;
  /** Faixa qualitativa. Nunca um número cru — não é métrica clínica. */
  ratioBand: string | null;
}

export interface PerformanceOverview {
  /**
   * Gating do módulo (P2 em diante). Em P1 tudo que existe é Free — captura de
   * sinal e histórico não se escondem atrás de paywall.
   */
  gated: boolean;
  freeSummary: {
    sessions30d: number;
    activeDays28: number;
    currentStreak: number;
  };
  consistency: ConsistencySummary;
  /** `null` até a Onda P3 computar o score. */
  score: ProgressScoreBlock | null;
  /** `null` até a Onda P3 computar a carga. */
  load: TrainingLoadBlock | null;
}

export async function getPerformanceOverview(userId: number): Promise<PerformanceOverview> {
  const [activeDays28, counters, plan] = await Promise.all([
    countActiveDays(userId, CONSISTENCY_WINDOW_DAYS),
    loadFreeSummaryCounters(userId, 30),
    loadActivePlanTarget(userId),
  ]);
  const { sessionsInWindow: sessions30d, currentStreak } = counters;

  const weeklyTarget = weeklyTargetFromPreset(plan.weekPreset);
  const target = resolveConsistencyTarget(weeklyTarget, plan.daysSinceStarted);

  return {
    gated: false,
    freeSummary: { sessions30d, activeDays28, currentStreak },
    consistency: {
      pct: computeConsistencyPct(activeDays28, target),
      activeDays28,
      targetPerWeek: weeklyTarget,
    },
    score: null,
    load: null,
  };
}

/** Calendário de treino do mês pedido. `month` é 1-based. */
export async function getTrainingCalendar(
  userId: number,
  year: number,
  month: number,
): Promise<{ month: string; days: ActiveDay[] }> {
  const days = await loadMonthCalendar(userId, year, month);
  return { month: `${year}-${String(month).padStart(2, '0')}`, days };
}
