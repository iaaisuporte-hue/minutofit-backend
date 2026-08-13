/**
 * Engine de marcos — puro, determinístico, auditável (Spec 034, Onda C1).
 *
 * Recebe FATOS já lidos do banco e devolve quais marcos estão desbloqueados,
 * cada um com a evidência que sustenta a concessão. Nenhuma consulta, nenhuma
 * data implícita, nenhum LLM: as mesmas entradas produzem sempre a mesma saída,
 * que é o que permite testar as bordas sem banco e reproduzir à mão qualquer
 * marco que um aluno questione.
 *
 * ## A regra que não se repete
 *
 * "Semana cumprida" **não** ganha definição nova aqui. O alvo semanal vem de
 * `weeklyTargetFromPreset` (a ficha), os dias ativos vêm da mesma UNION de três
 * fontes que a aba Consistência usa, e a semana é ISO (segunda a domingo), como
 * nas metas. Criar uma segunda interpretação produziria o pior defeito
 * possível: a aba Consistência mostrando 4 e o marco dizendo que a semana não
 * fechou.
 *
 * Consequência assumida: sem ficha ativa não há alvo semanal, e os três marcos
 * que dependem dele (`first_full_week`, `four_consistent_weeks`, `comeback`)
 * ficam indisponíveis. É a regra `null` = "não dá para afirmar" do repositório —
 * preferimos não conceder a inventar um denominador. Quando a Performance
 * ganhar o fallback de meta pessoal como denominador, os dois lugares passam a
 * enxergar juntos, porque leem a mesma função.
 *
 * ## Semana fechada × semana corrente
 *
 * Uma semana só reprova quando termina — a semana corrente não pode derrubar
 * uma sequência que ainda está em curso. Mas se ela **já** cumpriu o previsto,
 * conta: fazer o aluno esperar até domingo para ver um marco que ele conquistou
 * na sexta seria burocracia, não honestidade.
 */
import { startOfIsoWeek } from '../performance/goals.engine';
import {
  WEEK_WITHIN_PLAN_RATIO,
  weekWithinPlanThreshold,
} from '../performance/consistency.engine';
import type { MilestoneCode } from './milestones.catalog';

/** Janela de avaliação. 26 semanas cobrem os 13 do trimestre com folga. */
export const MILESTONE_WINDOW_DAYS = 182;

/**
 * Régua da "semana dentro do plano" — reexportada do módulo Performance, que é
 * o dono. Reexportar em vez de redefinir deixa explícito que não há segunda
 * definição: mudar lá muda aqui.
 */
export const CONSISTENT_WEEK_RATIO = WEEK_WITHIN_PLAN_RATIO;

/** Semanas seguidas exigidas por `four_consistent_weeks`. */
export const CONSISTENT_WEEKS_REQUIRED = 4;

/** Dias parado que caracterizam a pausa de `comeback`. */
export const COMEBACK_GAP_DAYS = 21;

/** Semanas dentro do plano exigidas depois do retorno. */
export const COMEBACK_WEEKS_REQUIRED = 3;

/** Trimestre de `three_months_active`: 13 semanas avaliadas, 11 com atividade. */
export const QUARTER_WEEKS = 13;
export const QUARTER_WEEKS_WITH_ACTIVITY = 11;

/** Metas concluídas exigidas por `ten_goals`. */
export const GOALS_REQUIRED = 10;

export interface MilestoneFacts {
  /** Hoje, no fuso do aluno (`dayKey`). */
  today: string;
  /** Primeira sessão RICA de todos os tempos — sem janela. */
  firstSession: { sessionId: number; performedAt: string } | null;
  /**
   * Primeiro dia com treino pela UNIÃO das três fontes.
   *
   * Existe porque presença registrada pelo personal (Spec 009) conta como
   * treino em toda a aba Consistência: sem isto, quem só é acompanhado
   * presencialmente ganharia marcos de semana sem nunca ganhar o de primeiro
   * treino.
   */
  firstActiveDay: string | null;
  /** Primeiro recorde REAL: `is_first = false`. Ver `firstPr` abaixo. */
  firstRealPr: {
    prEventId: number;
    exerciseId: string | null;
    kind: string;
    achievedAt: string;
  } | null;
  /** Metas com `status = 'achieved'`. */
  goalsAchieved: number;
  /** Data da última meta concluída — carimbo do marco `ten_goals`. */
  goalsLastAchievedAt: string | null;
  /** Dias com treino na janela, ordenados, sem repetição (`YYYY-MM-DD`). */
  activeDays: string[];
  /** Último dia ativo ANTES da janela — permite ver uma pausa que começou fora. */
  previousActiveDay: string | null;
  /** Dias de treino previstos por semana. `null` = sem ficha ativa. */
  weeklyTarget: number | null;
  /**
   * Dia em que a ficha ATIVA passou a valer (`null` = sem ficha).
   *
   * Os marcos de semana só julgam o período em que o alvo atual vigorou. Sem
   * essa fronteira, trocar a ficha de 5x para 3x concederia retroativamente
   * marcos sob um alvo que nunca existiu naquelas semanas — e a evidência
   * registraria o alvo novo sobre semanas vividas com o antigo. Também resolve
   * a ficha que começa numa quarta-feira: a semana inicial é parcial por
   * natureza e não pode reprovar.
   */
  planActiveSince: string | null;
}

export interface MilestoneUnlock {
  code: MilestoneCode;
  /** Quando o marco foi conquistado — a data do FATO, não a da avaliação. */
  unlockedAt: string;
  evidence: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Semanas
 * ------------------------------------------------------------------ */

interface WeekBucket {
  start: string;
  end: string;
  activeDays: number;
  /** `false` na semana corrente: ela ainda pode melhorar. */
  closed: boolean;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

function diffDays(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/**
 * Agrupa os dias ativos em semanas ISO contíguas, da mais antiga à mais
 * recente. Semanas sem nenhum treino também entram — são justamente elas que
 * quebram uma sequência, e omiti-las faria "4 semanas seguidas" passar a
 * significar "4 semanas com treino em qualquer época".
 */
export function buildWeekBuckets(facts: MilestoneFacts): WeekBucket[] {
  const currentWeek = startOfIsoWeek(facts.today);
  const firstDay = facts.activeDays[0];
  if (!firstDay) return [];

  const buckets: WeekBucket[] = [];
  const counts = new Map<string, number>();
  for (const day of facts.activeDays) {
    const w = startOfIsoWeek(day);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  for (let w = startOfIsoWeek(firstDay); w <= currentWeek; w = addDays(w, 7)) {
    buckets.push({
      start: w,
      end: addDays(w, 6),
      activeDays: counts.get(w) ?? 0,
      closed: w !== currentWeek,
    });
  }
  return buckets;
}

/** Dias de treino que fazem a semana contar como "dentro do plano". */
export const consistentWeekThreshold = weekWithinPlanThreshold;

/** A semana conta como cumprida? A corrente só entra se JÁ cumpriu. */
function weekMeets(bucket: WeekBucket, threshold: number): boolean {
  if (bucket.activeDays >= threshold) return true;
  return false;
}

/** Semana reprovada: só uma semana FECHADA pode quebrar uma sequência. */
function weekFails(bucket: WeekBucket, threshold: number): boolean {
  return bucket.closed && bucket.activeDays < threshold;
}

/* ------------------------------------------------------------------ *
 * Avaliadores
 * ------------------------------------------------------------------ */

function evalFirstWorkout(f: MilestoneFacts): MilestoneUnlock | null {
  // A sessão rica é a melhor evidência (aponta um id verificável); a união é a
  // rede de segurança para quem treina com o personal e não registra sozinho.
  if (f.firstSession) {
    return {
      code: 'first_workout',
      unlockedAt: f.firstSession.performedAt,
      evidence: {
        sessionId: f.firstSession.sessionId,
        performedAt: f.firstSession.performedAt,
      },
    };
  }
  if (f.firstActiveDay) {
    return {
      code: 'first_workout',
      unlockedAt: f.firstActiveDay,
      evidence: { activeDay: f.firstActiveDay, source: 'active_days_union' },
    };
  }
  return null;
}

function evalFirstPr(f: MilestoneFacts): MilestoneUnlock | null {
  // `is_first = true` é o PRIMEIRO registro do exercício — não é recorde, é o
  // ponto de partida. Contá-lo daria o marco a quem apenas registrou um treino,
  // esvaziando o significado de "superei a minha marca". O filtro é do
  // repositório, e este comentário existe para que ninguém o "conserte".
  if (!f.firstRealPr) return null;
  return {
    code: 'first_pr',
    unlockedAt: f.firstRealPr.achievedAt,
    evidence: {
      prEventId: f.firstRealPr.prEventId,
      exerciseId: f.firstRealPr.exerciseId,
      kind: f.firstRealPr.kind,
      achievedAt: f.firstRealPr.achievedAt,
    },
  };
}

function evalTenGoals(f: MilestoneFacts): MilestoneUnlock | null {
  if (f.goalsAchieved < GOALS_REQUIRED) return null;
  return {
    code: 'ten_goals',
    unlockedAt: f.goalsLastAchievedAt ?? f.today,
    evidence: {
      totalGoalsAchieved: f.goalsAchieved,
      required: GOALS_REQUIRED,
      lastAchievedAt: f.goalsLastAchievedAt,
    },
  };
}

/**
 * Semanas em que o alvo ATUAL realmente vigorou.
 *
 * Julgar 26 semanas com o alvo de hoje daria marcos retroativos sempre que a
 * ficha mudasse. E a semana em que a ficha começou é parcial: se o plano
 * entrou numa quarta, cobrar a frequência inteira dessa semana reprovaria o
 * aluno pelo dia em que o personal prescreveu.
 */
function weeksUnderCurrentPlan(f: MilestoneFacts, weeks: WeekBucket[]): WeekBucket[] {
  if (!f.planActiveSince) return weeks;
  const primeira = startOfIsoWeek(f.planActiveSince);
  return weeks.filter((w) => w.start >= primeira);
}

function evalFirstFullWeek(f: MilestoneFacts, weeks: WeekBucket[]): MilestoneUnlock | null {
  if (f.weeklyTarget == null || f.weeklyTarget <= 0) return null;
  const week = weeksUnderCurrentPlan(f, weeks).find((w) => w.activeDays >= f.weeklyTarget!);
  if (!week) return null;
  return {
    code: 'first_full_week',
    unlockedAt: week.end < f.today ? week.end : f.today,
    evidence: {
      weekStart: week.start,
      weekEnd: week.end,
      activeDays: week.activeDays,
      targetDays: f.weeklyTarget,
    },
  };
}

/**
 * Sequência de N semanas cumprindo o limiar, terminando o mais tarde possível.
 *
 * `graceStartDay` marca um retorno no meio da semana: quem voltou num sábado
 * tem dois dias, e cobrar dele a frequência inteira reprovaria a semana pelo
 * dia em que ele decidiu voltar. Essa semana então não soma nem quebra — a
 * mesma regra da semana corrente, pela mesma razão: só uma semana que a pessoa
 * teve inteira pode reprovar.
 */
function findWeekStreak(
  weeks: WeekBucket[],
  threshold: number,
  required: number,
  fromIndex = 0,
  graceStartDay?: string,
): WeekBucket[] | null {
  let run: WeekBucket[] = [];
  for (let i = fromIndex; i < weeks.length; i += 1) {
    const w = weeks[i];
    const parcial = graceStartDay != null && w.start < graceStartDay;
    if (weekMeets(w, threshold)) {
      run.push(w);
      if (run.length >= required) return run.slice(-required);
    } else if (!parcial && weekFails(w, threshold)) {
      run = [];
    }
    // Semana corrente ou de retorno que ainda não cumpriu: não soma, não quebra.
  }
  return null;
}

function evalFourConsistentWeeks(
  f: MilestoneFacts,
  weeks: WeekBucket[],
): MilestoneUnlock | null {
  if (f.weeklyTarget == null || f.weeklyTarget <= 0) return null;
  const threshold = consistentWeekThreshold(f.weeklyTarget);
  const janela = weeksUnderCurrentPlan(f, weeks);
  const run = findWeekStreak(
    janela,
    threshold,
    CONSISTENT_WEEKS_REQUIRED,
    0,
    f.planActiveSince ?? undefined,
  );
  if (!run) return null;
  const last = run[run.length - 1];
  return {
    code: 'four_consistent_weeks',
    unlockedAt: last.end < f.today ? last.end : f.today,
    evidence: {
      weeks: run.map((w) => ({ start: w.start, activeDays: w.activeDays })),
      targetDays: f.weeklyTarget,
      thresholdDays: Number(threshold.toFixed(2)),
    },
  };
}

/**
 * Três meses ativo — "regular" definido de forma determinística.
 *
 * A spec diz "90 dias com atividade regular" sem dizer o que é regular, e a
 * regra proíbe inventar score novo. A definição escolhida usa só o que já
 * existe (dias ativos por semana ISO): das **13 semanas fechadas** mais
 * recentes, **11 precisam ter pelo menos um treino**.
 *
 * Por que assim, e não "90 dias × N treinos": o marco é sobre PRESENÇA
 * distribuída no tempo, não sobre volume — quem treinou 40 vezes em três
 * semanas e sumiu não passou três meses ativo. E as duas semanas de folga são
 * deliberadas: viagem e gripe não são falha de caráter, e o tom do produto
 * proíbe punir ausência.
 */
function evalThreeMonthsActive(
  f: MilestoneFacts,
  weeks: WeekBucket[],
): MilestoneUnlock | null {
  const closed = weeks.filter((w) => w.closed);
  if (closed.length < QUARTER_WEEKS) return null;

  const window = closed.slice(-QUARTER_WEEKS);
  const withActivity = window.filter((w) => w.activeDays > 0).length;
  if (withActivity < QUARTER_WEEKS_WITH_ACTIVITY) return null;

  return {
    code: 'three_months_active',
    unlockedAt: window[window.length - 1].end,
    evidence: {
      weeksEvaluated: QUARTER_WEEKS,
      weeksWithActivity: withActivity,
      required: QUARTER_WEEKS_WITH_ACTIVITY,
      windowStart: window[0].start,
      windowEnd: window[window.length - 1].end,
    },
  };
}

/**
 * Retomada — pausa longa seguida de volta SUSTENTADA.
 *
 * Um treino isolado depois de 21 dias parados não é retomada; é um treino. O
 * marco exige três semanas dentro da programação depois do retorno, com o mesmo
 * limiar de 80% das quatro semanas consistentes — a régua da "semana dentro do
 * plano" é uma só no módulo inteiro.
 */
function evalComeback(f: MilestoneFacts, weeks: WeekBucket[]): MilestoneUnlock | null {
  if (f.weeklyTarget == null || f.weeklyTarget <= 0) return null;
  if (f.activeDays.length === 0) return null;

  // Procura a pausa mais recente: comparar de trás para frente encontra a volta
  // atual, não uma retomada antiga que já rendeu o marco.
  let gapDays = 0;
  let returnedOn: string | null = null;
  for (let i = f.activeDays.length - 1; i >= 0; i -= 1) {
    const previous = i > 0 ? f.activeDays[i - 1] : f.previousActiveDay;
    if (!previous) break;
    const gap = diffDays(previous, f.activeDays[i]);
    if (gap >= COMEBACK_GAP_DAYS) {
      gapDays = gap;
      returnedOn = f.activeDays[i];
      break;
    }
  }
  if (!returnedOn) return null;

  const threshold = consistentWeekThreshold(f.weeklyTarget);
  const janela = weeksUnderCurrentPlan(f, weeks);
  const returnWeek = startOfIsoWeek(returnedOn);
  const fromIndex = janela.findIndex((w) => w.start >= returnWeek);
  if (fromIndex < 0) return null;

  // A folga vale para a semana do RETORNO e para a semana em que a ficha
  // começou — as duas são parciais pela mesma razão.
  const grace = f.planActiveSince && f.planActiveSince > returnedOn ? f.planActiveSince : returnedOn;
  const run = findWeekStreak(
    janela,
    threshold,
    COMEBACK_WEEKS_REQUIRED,
    fromIndex,
    grace,
  );
  if (!run) return null;

  const last = run[run.length - 1];
  return {
    code: 'comeback',
    unlockedAt: last.end < f.today ? last.end : f.today,
    evidence: {
      inactivityDays: gapDays,
      returnedOn,
      weeksCompletedAfterReturn: run.length,
      windowFrom: run[0].start,
      windowTo: last.end,
      targetDays: f.weeklyTarget,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Entrada única
 * ------------------------------------------------------------------ */

/**
 * Todos os marcos que os fatos sustentam AGORA — inclusive os que o aluno já
 * tem. Filtrar o que já foi concedido é trabalho do banco (`UNIQUE`), não do
 * engine: assim a função continua pura e o reprocessamento é trivialmente
 * seguro.
 *
 * `challenge_completed` não aparece: não tem avaliador na C1 (§catálogo).
 */
export function evaluateMilestoneFacts(facts: MilestoneFacts): MilestoneUnlock[] {
  const weeks = buildWeekBuckets(facts);

  const unlocks = [
    evalFirstWorkout(facts),
    evalFirstPr(facts),
    evalTenGoals(facts),
    evalFirstFullWeek(facts, weeks),
    evalFourConsistentWeeks(facts, weeks),
    evalThreeMonthsActive(facts, weeks),
    evalComeback(facts, weeks),
  ].filter((u): u is MilestoneUnlock => u !== null);

  return unlocks;
}
