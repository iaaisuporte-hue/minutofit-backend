/**
 * Consistência de FREQUÊNCIA — função pura.
 *
 * ## Não confundir com aderência
 *
 * O produto já tem `adherencePct` (`getStudentExecutionSummary`), que mede
 * **séries feitas ÷ séries prescritas** e é rotulado "Aderência às séries".
 * Este número aqui é outro: **dias ativos ÷ dias que a ficha prescreve**, e é
 * rotulado "Consistência de frequência".
 *
 * A distinção não é cosmética. Um QA anterior encontrou dois números diferentes
 * exibidos sob o mesmo rótulo "Aderência" em abas vizinhas, e o personal não
 * tinha como saber qual era qual. Os dois nomes de campo e os dois rótulos
 * ficam fixados aqui e na spec — quem for exibir um deles usa o rótulo inteiro,
 * nunca "aderência" solto.
 *
 * `computeEngagementScore` do dashboard do personal NÃO muda: ele já compõe os
 * dois conceitos com nomes próprios.
 *
 * ## De onde vem o denominador
 *
 * Em ordem: **ficha ativa** → **meta pessoal de frequência** → `null`.
 *
 * O segundo degrau existe porque o aluno B2C — o que assina sozinho, sem
 * personal — nunca tem ficha, e sem ele a consistência dele seria
 * permanentemente indefinida: a aba mostraria só números absolutos e os marcos
 * de semana ficariam inalcançáveis para sempre. A meta que ele mesmo declarou é
 * um compromisso legítimo, e medir contra ela é exatamente o princípio do
 * produto ("aderência ao próprio plano").
 *
 * A ficha tem precedência absoluta: existindo prescrição válida, uma meta
 * pessoal menor não pode substituí-la, ou bastaria declarar "1x por semana"
 * para exibir 100% de consistência contra um plano de 5x.
 *
 * Sem ficha e sem meta, `null` — e a tela mostra o número absoluto de dias
 * ativos. Zero seria mentira: significaria "faltou a tudo que foi pedido",
 * quando nada foi pedido. E nenhum padrão é inventado: 3x ou 4x por semana
 * seriam números arbitrários apresentados como se fossem do aluno.
 */
import {
  CONSISTENCY_MIN_WINDOW_DAYS,
  CONSISTENCY_WINDOW_DAYS,
} from './performance.constants';

/** De onde saiu o alvo semanal vigente. `null` quando não há alvo. */
export type WeeklyTargetSource = 'plan' | 'goal' | null;

export interface WeeklyFrequencyTarget {
  /** Dias de treino previstos por semana. `null` = sem alvo. */
  weeklyTarget: number | null;
  source: WeeklyTargetSource;
  /** Dia em que o alvo vigente passou a valer (`YYYY-MM-DD`). */
  since: string | null;
  /** Dias desde que o alvo vigente começou — usado na proporcionalidade. */
  daysSinceStarted: number | null;
}

export const NO_WEEKLY_TARGET: WeeklyFrequencyTarget = Object.freeze({
  weeklyTarget: null,
  source: null,
  since: null,
  daysSinceStarted: null,
});

/**
 * Escolhe o alvo vigente entre prescrição e meta pessoal.
 *
 * Pura de propósito: a precedência é regra de negócio e precisa ser testável
 * sem banco. Quem lê as duas fontes é o repositório.
 */
export function pickWeeklyTarget(
  plan: { weeklyTarget: number | null; since: string | null; daysSinceStarted: number | null },
  goal: { weeklyTarget: number | null; since: string | null; daysSinceStarted: number | null },
): WeeklyFrequencyTarget {
  if (plan.weeklyTarget != null && plan.weeklyTarget > 0) {
    return {
      weeklyTarget: plan.weeklyTarget,
      source: 'plan',
      since: plan.since,
      daysSinceStarted: plan.daysSinceStarted,
    };
  }
  if (goal.weeklyTarget != null && goal.weeklyTarget > 0) {
    return {
      weeklyTarget: goal.weeklyTarget,
      source: 'goal',
      since: goal.since,
      daysSinceStarted: goal.daysSinceStarted,
    };
  }
  return { ...NO_WEEKLY_TARGET };
}

/**
 * Alvo de dias ativos na janela, proporcional ao tempo de vínculo.
 *
 * A janela de 28 dias são exatamente 4 semanas, então o alvo cheio é
 * `semanal × 4` — sem a aproximação de 30/7 que o `resolveMonthlyTarget` precisa
 * fazer para o mês.
 *
 * A proporcionalidade ao tempo de vínculo é a mesma lição do
 * `resolveMonthlyTarget` (QA 02/ago/2026, P1-2): cobrar 28 dias de quem tem 3
 * dias de ficha é impossível de acertar, e o aluno que fez tudo certo apareceria
 * com número baixo.
 */
export function resolveConsistencyTarget(
  weeklyTarget: number | null,
  daysSincePlanStarted: number | null,
  windowDays: number = CONSISTENCY_WINDOW_DAYS,
): number | null {
  if (weeklyTarget == null || !Number.isFinite(weeklyTarget) || weeklyTarget <= 0) return null;

  const full = Math.max(1, Math.round(weeklyTarget * (windowDays / 7)));
  if (daysSincePlanStarted == null || daysSincePlanStarted >= windowDays) return full;

  const effectiveWindow = Math.max(daysSincePlanStarted, CONSISTENCY_MIN_WINDOW_DAYS);
  return Math.max(1, Math.round(full * (effectiveWindow / windowDays)));
}

/**
 * Percentual de consistência. `null` quando não há denominador.
 * Teto de 100: treinar mais que o prescrito é ótimo, mas "140% consistente"
 * não quer dizer nada — e a barra da UI não passa de cheia.
 */
export function computeConsistencyPct(activeDays: number, target: number | null): number | null {
  if (target == null || target <= 0) return null;
  const pct = Math.round((activeDays / target) * 100);
  return Math.min(100, Math.max(0, pct));
}

/**
 * Fração da frequência prevista que caracteriza "semana dentro do plano".
 *
 * Mora AQUI, e não no módulo de marcos, porque é a régua semanal do produto:
 * qualquer superfície que precise dizer "essa semana valeu" tem que usar a
 * mesma. Duas réguas produziriam a aba Consistência e o marco discordando sobre
 * a mesma semana — o defeito recorrente deste repositório.
 */
export const WEEK_WITHIN_PLAN_RATIO = 0.8;

/**
 * Dias de treino que fazem a semana contar como cumprida.
 *
 * Fração real, sem arredondar para baixo: com 3 previstos, 2 dias são 67% e não
 * chegam a 80%. Arredondar afrouxaria a regra em silêncio.
 */
export function weekWithinPlanThreshold(weeklyTarget: number): number {
  return weeklyTarget * WEEK_WITHIN_PLAN_RATIO;
}
