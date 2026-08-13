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
 * ## Por que o denominador pode não existir
 *
 * Sem ficha ativa não há prescrição, e sem prescrição não existe "quanto era
 * para treinar". Nesse caso devolvemos `null` e a tela mostra o número absoluto
 * de dias ativos. Zero seria mentira: significaria "faltou a tudo que foi
 * pedido", quando nada foi pedido.
 */
import {
  CONSISTENCY_MIN_WINDOW_DAYS,
  CONSISTENCY_WINDOW_DAYS,
} from './performance.constants';

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
