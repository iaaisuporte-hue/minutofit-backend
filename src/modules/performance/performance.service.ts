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
import { getFeatureMapForUser } from '../../services/planFeatureService';
import { weeklyTargetFromPreset } from '../../services/personalDashboardService';
import type { PrKind } from './pr.engine';
import { CONSISTENCY_WINDOW_DAYS } from './performance.constants';
import { computeConsistencyPct, resolveConsistencyTarget } from './consistency.engine';
import {
  countActiveDays,
  loadActivePlanTarget,
  loadCurrentPrRecords,
  loadFreeSummaryCounters,
  loadMonthCalendar,
  loadProgressionSeries,
  loadRecentPrEvents,
  type ProgressionPoint,
  type ProgressionSeries,
  type PrRecordRow,
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

// ── Recordes e progressão (P2) ─────────────────────────────────────────────

/**
 * O módulo é pago a partir da P2 — a interpretação do histórico é o produto.
 *
 * A captura continua Free (o precedente do tracker: "sinal é insumo, não
 * capacidade premium"), e por isso `/overview` e `/calendar` seguem abertos.
 * O que passa a exigir Premium é a leitura interpretada: progressão e recordes.
 *
 * Endpoints gated respondem 200 com `gated: true` em vez de 403 (contrato da
 * spec): a tela Free renderiza o convite sem tratar erro, e o cliente antigo
 * não quebra. O BACKEND é a autoridade — a lista vem vazia, não escondida.
 */
async function hasPerformanceFeature(userId: number): Promise<boolean> {
  const { features } = await getFeatureMapForUser(userId);
  return features[PERFORMANCE_FEATURE_KEY] === true;
}

export const PERFORMANCE_FEATURE_KEY = 'performance';

export interface PrRecordsResponse {
  gated: boolean;
  records: PrRecordRow[];
  events: PrRecordRow[];
}

export async function getPrRecords(
  userId: number,
  opts: { exerciseId?: string | null; kind?: PrKind | null; sinceDays?: number | null; limit?: number },
): Promise<PrRecordsResponse> {
  if (!(await hasPerformanceFeature(userId))) {
    return { gated: true, records: [], events: [] };
  }
  const [records, events] = await Promise.all([
    loadCurrentPrRecords(userId, { exerciseId: opts.exerciseId, kind: opts.kind }),
    loadRecentPrEvents(userId, opts.limit ?? 20, { sinceDays: opts.sinceDays }),
  ]);
  return { gated: false, records, events };
}

export interface ProgressionResponse {
  gated: boolean;
  windowDays: number;
  exercises: ProgressionExercise[];
}

/** Série de um exercício, com os deltas que a UI mostra sem recalcular. */
export interface ProgressionExercise extends ProgressionSeries {
  firstLoadKg: number | null;
  lastLoadKg: number | null;
  deltaKg: number | null;
  firstE1rm: number | null;
  lastE1rm: number | null;
  e1rmDeltaKg: number | null;
  /** Dias distintos com registro — a UI avisa quando ainda é pouco para uma curva. */
  pointCount: number;
}

/** Primeiro e último valor não-nulo de uma métrica, na ordem cronológica. */
function edges(points: ProgressionPoint[], pick: (p: ProgressionPoint) => number | null) {
  const values = points.map(pick).filter((v): v is number => v != null);
  if (values.length === 0) return { first: null, last: null, delta: null };
  const first = values[0];
  const last = values[values.length - 1];
  return { first, last, delta: Math.round((last - first) * 100) / 100 };
}

export async function getProgression(
  userId: number,
  windowDays: number,
  exerciseId?: string | null,
): Promise<ProgressionResponse> {
  const clamped = Math.min(180, Math.max(30, windowDays));
  if (!(await hasPerformanceFeature(userId))) {
    return { gated: true, windowDays: clamped, exercises: [] };
  }
  const series = await loadProgressionSeries(userId, clamped, exerciseId);
  const exercises = series.map((s) => {
    const load = edges(s.points, (p) => p.maxLoadKg);
    const e1rm = edges(s.points, (p) => p.bestE1rm);
    return {
      ...s,
      firstLoadKg: load.first,
      lastLoadKg: load.last,
      deltaKg: load.delta,
      firstE1rm: e1rm.first,
      lastE1rm: e1rm.last,
      e1rmDeltaKg: e1rm.delta,
      pointCount: s.points.length,
    };
  });
  // Maior ganho de carga primeiro: é o que o aluno quer ver de imediato.
  exercises.sort((a, b) => (b.deltaKg ?? -Infinity) - (a.deltaKg ?? -Infinity));
  return { gated: false, windowDays: clamped, exercises };
}
