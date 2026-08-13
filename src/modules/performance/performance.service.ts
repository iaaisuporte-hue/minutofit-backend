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
import { dayKey } from '../../utils/appDay';
import { weeklyTargetFromPreset } from '../../services/personalDashboardService';
import type { PrKind } from './pr.engine';
import {
  CONSISTENCY_WINDOW_DAYS,
  FORMULA_VERSION,
  SCORE_WINDOW_DAYS,
} from './performance.constants';
import { resolveTrend } from '../../utils/trend';
import {
  compareFactorWindows,
  computeProgressScore,
  type ScoreFactor,
} from './progress.engine';
import { LOAD_BAND_LABEL, computeLoadReading } from './trainingLoad.engine';
import { computeConsistencyPct, resolveConsistencyTarget } from './consistency.engine';
import {
  countActiveDays,
  loadActivePlanTarget,
  loadCurrentPrRecords,
  loadFreeSummaryCounters,
  loadMonthCalendar,
  loadEffortMethodDistribution,
  loadKeyExerciseProgression,
  loadProgressionSeries,
  loadRecentPrEvents,
  loadScoreAggregates,
  loadScoreFactorsAt,
  loadScoreHistory,
  loadTodayScoreSnapshot,
  upsertScoreSnapshot,
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
  /** `null` em onboarding — sem histórico não se afirma número. */
  value: number | null;
  status: 'onboarding' | 'ok';
  trend: 'up' | 'stable' | 'down';
  /** Breakdown: nunca vazio quando há `value`. É a regra do produto. */
  factors: ScoreFactor[];
  /** O que mudou em relação a 7 dias atrás. Vazio quando não há com o que comparar. */
  changes7d: ScoreFactor[];
  /** Quando este score foi calculado. */
  updatedAt: string;
  /** Versão da fórmula que produziu este número. */
  formulaVersion: number;
}

/** Training Load. Mesma regra: forma agora, valores na P3. */
export interface TrainingLoadBlock {
  /** Carga interna somada em 7 dias (unidades arbitrárias de sRPE). */
  effortLoad7d: number | null;
  /** Faixa qualitativa. Nunca a razão crua — não é métrica clínica. */
  ratioBand: string | null;
  /** Texto observacional da faixa. */
  ratioLabel: string | null;
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
  /** `null` quando o módulo está gated ou não há dados. */
  score: ProgressScoreBlock | null;
  /** `null` quando o módulo está gated. */
  load: TrainingLoadBlock | null;
  /** Frase observacional do período. Nunca atribui causa. */
  headline: string;
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
  const consistencyPct = computeConsistencyPct(activeDays28, target);

  // Score e carga são leitura interpretada: Premium. A consistência e o resumo
  // continuam abertos — capturar sinal é Free, interpretar é o produto pago.
  const premium = await hasPerformanceFeature(userId);
  const { score, load } = premium
    ? await resolveScoreAndLoad(userId, consistencyPct)
    : { score: null, load: null };

  return {
    gated: !premium,
    freeSummary: { sessions30d, activeDays28, currentStreak },
    consistency: { pct: consistencyPct, activeDays28, targetPerWeek: weeklyTarget },
    score,
    load,
    headline: buildHeadline(score, consistencyPct),
  };
}

/**
 * Score do dia + ritmo de carga.
 *
 * O snapshot é calculado sob demanda e guardado por dia (mesmo padrão do motor
 * metabólico). Não é cache de performance — o cálculo é barato: uma query
 * agregada e uma de progressão. É MEMÓRIA: sem a linha diária não existe série
 * histórica, e sem série não há tendência nem "o que mudou desde a semana
 * passada". Reler o snapshot do dia também garante que o número não oscile
 * entre dois carregamentos da mesma tela.
 */
async function resolveScoreAndLoad(
  userId: number,
  consistencyPct: number | null,
): Promise<{ score: ProgressScoreBlock | null; load: TrainingLoadBlock | null }> {
  const [agg, keyExercises] = await Promise.all([
    loadScoreAggregates(userId, SCORE_WINDOW_DAYS),
    loadKeyExerciseProgression(userId, SCORE_WINDOW_DAYS),
  ]);

  const inputs = {
    accountAgeDays: agg.accountAgeDays,
    sessionsInLookback: agg.sessionsInLookback,
    daysSinceLastSession: agg.daysSinceLastSession,
    keyExercises,
    consistencyPct,
    tonnageCurrent: agg.tonnageCurrent,
    tonnagePrevious: agg.tonnagePrevious,
    prCount: agg.prCount,
    // Metas chegam na Onda P4; até lá o fator soma 0 e não aparece.
    goalsAchieved: 0,
  };

  const result = computeProgressScore(inputs);

  const load = computeLoadReading({
    sum7d: agg.loadSum7d,
    sum28d: agg.loadSum28d,
    sessionsWithLoad28d: agg.sessionsWithLoad28d,
  });

  // A tendência precisa da série, então o snapshot de hoje entra antes de lê-la.
  const history = await loadScoreHistory(userId, 30);
  const semHoje = history.filter((h) => h.date !== todayKeyForUser());
  const trend = resolveTrend([...semHoje.map((h) => h.score), result.value]);

  await upsertScoreSnapshot(userId, {
    score: result.value,
    status: result.status,
    trend,
    factors: result.factors,
    inputs,
    formulaVersion: FORMULA_VERSION,
  });

  const anteriores = (await loadScoreFactorsAt(userId, 7)) as ScoreFactor[] | null;
  const changes7d = anteriores ? compareFactorWindows(result.factors, anteriores) : [];

  const snapshot = await loadTodayScoreSnapshot(userId);

  return {
    score: {
      value: result.value,
      status: result.status,
      trend,
      factors: result.factors,
      changes7d,
      updatedAt: snapshot?.created_at
        ? new Date(snapshot.created_at).toISOString()
        : new Date().toISOString(),
      formulaVersion: FORMULA_VERSION,
    },
    load: {
      effortLoad7d: load.effortLoad7d,
      ratioBand: load.ratioBand,
      ratioLabel: load.ratioBand ? LOAD_BAND_LABEL[load.ratioBand] : null,
    },
  };
}

function todayKeyForUser(): string {
  return dayKey();
}

/**
 * Uma frase observacional sobre o período.
 *
 * Descreve o que foi medido; nunca atribui causa. "Sua consistência foi menor"
 * é verificável; "seu score caiu porque você dormiu mal" seria invenção — o
 * score não olha sono.
 */
function buildHeadline(score: ProgressScoreBlock | null, consistencyPct: number | null): string {
  if (!score) return 'Registre seus treinos para acompanhar sua evolução.';
  if (score.status === 'onboarding') {
    return 'Continue registrando seus treinos para construirmos sua linha de evolução.';
  }

  const maior = [...score.factors].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (!maior || maior.delta === 0) return 'Seu período ficou parecido com o anterior.';
  if (maior.delta > 0) return `Destaque do período: ${maior.label.toLowerCase()}.`;
  return `Ponto de atenção: ${maior.label.toLowerCase()}.`;
}

/** Série do score para o gráfico. Só pontos reais — sem preencher buraco. */
export async function getScoreHistory(
  userId: number,
  days: number,
): Promise<{ gated: boolean; points: { date: string; score: number | null }[] }> {
  if (!(await hasPerformanceFeature(userId))) return { gated: true, points: [] };
  const history = await loadScoreHistory(userId, Math.min(365, Math.max(7, days)));
  return {
    gated: false,
    points: history.filter((h) => h.score != null).map((h) => ({ date: h.date, score: h.score })),
  };
}

/** Distribuição do método de carga — observabilidade, sem dado pessoal. */
export async function getEffortMethodDistribution(windowDays = 30) {
  return loadEffortMethodDistribution(windowDays);
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
