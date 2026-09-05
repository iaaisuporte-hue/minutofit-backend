/**
 * Camada única de verdade da aderência nutricional (SPEC 035 — Nutri Safety,
 * Data Integrity & Truth Layer).
 *
 * Antes desta camada, o módulo Nutri tinha SEIS definições distintas de
 * "aderência" espalhadas entre `nutriService.ts` e o frontend, com
 * denominadores fixos (7/30 dias) que não respeitavam quando o plano ou o
 * vínculo começou — um paciente de 2 dias com 100% de adesão real lia "29%"
 * na carteira. Módulo PURO — sem acesso a banco — para ser trivialmente
 * testável e para que backend e frontend nunca mais divirjam: toda tela
 * consome o mesmo cálculo, nunca reimplementa.
 */

import { shiftDayKey } from '../utils/appDay';

export type MealCheckinStatus = 'done' | 'partial' | 'skipped' | 'substituted' | 'delayed';

/**
 * Peso de cada status no numerador. `substituted` e `delayed` contam como
 * adesão plena — o paciente cumpriu o estímulo (comeu a alternativa cadastrada
 * pela própria nutri, ou comeu atrasado). `partial` vale metade. `skipped`
 * zera. Decisão registrada na SPEC 035 (P1A.4): antes, `substituted` valia 0
 * num dos seis cálculos concorrentes — o paciente que seguia a alternativa
 * prescrita lia "queda de adesão".
 */
export const MEAL_STATUS_WEIGHT: Record<MealCheckinStatus, number> = {
  done: 1,
  substituted: 1,
  delayed: 1,
  partial: 0.5,
  skipped: 0,
};

/** Status que contam como "presença" do dia para fins de streak (tudo != skipped). */
const STREAK_PRESENT_STATUSES = new Set<MealCheckinStatus>(['done', 'substituted', 'partial', 'delayed']);

/**
 * Mínimo de dias efetivos de dados para que risk flag, drop flag e trend
 * sejam calculados. Abaixo disso o paciente está "calibrando" — SPEC 035
 * seção 10: não classificar paciente novo como risco por falta de histórico.
 * O percentual de aderência em si (`adherencePct`) NÃO usa este piso — ele é
 * sempre proporcional aos dias que de fato existiram, mesmo que só 1 ou 2.
 */
export const MIN_EFFECTIVE_DAYS_FOR_SIGNAL = 5;

/** Mínimo de dias efetivos (plano/vínculo) para calcular tendência 7d vs 7d anteriores. */
export const MIN_EFFECTIVE_DAYS_FOR_TREND = 14;

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function weightedAdherenceSum(statuses: MealCheckinStatus[]): number {
  return statuses.reduce((sum, s) => sum + (MEAL_STATUS_WEIGHT[s] ?? 0), 0);
}

export interface AdherenceResult {
  /** Percentual 0–100, ou `null` quando não há denominador (0 refeições/dia ou 0 dias efetivos). */
  pct: number | null;
  /** Dias realmente decorridos dentro da janela pedida — nunca mais que o plano/vínculo tem de vida. */
  effectiveDays: number;
  /** Tamanho da janela pedida (7, 14, 30…). */
  windowDays: number;
  /**
   * `true` quando `effectiveDays < MIN_EFFECTIVE_DAYS_FOR_SIGNAL` — o
   * percentual em si é verdadeiro (é a proporção real), mas risco, queda e
   * tendência devem ficar em `null`/suprimidos enquanto calibrando.
   */
  calibrating: boolean;
}

/**
 * Calcula o percentual de aderência para uma janela, com denominador
 * proporcional ao tempo real de vida do plano/vínculo (SPEC 035 / NUTRI-13).
 *
 * @param weightedSum soma de `MEAL_STATUS_WEIGHT` dos check-ins na janela
 * @param mealsPerDay refeições prescritas por dia no plano ativo
 * @param windowDays tamanho da janela solicitada (7, 14, 30…)
 * @param daysSincePlanStart dias completos desde o início do plano (0 = criado hoje);
 *   `null` quando desconhecido ou quando a chamada já opera sobre uma janela fixa
 *   (nesse caso a janela inteira é usada como denominador, sem proporção).
 */
export function computeAdherence(
  weightedSum: number,
  mealsPerDay: number,
  windowDays: number,
  daysSincePlanStart: number | null,
): AdherenceResult {
  const elapsed = daysSincePlanStart === null ? windowDays : Math.max(1, daysSincePlanStart + 1);
  const effectiveDays = Math.max(0, Math.min(windowDays, elapsed));
  const denom = mealsPerDay * effectiveDays;
  const pct = denom > 0 ? clampPct(Math.round((weightedSum / denom) * 100)) : null;
  return {
    pct,
    effectiveDays,
    windowDays,
    calibrating: effectiveDays < MIN_EFFECTIVE_DAYS_FOR_SIGNAL,
  };
}

export type Trend = 'up' | 'down' | 'stable';

/**
 * Tendência: últimos 7 dias vs 7 dias anteriores. `null` sem janela efetiva
 * suficiente (SPEC 035 / NUTRI-33 — o frontend comparava 3 dias contra 4 no
 * mobile e rotulava "Em queda" sobre ruído). `pctPrev7`/`pctLast7` devem vir
 * de janelas fixas de 7 dias cada (não proporcionais) — só chamado quando o
 * plano/vínculo já tem `effectiveDaysForTrend >= MIN_EFFECTIVE_DAYS_FOR_TREND`,
 * ou seja, as duas janelas de 7 dias já são reais.
 */
export function computeTrend(
  pctPrev7: number | null,
  pctLast7: number | null,
  effectiveDaysForTrend: number,
): Trend | null {
  if (effectiveDaysForTrend < MIN_EFFECTIVE_DAYS_FOR_TREND) return null;
  if (pctPrev7 === null || pctLast7 === null) return null;
  const delta = pctLast7 - pctPrev7;
  if (delta >= 15) return 'up';
  if (delta <= -15) return 'down';
  return 'stable';
}

/**
 * Streak canônico — única definição consumida por backend e frontend (SPEC
 * 035 / NUTRI-15: antes, o app do aluno e a tela da nutri divergiam: "13 dias"
 * vs "0 dias" na mesma manhã, porque cada lado tinha sua própria função).
 *
 * `done`, `substituted`, `partial` e `delayed` contam como presença do dia;
 * `skipped` e ausência de registro quebram a sequência. O dia corrente ainda
 * não encerrado não zera a sequência: se hoje não tem check-in ainda, conta a
 * partir de ontem — o dia não acabou.
 */
export function computeStreak(
  statusesByDay: Map<string, MealCheckinStatus[]>,
  todayKey: string,
  maxLookbackDays = 60,
): number {
  const dayHasPresence = (key: string): boolean => {
    const statuses = statusesByDay.get(key);
    if (!statuses || statuses.length === 0) return false;
    return statuses.some((s) => STREAK_PRESENT_STATUSES.has(s));
  };

  const startOffset = dayHasPresence(todayKey) ? 0 : 1;
  let streak = 0;
  for (let i = startOffset; i < maxLookbackDays; i++) {
    if (!dayHasPresence(shiftDayKey(todayKey, -i))) break;
    streak++;
  }
  return streak;
}

export type AdherenceState = 'calibrating' | 'ready';

export interface CanonicalAdherenceBlock {
  adherencePct: number | null;
  adherenceWindowDays: number;
  adherenceEffectiveDays: number;
  adherenceState: AdherenceState;
  streakDays: number;
  trend: Trend | null;
}

/**
 * Monta o bloco canônico completo consumido por carteira e detalhe. Único
 * lugar onde aderência 7d, streak e tendência são combinados — nenhuma tela
 * deve recalcular nenhum destes números por conta própria (SPEC 035 §11).
 */
export function buildCanonicalAdherenceBlock(args: {
  /** Check-ins granulares dos últimos 14 dias de calendário (inclui hoje). */
  checkins14d: Array<{ checkDate: string; status: MealCheckinStatus }>;
  mealsPerDay: number;
  /** Dias completos desde o início do plano ativo; `null` se desconhecido. */
  daysSincePlanStart: number | null;
  /** Chave 'YYYY-MM-DD' do dia de hoje no fuso do aluno. */
  todayKey: string;
  /** Status por dia dos últimos 60 dias, para o streak (janela mais longa que os 14d de trend/pct). */
  statusesByDay60d: Map<string, MealCheckinStatus[]>;
}): CanonicalAdherenceBlock {
  const { checkins14d, mealsPerDay, daysSincePlanStart, todayKey, statusesByDay60d } = args;

  const last7Cutoff = shiftDayKey(todayKey, -6);
  const prev7Cutoff = shiftDayKey(todayKey, -13);

  const last7Statuses = checkins14d
    .filter((c) => c.checkDate >= last7Cutoff)
    .map((c) => c.status);
  const prev7Statuses = checkins14d
    .filter((c) => c.checkDate >= prev7Cutoff && c.checkDate < last7Cutoff)
    .map((c) => c.status);

  const a7 = computeAdherence(weightedAdherenceSum(last7Statuses), mealsPerDay, 7, daysSincePlanStart);

  const effectiveDaysForTrend = daysSincePlanStart === null ? 14 : Math.max(1, daysSincePlanStart + 1);
  const pctLast7Fixed = computeAdherence(weightedAdherenceSum(last7Statuses), mealsPerDay, 7, null).pct;
  const pctPrev7Fixed = computeAdherence(weightedAdherenceSum(prev7Statuses), mealsPerDay, 7, null).pct;
  const trend = computeTrend(pctPrev7Fixed, pctLast7Fixed, effectiveDaysForTrend);

  const streakDays = computeStreak(statusesByDay60d, todayKey);

  return {
    adherencePct: a7.pct,
    adherenceWindowDays: a7.windowDays,
    adherenceEffectiveDays: a7.effectiveDays,
    adherenceState: a7.calibrating ? 'calibrating' : 'ready',
    streakDays,
    trend,
  };
}
