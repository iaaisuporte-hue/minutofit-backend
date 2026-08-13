/**
 * Metas de performance — funções puras (Spec 033, Onda P4).
 *
 * ## A distinção que organiza este arquivo
 *
 * Nem toda métrica anda para um lado só, e tratar todas igual produz absurdos
 * em direções opostas:
 *
 * - **Monotônicas** (carga, e1RM, reps com carga, streak): o que vale é o
 *   MELHOR já feito. Quem levantou 95 kg não "desaprendeu" ao fazer um treino
 *   leve de 60 kg na semana seguinte. Se a meta lesse o último valor, a barra
 *   andaria para trás sozinha e o aluno veria progresso evaporar por ter feito
 *   exatamente o que a periodização mandava.
 * - **Cíclicas** (frequência semanal e mensal): medem um período que ZERA. "4
 *   treinos por semana" na segunda-feira é 0 de 4, e isso é correto — guardar o
 *   melhor aqui mostraria 4/4 para sempre depois da primeira boa semana, e a
 *   meta viraria um troféu em vez de um compromisso.
 *
 * A conclusão, porém, é monotônica nos DOIS casos: quem cumpriu a semana de 4
 * treinos cumpriu, e a semana seguinte não desfaz isso. Progresso é uma leitura
 * do presente; conquista é um fato do passado.
 *
 * ## Nada de NaN na API
 *
 * Toda divisão daqui tem denominador conferido antes, e todo resultado passa
 * por `finite()`. `NaN` serializa como `null` em JSON e `Infinity` vira `null`
 * silenciosamente — o cliente receberia campo vazio sem saber por quê. Aqui a
 * ausência é decidida, não acidental.
 */

export type GoalKind =
  | 'exercise_load'
  | 'exercise_e1rm'
  | 'exercise_reps_at_load'
  | 'weekly_frequency'
  | 'monthly_frequency'
  | 'streak';

export type GoalStatus = 'active' | 'achieved' | 'abandoned' | 'expired';
export type GoalUnit = 'kg' | 'sessions' | 'days';

export const GOAL_KINDS: readonly GoalKind[] = [
  'exercise_load',
  'exercise_e1rm',
  'exercise_reps_at_load',
  'weekly_frequency',
  'monthly_frequency',
  'streak',
];

/** Máximo de metas `active` simultâneas (Spec 033 §Regras de negócio). */
export const MAX_ACTIVE_GOALS = 5;

/** Versão da métrica gravada em cada meta. Ver `docs/performance-formulas.md`. */
export const GOAL_METRIC_VERSION = 1;

export function isExerciseKind(kind: GoalKind): boolean {
  return kind.startsWith('exercise_');
}

/**
 * Tipos cujo valor de referência é o melhor já alcançado.
 *
 * Deliberadamente uma tabela, e não uma regra derivada do nome: `streak` é
 * monotônica sem ser de exercício, e `weekly_frequency` é cíclica apesar de
 * medir treino. Qualquer heurística por prefixo erraria as duas.
 */
const MONOTONIC: Readonly<Record<GoalKind, boolean>> = Object.freeze({
  exercise_load: true,
  exercise_e1rm: true,
  exercise_reps_at_load: true,
  streak: true,
  weekly_frequency: false,
  monthly_frequency: false,
});

export function isMonotonicKind(kind: GoalKind): boolean {
  return MONOTONIC[kind];
}

/** Unidade implícita do tipo. O cliente não escolhe — seria uma forma de mentir. */
export function unitForKind(kind: GoalKind): GoalUnit {
  switch (kind) {
    case 'exercise_load':
    case 'exercise_e1rm':
    case 'exercise_reps_at_load':
      return 'kg';
    case 'weekly_frequency':
    case 'monthly_frequency':
      return 'sessions';
    case 'streak':
      return 'days';
  }
}

function finite(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

export interface GoalProgressInput {
  kind: GoalKind;
  /** Estado no momento da criação. `null` = nunca houve medição. */
  baseline: number | null;
  target: number;
  /** Valor do período corrente (ou da última medição). */
  current: number | null;
  /** Melhor valor já registrado desde a criação. */
  best: number | null;
}

export interface GoalProgress {
  /** Fração 0..1. `null` quando não há medição para afirmar nada. */
  ratio: number | null;
  /** O valor que a tela mostra como "onde estou". */
  displayValue: number | null;
  /** Alvo alcançado por este valor? */
  reached: boolean;
  /** Quanto falta, na unidade da meta. `null` sem medição, 0 quando atingida. */
  remaining: number | null;
}

/**
 * Progresso determinístico.
 *
 * A fórmula é `(atual − baseline) ÷ (alvo − baseline)`: mede o caminho andado
 * a partir de onde o aluno estava, e não a partir de zero. A diferença importa
 * — quem sai de 90 kg rumo a 100 já teria 90% de barra na fórmula ingênua,
 * antes de levantar nada de novo, e a meta pareceria quase pronta no dia em que
 * nasceu.
 */
export function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  const { kind, target } = input;

  // Monotônica lê o melhor; cíclica lê o período corrente. Nunca as duas.
  const observed = isMonotonicKind(kind)
    ? Math.max(finite(input.best) ? input.best : Number.NEGATIVE_INFINITY,
               finite(input.current) ? input.current : Number.NEGATIVE_INFINITY)
    : finite(input.current)
      ? input.current
      : Number.NEGATIVE_INFINITY;

  if (!finite(target) || target <= 0 || !finite(observed)) {
    return { ratio: null, displayValue: finite(observed) ? observed : null, reached: false, remaining: null };
  }

  const reached = observed >= target;
  const remaining = reached ? 0 : Math.round((target - observed) * 100) / 100;

  // Sem baseline (nunca treinou o exercício), o caminho se mede do zero. Não é
  // inventar um baseline: é dizer que ele não existe e cair na leitura mais
  // simples possível — quanto do alvo já foi alcançado.
  const from = finite(input.baseline) ? input.baseline : 0;
  const span = target - from;

  // Denominador não-positivo só sobra em meta legada (a criação recusa alvo
  // igual ou menor que o baseline). Sem uma resposta binária aqui, a divisão
  // devolveria Infinity.
  if (!finite(span) || span <= 0) {
    return { ratio: reached ? 1 : 0, displayValue: observed, reached, remaining };
  }

  const raw = (observed - from) / span;
  if (!Number.isFinite(raw)) {
    return { ratio: null, displayValue: observed, reached, remaining };
  }

  // Clamp em 1: passar do alvo não rende 130% de barra. E clamp em 0: quem
  // regrediu abaixo do baseline vê zero, não um número negativo.
  const ratio = Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000));
  return { ratio, displayValue: observed, reached, remaining };
}

/**
 * A meta já nasceria cumprida?
 *
 * Criar "chegar a 100 kg" para quem já levanta 105 produz uma linha que nasce
 * concluída — um troféu retroativo que ninguém perseguiu. A API recusa, e a UI
 * mostra o valor atual para que o aluno escolha um alvo que signifique algo.
 */
export function isGoalAlreadyMet(baseline: number | null, target: number): boolean {
  return finite(baseline) && finite(target) && baseline >= target;
}

/**
 * Prazo vencido, comparado em DIA do aluno.
 *
 * As duas datas chegam como `YYYY-MM-DD` (o `dayKey()` do app, fuso de São
 * Paulo). Comparar string aqui é correto e proposital: virar `Date` reintroduz
 * o fuso do servidor, e uma meta que vence hoje às 23h em Brasília expiraria de
 * manhã porque o Render roda em UTC.
 */
export function isGoalExpired(dueOn: string | null, today: string): boolean {
  if (!dueOn) return false;
  return dueOn < today;
}

/** Transições permitidas. Fora desta tabela, nada muda de estado. */
const ALLOWED: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = Object.freeze({
  active: ['achieved', 'abandoned', 'expired'],
  achieved: [],
  abandoned: [],
  expired: [],
});

/**
 * Estado final é final.
 *
 * Uma meta concluída não volta a `active` porque a performance caiu depois — a
 * conquista aconteceu, e reabri-la reescreveria a história do aluno. Uma meta
 * abandonada também não ressuscita sozinha: quem desistiu de chegar a 100 kg e
 * um dia chega lá merece a celebração de um recorde, não a de uma meta que ele
 * havia riscado da lista.
 */
export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Início da semana ISO (segunda-feira) do dia informado.
 *
 * Aritmética sobre a string `YYYY-MM-DD` via `Date.UTC`, e não sobre um `Date`
 * local: instanciar `new Date('2026-08-13')` já aplica o fuso do processo, e o
 * servidor roda em UTC enquanto o aluno vive em São Paulo. Fixando tudo em UTC,
 * a conta trata a data como o rótulo que ela é — o dia já foi resolvido no fuso
 * do aluno lá atrás, por `dayKey()`.
 *
 * Segunda-feira porque é o padrão ISO e o que o calendário do módulo já usa.
 * Semana começando no domingo faria a meta "4 treinos por semana" zerar num dia
 * diferente do heatmap que o aluno vê na aba ao lado.
 */
export function startOfIsoWeek(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay(); // 0 = domingo
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** Primeiro dia do mês do dia informado. Mês de calendário, não 30 dias. */
export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * Eixo em que o progresso é medido.
 *
 * Quase sempre é `target_value`. A exceção é `exercise_reps_at_load`, o único
 * tipo com dois alvos: a carga é o FILTRO ("séries de pelo menos 30 kg") e as
 * repetições são a meta. Medir progresso pela carga aqui daria 100% já na
 * criação para quem levanta 30 kg fazendo 4 repetições.
 */
export function progressTarget(kind: GoalKind, targetValue: number, targetReps: number | null): number {
  return kind === 'exercise_reps_at_load' && targetReps != null ? targetReps : targetValue;
}

/** Unidade do eixo de progresso — ver `progressTarget`. */
export function progressUnit(kind: GoalKind): GoalUnit | 'reps' {
  return kind === 'exercise_reps_at_load' ? 'reps' : unitForKind(kind);
}
