/**
 * PLAN_NUTRITION_QUICK_MACROS (P1C) — sinal de ingestão para o nutri.
 *
 * Módulo PURO (sem acesso a banco), mesmo padrão de `nutriAdherence.ts`:
 * uma função, dois consumidores (`getPatientsWithSummary` para o badge de
 * atenção da carteira, `computePatientInsights` para o "Próxima atenção").
 * Nunca a fórmula se bifurca — é exatamente a divergência que
 * `adherence_drop` tem hoje entre esses dois lugares, e que este módulo não
 * repete.
 *
 * Reusa `classifyDaySummary` de `nutritionIntakeService.ts` (mesma função
 * pura que classifica UM dia do próprio aluno) — cobertura/confiança do dia
 * são a MESMA regra nos dois lados, só a janela (1 dia vs 14) muda.
 */
import { classifyDaySummary, type DayLogSummary, type DayCoverageLevel } from './nutritionIntakeService';
import { dayKeyDiff } from '../utils/appDay';

export interface DayAgg extends DayLogSummary {
  dateKey: string;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
}

export type IntakeState = 'none' | 'insufficient' | 'ready';
export type IntakeTrend = 'up' | 'down' | 'stable' | null;
export type IntakeExceptionType = 'intake_kcal_drop' | 'intake_protein_low' | 'intake_silent' | 'intake_over';

export interface IntakeException {
  type: IntakeExceptionType;
  detail: string;
}

export interface IntakeTarget {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  mealsPerDay: number;
  source: 'plan_items' | 'self_estimate';
}

export interface PatientIntakeSummary {
  state: IntakeState;
  daysLogged7d: number;
  highCoverageDays7d: number;
  avgKcal7d: number | null;
  avgProteinG7d: number | null;
  avgCarbG7d: number | null;
  avgFatG7d: number | null;
  target: { kcal: number; p: number; c: number; f: number; source: 'plan_items' | 'self_estimate' } | null;
  kcalTrend: IntakeTrend;
  /** Nunca mais de 1 — a exceção mais severa vence; severidade em ordem fixa. */
  exception: IntakeException | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function daysAgo(day: DayAgg, todayKey: string): number {
  return dayKeyDiff(day.dateKey, todayKey);
}

function classifyLevel(day: DayAgg, expectedMeals: number): DayCoverageLevel {
  return classifyDaySummary(day, expectedMeals).level;
}

/**
 * Agrega 14 dias de logs + a meta resolvida do paciente num sinal de
 * ingestão. `days` é QUALQUER subconjunto de dias com ≥1 log nos últimos 14
 * dias (dias sem log simplesmente não aparecem no array — nunca um dia
 * "zero" fabricado). `todayKey` vem de `dayKey()` no chamador (módulo puro
 * não lê o relógio).
 */
export function deriveIntakeSignal(input: {
  days: DayAgg[];
  todayKey: string;
  target: IntakeTarget | null;
  objective?: 'weight_loss' | 'maintenance' | 'muscle_gain' | null;
}): PatientIntakeSummary {
  const { days, todayKey, target, objective } = input;

  if (days.length === 0) {
    return {
      state: 'none', daysLogged7d: 0, highCoverageDays7d: 0,
      avgKcal7d: null, avgProteinG7d: null, avgCarbG7d: null, avgFatG7d: null,
      target: null, kcalTrend: null, exception: null,
    };
  }

  const expectedMeals = target?.mealsPerDay ?? 3;
  const last7 = days.filter((d) => { const a = daysAgo(d, todayKey); return a >= 0 && a <= 6; });
  const prev7 = days.filter((d) => { const a = daysAgo(d, todayKey); return a >= 7 && a <= 13; });
  const last5 = days.filter((d) => { const a = daysAgo(d, todayKey); return a >= 0 && a <= 4; });
  const window14to6 = days.filter((d) => { const a = daysAgo(d, todayKey); return a >= 6 && a <= 14; });

  const daysLogged7d = last7.length;
  const high7 = last7.filter((d) => classifyLevel(d, expectedMeals) === 'high');
  const highPrev7 = prev7.filter((d) => classifyLevel(d, expectedMeals) === 'high');
  const highCoverageDays7d = high7.length;

  const targetView = target
    ? { kcal: target.energyKcal, p: target.proteinG, c: target.carbohydrateG, f: target.fatG, source: target.source }
    : null;

  // `intake_silent` é a ÚNICA exceção que não exige `state==='ready'`: ela é
  // exatamente o sinal de "tinha alta cobertura, sumiu" — exigir alta
  // cobertura ATUAL pra disparar um alerta de silêncio seria contraditório.
  // Nunca dispara para quem nunca usou (persona E: `window14to6` vazio).
  const silentException: IntakeException | null =
    window14to6.length >= 4 && last5.length === 0
      ? { type: 'intake_silent', detail: 'Sem registro de refeição nos últimos 5 dias, após uso regular' }
      : null;

  if (!target || highCoverageDays7d < 4) {
    const avg = (arr: DayAgg[], key: 'totalKcal' | 'proteinG' | 'carbohydrateG' | 'fatG') =>
      arr.length > 0 ? round1(arr.reduce((s, d) => s + d[key], 0) / arr.length) : null;
    return {
      state: 'insufficient',
      daysLogged7d,
      highCoverageDays7d,
      avgKcal7d: avg(high7, 'totalKcal'),
      avgProteinG7d: avg(high7, 'proteinG'),
      avgCarbG7d: avg(high7, 'carbohydrateG'),
      avgFatG7d: avg(high7, 'fatG'),
      target: targetView,
      kcalTrend: null,
      exception: silentException,
    };
  }

  const avgHigh = (key: 'totalKcal' | 'proteinG' | 'carbohydrateG' | 'fatG') =>
    round1(high7.reduce((s, d) => s + d[key], 0) / high7.length);
  const avgKcal7d = avgHigh('totalKcal');
  const avgProteinG7d = avgHigh('proteinG');
  const avgCarbG7d = avgHigh('carbohydrateG');
  const avgFatG7d = avgHigh('fatG');

  // Tendência: só com >=4 dias de alta cobertura nas DUAS janelas.
  let kcalTrend: IntakeTrend = null;
  if (highPrev7.length >= 4) {
    const avgPrevKcal = highPrev7.reduce((s, d) => s + d.totalKcal, 0) / highPrev7.length;
    const ratio = avgKcal7d / avgPrevKcal;
    kcalTrend = ratio <= 0.8 ? 'down' : ratio >= 1.2 ? 'up' : 'stable';
  }

  const exceptions: IntakeException[] = [];

  // intake_kcal_drop: média 7d <= 75% da média dos 7 anteriores, ambas com >=4 dias de alta cobertura.
  if (highPrev7.length >= 4) {
    const avgPrevKcal = highPrev7.reduce((s, d) => s + d.totalKcal, 0) / highPrev7.length;
    if (avgPrevKcal > 0 && avgKcal7d <= avgPrevKcal * 0.75) {
      exceptions.push({
        type: 'intake_kcal_drop',
        detail: `Ingestão média cai para ${Math.round(avgKcal7d)} kcal/dia (era ${Math.round(avgPrevKcal)} kcal/dia)`,
      });
    }
  }

  // intake_protein_low: proteína < 80% da meta em >=4 dos últimos 5 dias de ALTA cobertura.
  const last5High = [...high7].sort((a, b) => daysAgo(a, todayKey) - daysAgo(b, todayKey)).slice(0, 5);
  if (target && last5High.length >= 4) {
    const lowProteinDays = last5High.filter((d) => d.proteinG < target.proteinG * 0.8);
    if (lowProteinDays.length >= 4) {
      const avgLowProtein = round1(lowProteinDays.reduce((s, d) => s + d.proteinG, 0) / lowProteinDays.length);
      exceptions.push({
        type: 'intake_protein_low',
        detail: `Proteína média ${avgLowProtein} g vs meta ${target.proteinG} g em ${lowProteinDays.length} dos últimos ${last5High.length} dias de alta cobertura`,
      });
    }
  }

  if (silentException) exceptions.push(silentException);

  // intake_over: kcal >= 120% da meta em >=5 dos 7 dias REGISTRADOS (qualquer log), objetivo != ganho.
  if (target && objective !== 'muscle_gain' && last7.length >= 5) {
    const overDays = last7.filter((d) => d.totalKcal >= target.energyKcal * 1.2);
    if (overDays.length >= 5) {
      exceptions.push({
        type: 'intake_over',
        detail: `Ingestão ${Math.round((overDays.length / last7.length) * 100)}% dos dias registrados acima de 120% da meta`,
      });
    }
  }

  // Severidade fixa: kcal_drop > protein_low > silent > over. No máx. 1 aqui
  // (o teto de 2 insights de ingestão é responsabilidade do consumidor, que
  // decide quantos ANEXAR à lista — este módulo devolve o mais severo).
  const severity: IntakeExceptionType[] = ['intake_kcal_drop', 'intake_protein_low', 'intake_silent', 'intake_over'];
  const exception = severity
    .map((type) => exceptions.find((e) => e.type === type))
    .find((e): e is IntakeException => Boolean(e)) ?? null;

  return {
    state: 'ready',
    daysLogged7d,
    highCoverageDays7d,
    avgKcal7d,
    avgProteinG7d,
    avgCarbG7d,
    avgFatG7d,
    target: targetView,
    kcalTrend,
    exception,
  };
}
