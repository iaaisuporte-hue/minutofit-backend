/**
 * Quantos dias de treino a semana tem, segundo o preset da ficha.
 *
 * ## Por que isto existe
 *
 * O campo `personal_workout_plans.week_preset` era lido em DOIS lugares com
 * regras diferentes:
 *
 * - `weeklyTargetFromPreset` (consistência, aderência, Progress Score) mapeava
 *   `'semana_util'` para 5, corretamente;
 * - `computeTodayDayIndex` (qual treino é o de hoje) fazia `parseInt`, obtinha
 *   `NaN` e caía no dia 1 — todos os dias, para sempre.
 *
 * O mesmo aluno, na mesma ficha, era contado como "5 treinos previstos" pelo
 * motor de consistência enquanto o app lhe entregava sempre o Dia 1. Duas
 * definições do mesmo conceito, e a mais silenciosa ganhava na tela.
 *
 * Este módulo passa a ser a definição única. Os dois consumidores importam
 * daqui.
 *
 * ## Preset desconhecido não falha em silêncio
 *
 * Devolve `null` e registra aviso. Quem precisa de um número decide o próprio
 * fallback — a alternativa (chutar um valor aqui) esconderia dado sujo em vez
 * de expô-lo.
 */
import logger from '../lib/logger';

/**
 * Apelidos históricos. Ficam explícitos, e não numa heurística de string:
 * "semana útil" é uma decisão de produto (segunda a sexta), não uma
 * consequência de parsing.
 */
const ALIASES: Readonly<Record<string, number>> = Object.freeze({
  semana_util: 5,
});

const MIN_DIAS = 1;
const MAX_DIAS = 7;

/**
 * Dias de treino do preset. `null` quando o valor não é reconhecido.
 *
 * Nunca devolve `NaN`: é o defeito que esta função existe para eliminar.
 */
export function resolveWeekDays(preset: string | null | undefined): number | null {
  if (preset == null) return null;

  const chave = String(preset).trim();
  if (chave === '') return null;

  const alias = ALIASES[chave];
  if (alias != null) return alias;

  const n = Number(chave);
  if (Number.isInteger(n) && n >= MIN_DIAS && n <= MAX_DIAS) return n;

  // Nem apelido conhecido nem número na faixa: dado sujo ou preset novo que
  // alguém introduziu sem passar por aqui. Um log por ocorrência é barato e é
  // o que transforma "o treino do fulano está estranho" em uma pista.
  logger.warn({ preset: chave }, '[training] week_preset não reconhecido');
  return null;
}

/**
 * Dia do ciclo para hoje, 1-based.
 *
 * ## Fuso
 *
 * O dia da semana sai do DIA DO ALUNO (`dayKey`, América/São_Paulo), não de
 * `new Date().getDay()`. O servidor roda em UTC: às 21h de domingo em Brasília
 * já é segunda em UTC, e o aluno receberia o treino de segunda no domingo à
 * noite — o mesmo erro de fuso que `utils/appDay.ts` foi criado para corrigir
 * no resto do produto.
 *
 * ## Preset desconhecido
 *
 * Cai no dia 1. É o único índice que sempre existe numa ficha, então é o
 * fallback que nunca entrega tela vazia. O aviso já foi registrado por
 * `resolveWeekDays`.
 */
export function computeTodayDayIndex(
  preset: string | null | undefined,
  dayKeyHoje: string,
): number {
  const dias = resolveWeekDays(preset);
  if (dias == null) return 1;

  const dow = isoDayOfWeek(dayKeyHoje);
  return ((dow - 1) % dias) + 1;
}

/**
 * Dia da semana ISO (1 = segunda … 7 = domingo) a partir de `YYYY-MM-DD`.
 *
 * A conta é feita em UTC de propósito: a string já É o dia do aluno, resolvido
 * antes por `dayKey()`. Instanciar `new Date('2026-08-13')` aplicaria o fuso do
 * processo por cima de uma data que já estava correta, reintroduzindo o
 * problema que a string resolveu.
 */
export function isoDayOfWeek(dayKeyValue: string): number {
  const [y, m, d] = dayKeyValue.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}
