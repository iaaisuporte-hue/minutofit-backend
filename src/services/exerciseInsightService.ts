/**
 * Recorrência de substituições + insights determinísticos (Sprint P2B).
 *
 * Consome `executionClassificationService.ts` — não duplica a query de
 * cruzamento sessão×prescrito×executado, só agrupa o resultado por exercício
 * ORIGINAL para responder duas perguntas do harness (`RECURRENCE_RULES`):
 *
 *   por PAR (original → substituto específico): >= 3 ocorrências do MESMO par
 *     dentre as últimas 5 vezes em que o original esteve prescrito
 *   por EXERCÍCIO ORIGINAL (substituto qualquer): >= 3 substituições dentre
 *     as mesmas últimas 5 vezes
 *
 * As duas regras leem a MESMA janela de 5 ocorrências — só mudam o
 * agrupamento (por par vs. por exercício) — e disparam o MESMO tipo de
 * insight (`RECURRING_REPLACEMENT`); o payload sempre mostra a mistura real
 * de alternativas usadas, então o Personal vê os dois ângulos sem precisar de
 * dois cards.
 *
 * Janela de RECORRÊNCIA é maior que a de aderência (30d, D-DENOMINATOR-JANELA):
 * "últimas 5 vezes prescrito" pode ultrapassar 30 dias num aluno que treina
 * pouco. `RECURRENCE_WINDOW_DAYS`/`RECURRENCE_SESSION_CAP` abaixo são o teto
 * defensivo (mesmo espírito do `SESSION_CAP` em
 * `executionClassificationService.ts` e do `CANDIDATE_POOL_LIMIT` em
 * `exerciseReplacementSuggestionService.ts`, P2A) — decisão de calibração
 * documentada no harness, não uma regra do produto.
 *
 * `INSIGHT_RULES`: `DISCOMFORT_PATTERN` (motivo "Dor ou desconforto" em >= 2
 * das substituições recentes) é tipo PRÓPRIO, com threshold MENOR que o de
 * recorrência geral — pode disparar mesmo quando `RECURRING_REPLACEMENT` não
 * dispara (ex.: 2 substituições por dor de um total de 2, abaixo do "3 em 5"
 * geral). Prioridade final: desconforto sempre acima; dentro do mesmo tipo,
 * recorrência desc, depois recência desc. Cap de 5.
 *
 * Consolidação de motivo: `substitution_reason` é texto livre (harness:
 * "não há enum backend") — agrupamento por igualdade exata de string. O
 * gatilho de `DISCOMFORT_PATTERN` reconhece o texto fixo hoje emitido pelo
 * picker do frontend (`"Dor ou desconforto"`); um motivo digitado diferente
 * não dispara esse tipo (mas ainda entra na consolidação geral de
 * `predominantReason` de `RECURRING_REPLACEMENT`, sem privilégio).
 */
import pool from '../config/database';
import { classifyExecutionForWindow, type ExerciseExecution } from './executionClassificationService';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

export type InsightType = 'DISCOMFORT_PATTERN' | 'RECURRING_REPLACEMENT';

export type InsightAlternative = {
  exerciseId: string;
  exerciseName: string;
  count: number;
  /** Selo do harness (item 32): existe linha em `exercise_replacement_alternatives`
   * (P2A) para este par, cadastrada pelo MESMO personal que está vendo o insight. */
  approvedByPersonal: boolean;
};

export type ExerciseInsight = {
  type: InsightType;
  originalExerciseId: string;
  originalExerciseName: string;
  /** Quantas das últimas prescrições entraram na conta (<= 5). */
  windowSize: number;
  /** Substituições (RECURRING_REPLACEMENT) ou substituições por desconforto (DISCOMFORT_PATTERN), dentro da janela acima. */
  occurrenceCount: number;
  mostRecentAt: string;
  alternatives: InsightAlternative[];
  predominantReason: { text: string; count: number } | null;
  /** ids de sessão que compuseram a contagem — auditabilidade ("por que este insight apareceu"). */
  auditSessionIds: number[];
};

const RECURRENCE_WINDOW_DAYS = 180;
const RECURRENCE_SESSION_CAP = 120;
const LAST_N_OCCURRENCES = 5;
const RECURRENCE_THRESHOLD = 3;
const DISCOMFORT_THRESHOLD = 2;
const MAX_INSIGHTS = 5;
/** Único texto com tratamento especial — o resto é consolidado por igualdade pura. */
const DISCOMFORT_REASON = 'Dor ou desconforto';

function assignmentError(): Error {
  const err = new Error('Student is not assigned to this personal trainer');
  (err as { code?: string }).code = 'ASSIGNMENT_REQUIRED';
  return err;
}

type ExerciseGroup = {
  exerciseId: string;
  exerciseName: string;
  /** As últimas <= 5 vezes que este exercício esteve prescrito, mais recente primeiro. */
  lastOccurrences: ExerciseExecution[];
};

/** Agrupa por exercício ORIGINAL. Itens sem `exerciseId` (ficha legada sem
 * vínculo à biblioteca) não entram — recorrência é acionável só quando há um
 * id para revisar na ficha; sem id não haveria o que reeditar. */
function groupByExercise(items: ExerciseExecution[]): Map<string, ExerciseGroup> {
  const byId = new Map<string, ExerciseExecution[]>();
  for (const it of items) {
    if (!it.exerciseId) continue;
    const list = byId.get(it.exerciseId) ?? [];
    list.push(it);
    byId.set(it.exerciseId, list);
  }
  const groups = new Map<string, ExerciseGroup>();
  for (const [exerciseId, occurrences] of byId) {
    const sorted = [...occurrences].sort((a, b) => b.performedAt.localeCompare(a.performedAt));
    groups.set(exerciseId, {
      exerciseId,
      exerciseName: sorted[0].exerciseName,
      lastOccurrences: sorted.slice(0, LAST_N_OCCURRENCES),
    });
  }
  return groups;
}

function tallyAlternatives(occurrences: ExerciseExecution[]): Map<string, { name: string; count: number }> {
  const counts = new Map<string, { name: string; count: number }>();
  for (const o of occurrences) {
    if (o.category !== 'SUBSTITUIDO' || !o.substitutedToExerciseId) continue;
    const cur = counts.get(o.substitutedToExerciseId) ?? {
      name: o.substitutedToExerciseName ?? 'Exercício',
      count: 0,
    };
    cur.count += 1;
    counts.set(o.substitutedToExerciseId, cur);
  }
  return counts;
}

function toAlternativesList(counts: Map<string, { name: string; count: number }>): InsightAlternative[] {
  return [...counts.entries()]
    .map(([exerciseId, v]) => ({ exerciseId, exerciseName: v.name, count: v.count, approvedByPersonal: false }))
    .sort((a, b) => b.count - a.count);
}

function tallyReasons(occurrences: ExerciseExecution[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of occurrences) {
    if (o.category !== 'SUBSTITUIDO') continue;
    const r = (o.substitutionReason ?? '').trim();
    if (!r) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

/** Constrói os 0-2 insights (recorrência + desconforto) de UM exercício original. */
function buildInsightsForGroup(group: ExerciseGroup): {
  recurring: ExerciseInsight | null;
  discomfort: ExerciseInsight | null;
} {
  const occ = group.lastOccurrences;
  const substituted = occ.filter((o) => o.category === 'SUBSTITUIDO');
  const alternativesCount = tallyAlternatives(occ);
  const reasons = tallyReasons(occ);
  const mostRecentAt = occ[0]?.performedAt ?? '';

  let recurring: ExerciseInsight | null = null;
  const topPairCount = Math.max(0, ...[...alternativesCount.values()].map((v) => v.count));
  // por PAR ou por EXERCÍCIO ORIGINAL — qualquer um basta (RECURRENCE_RULES).
  if (substituted.length >= RECURRENCE_THRESHOLD || topPairCount >= RECURRENCE_THRESHOLD) {
    const predominantEntry = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    recurring = {
      type: 'RECURRING_REPLACEMENT',
      originalExerciseId: group.exerciseId,
      originalExerciseName: group.exerciseName,
      windowSize: occ.length,
      occurrenceCount: substituted.length,
      mostRecentAt,
      alternatives: toAlternativesList(alternativesCount),
      predominantReason: predominantEntry ? { text: predominantEntry[0], count: predominantEntry[1] } : null,
      auditSessionIds: substituted.map((o) => o.sessionId),
    };
  }

  let discomfort: ExerciseInsight | null = null;
  const discomfortCount = reasons.get(DISCOMFORT_REASON) ?? 0;
  if (discomfortCount >= DISCOMFORT_THRESHOLD) {
    const discomfortOccurrences = substituted.filter(
      (o) => (o.substitutionReason ?? '').trim() === DISCOMFORT_REASON,
    );
    discomfort = {
      type: 'DISCOMFORT_PATTERN',
      originalExerciseId: group.exerciseId,
      originalExerciseName: group.exerciseName,
      windowSize: occ.length,
      occurrenceCount: discomfortCount,
      mostRecentAt: discomfortOccurrences[0]?.performedAt ?? mostRecentAt,
      alternatives: toAlternativesList(tallyAlternatives(discomfortOccurrences)),
      predominantReason: { text: DISCOMFORT_REASON, count: discomfortCount },
      auditSessionIds: discomfortOccurrences.map((o) => o.sessionId),
    };
  }

  return { recurring, discomfort };
}

/**
 * Marca `approvedByPersonal` nas alternativas cujo par (original, alternativa)
 * já foi cadastrado por ESTE personal em `exercise_replacement_alternatives`
 * (P2A). Uma query em lote para todos os insights — nunca uma por par.
 */
async function markApprovedAlternatives(personalId: number, insights: ExerciseInsight[]): Promise<void> {
  const originals: string[] = [];
  const alts: string[] = [];
  for (const ins of insights) {
    for (const alt of ins.alternatives) {
      originals.push(ins.originalExerciseId);
      alts.push(alt.exerciseId);
    }
  }
  if (!originals.length) return;

  const { rows } = await pool.query(
    `SELECT era.original_exercise_id, era.alternative_exercise_id
       FROM exercise_replacement_alternatives era
      WHERE era.personal_id = $1
        AND (era.original_exercise_id, era.alternative_exercise_id) IN (
          SELECT o, a FROM UNNEST($2::uuid[], $3::uuid[]) AS t(o, a)
        )`,
    [personalId, originals, alts],
  );
  const approved = new Set(
    rows.map((r) => `${(r as Record<string, unknown>).original_exercise_id}:${(r as Record<string, unknown>).alternative_exercise_id}`),
  );
  for (const ins of insights) {
    for (const alt of ins.alternatives) {
      if (approved.has(`${ins.originalExerciseId}:${alt.exerciseId}`)) alt.approvedByPersonal = true;
    }
  }
}

/** Prioridade final: DISCOMFORT_PATTERN sempre acima; dentro do tipo, recorrência desc, recência desc. */
function sortInsights(insights: ExerciseInsight[]): ExerciseInsight[] {
  const typeRank = (t: InsightType) => (t === 'DISCOMFORT_PATTERN' ? 0 : 1);
  return [...insights].sort((a, b) => {
    if (typeRank(a.type) !== typeRank(b.type)) return typeRank(a.type) - typeRank(b.type);
    if (a.occurrenceCount !== b.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    return b.mostRecentAt.localeCompare(a.mostRecentAt);
  });
}

export type ExerciseInsightsSummary = {
  recurrenceWindowDays: number;
  sessionsConsidered: number;
  insights: ExerciseInsight[];
};

export async function listExerciseInsightsForPersonal(
  personalId: number,
  studentId: number,
): Promise<ExerciseInsightsSummary> {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) throw assignmentError();

  const classification = await classifyExecutionForWindow(studentId, {
    windowDays: RECURRENCE_WINDOW_DAYS,
    sessionLimit: RECURRENCE_SESSION_CAP,
  });
  const groups = groupByExercise(classification.items);

  const all: ExerciseInsight[] = [];
  for (const group of groups.values()) {
    const { recurring, discomfort } = buildInsightsForGroup(group);
    if (discomfort) all.push(discomfort);
    if (recurring) all.push(recurring);
  }

  await markApprovedAlternatives(personalId, all);

  return {
    recurrenceWindowDays: RECURRENCE_WINDOW_DAYS,
    sessionsConsidered: classification.sessionsConsidered,
    insights: sortInsights(all).slice(0, MAX_INSIGHTS),
  };
}

export type ExerciseInsightDetail = {
  originalExerciseId: string;
  originalExerciseName: string;
  windowSize: number;
  /** As mesmas <= 5 ocorrências usadas no cálculo — o "por que apareceu" auditável. */
  occurrences: ExerciseExecution[];
  recurringReplacement: ExerciseInsight | null;
  discomfortPattern: ExerciseInsight | null;
};

/**
 * Drill-down de UM exercício (rota `GET .../exercise-insights/:exerciseId`).
 * Recalcula na hora — não depende do exercício ter entrado no TOP 5 da lista
 * (o Personal pode chegar aqui por outro caminho, ex. da própria ficha).
 * `null` quando o exercício não foi prescrito nenhuma vez na janela de
 * recorrência (nada a mostrar, não é erro).
 */
export async function getExerciseInsightDetail(
  personalId: number,
  studentId: number,
  exerciseId: string,
): Promise<ExerciseInsightDetail | null> {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) throw assignmentError();

  const classification = await classifyExecutionForWindow(studentId, {
    windowDays: RECURRENCE_WINDOW_DAYS,
    sessionLimit: RECURRENCE_SESSION_CAP,
  });
  const group = groupByExercise(classification.items).get(exerciseId);
  if (!group) return null;

  const { recurring, discomfort } = buildInsightsForGroup(group);
  const toMark = [recurring, discomfort].filter((x): x is ExerciseInsight => x !== null);
  if (toMark.length) await markApprovedAlternatives(personalId, toMark);

  return {
    originalExerciseId: group.exerciseId,
    originalExerciseName: group.exerciseName,
    windowSize: group.lastOccurrences.length,
    occurrences: group.lastOccurrences,
    recurringReplacement: recurring,
    discomfortPattern: discomfort,
  };
}
