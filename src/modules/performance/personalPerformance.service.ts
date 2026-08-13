/**
 * Visão do personal sobre a performance de um aluno (Spec 033, Onda P5).
 *
 * ## O contrato central: fato, sinal e síntese são coisas separadas
 *
 * O snapshot devolve três blocos que NUNCA se misturam:
 *
 * - **`facts`** — números calculados pelos engines das ondas P1–P4. Verificáveis,
 *   reproduzíveis, versionados.
 * - **`signals`** — leituras determinísticas sobre esses fatos, cada uma com a
 *   evidência anexada. Nenhum modelo de linguagem participa.
 * - **`aiSummary`** — texto, e só texto. Opcional, pode faltar, e a tela funciona
 *   inteira sem ele.
 *
 * Misturar os três seria o defeito clássico deste tipo de recurso: um número
 * gerado por modelo entra na tela com a mesma aparência de um número calculado,
 * e ninguém consegue mais dizer qual é qual. Aqui a fronteira é o próprio
 * formato da resposta.
 *
 * ## Nenhum engine novo
 *
 * Score, carga, consistência, recordes, progressão e metas vêm exatamente das
 * funções que o aluno já consome. Um segundo caminho de cálculo produziria dois
 * números para o mesmo aluno — o que ele vê no app e o que o personal vê no
 * cockpit — e a conversa entre os dois viraria uma discussão sobre qual tela
 * está certa.
 *
 * ## O gate que se aplica aqui é o do PERSONAL, não o do aluno
 *
 * `computePerformanceCore` é chamado sem passar pelo gate da feature
 * `performance`, que é o que o ALUNO comprou. A leitura do personal é autorizada
 * por outra coisa: vínculo ativo + consentimento do aluno + o plano do próprio
 * personal (a spec coloca o dashboard em qualquer plano e reserva só a IA ao
 * Pro). Aplicar o gate do aluno aqui esconderia do personal os dados de quem ele
 * treina só porque o aluno não assina o Premium.
 */
import logger from '../../lib/logger';
import { assertStudentAssignedToPersonal } from '../../services/personalWorkoutPlanService';
import { dayKey } from '../../utils/appDay';
import {
  SIGNAL_RULES,
  buildSignals,
  type PerformanceSignal,
} from './insights.engine';
import { startOfIsoWeek } from './goals.engine';
import { getGoalsForUserUnrestricted, type GoalDto } from './goals.service';
import {
  countActiveDaysBetween,
  loadKeyExerciseProgression,
  loadPrCounters,
  loadRecentPrEvents,
  loadScoreAsOf,
} from './performance.repository';
import { computePerformanceCore } from './performance.service';
import { SCORE_WINDOW_DAYS } from './performance.constants';

export class PersonalPerformanceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SnapshotFacts {
  /** `null` quando o aluno ainda não tem história para um número. */
  score: number | null;
  scoreStatus: 'onboarding' | 'ok' | 'unavailable';
  scoreTrend: 'up' | 'stable' | 'down' | null;
  scoreFactors: { id: string; label: string; delta: number }[];
  /** Versão da fórmula que produziu o score — histórico não se reinterpreta. */
  scoreFormulaVersion: number | null;
  consistency: {
    pct: number | null;
    activeDays28: number;
    activeDaysThisWeek: number;
    activeDaysLastWeek: number;
    targetPerWeek: number | null;
  };
  trainingLoad: {
    effortLoad7d: number | null;
    band: 'below' | 'within' | 'above' | 'spike' | null;
    label: string | null;
  };
  recentPrs: {
    exerciseName: string;
    /** `null` quando o exercício saiu do catálogo — o nome sobrevive. */
    exerciseId: string | null;
    kind: string;
    value: number;
    previousValue: number | null;
    achievedAt: string;
  }[];
  progressionHighlights: { total: number; improved: number; regressed: number };
  goals: GoalDto[];
  streakDays: number | null;
  sessions30d: number;
}

export interface PerformanceSnapshot {
  generatedAt: string;
  studentId: number;
  facts: SnapshotFacts;
  signals: PerformanceSignal[];
  /** Preenchido apenas pelo endpoint de IA. Nunca calculado aqui. */
  aiSummary: null;
  /** Identidade semântica dos fatos — base do cache da síntese. */
  snapshotHash: string;
}

/**
 * Hash do que o snapshot SIGNIFICA.
 *
 * Serve ao cache da síntese: se os fatos não mudaram, não há texto novo a gerar.
 * Por isso `generatedAt` fica de fora — incluí-lo faria o hash mudar a cada
 * chamada e o cache nunca acertaria, que é o modo mais silencioso de pagar por
 * um recurso que não funciona.
 *
 * Hash não-criptográfico de propósito: aqui ele identifica, não protege.
 */
export function hashSnapshot(facts: SnapshotFacts, signals: PerformanceSignal[]): string {
  const material = JSON.stringify({
    score: facts.score,
    trend: facts.scoreTrend,
    consistency: facts.consistency,
    load: facts.trainingLoad.band,
    prs: facts.recentPrs.map((p) => `${p.exerciseName}:${p.kind}:${p.value}`),
    progression: facts.progressionHighlights,
    goals: facts.goals.map((g) => `${g.id}:${g.status}:${g.progress}`),
    signals: signals.map((s) => `${s.type}:${JSON.stringify(s.evidence)}`),
  });

  let h = 2166136261;
  for (let i = 0; i < material.length; i += 1) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Confirma que este personal pode ler este aluno.
 *
 * O consentimento é verificado pelo middleware da rota; o VÍNCULO não é — o
 * `requireActiveConsent` do projeto checa autorização de dado, não relação.
 * Chamar as duas coisas é o que fecha a porta: sem isto, um personal com
 * consentimento de um aluno antigo (ou um id chutado) passaria pela primeira
 * barreira e encontraria a segunda aberta.
 */
async function assertCanRead(personalId: number, studentId: number): Promise<void> {
  if (!(await assertStudentAssignedToPersonal(personalId, studentId))) {
    throw new PersonalPerformanceError(
      'ASSIGNMENT_REQUIRED',
      403,
      'Este aluno não está na sua carteira.',
    );
  }
}

export async function getStudentPerformanceSnapshot(
  personalId: number,
  studentId: number,
): Promise<PerformanceSnapshot> {
  await assertCanRead(personalId, studentId);

  const hoje = dayKey();
  const inicioSemana = startOfIsoWeek(hoje);
  const fimSemanaPassada = new Date(new Date(`${inicioSemana}T12:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const inicioSemanaPassada = startOfIsoWeek(fimSemanaPassada);

  // Uma rodada de paralelismo: as sete leituras são independentes entre si.
  const [core, semanaAtual, semanaPassada, prCounters, prEvents, keyExercises, scoreAntes, goals] =
    await Promise.all([
      computePerformanceCore(studentId),
      countActiveDaysBetween(studentId, inicioSemana, hoje),
      countActiveDaysBetween(studentId, inicioSemanaPassada, fimSemanaPassada),
      loadPrCounters(studentId, SIGNAL_RULES.RECENT_WINDOW_DAYS, SIGNAL_RULES.STALL_DAYS),
      loadRecentPrEvents(studentId, 8, { sinceDays: SIGNAL_RULES.RECENT_WINDOW_DAYS }),
      loadKeyExerciseProgression(studentId, SCORE_WINDOW_DAYS),
      loadScoreAsOf(studentId, SCORE_WINDOW_DAYS),
      getGoalsForUserUnrestricted(studentId),
    ]);

  const facts: SnapshotFacts = {
    score: core.score?.value ?? null,
    scoreStatus: core.score ? core.score.status : 'unavailable',
    scoreTrend: core.score?.trend ?? null,
    scoreFactors: core.score?.factors ?? [],
    scoreFormulaVersion: core.score?.formulaVersion ?? null,
    consistency: {
      pct: core.consistencyPct,
      activeDays28: core.activeDays28,
      activeDaysThisWeek: semanaAtual,
      activeDaysLastWeek: semanaPassada,
      targetPerWeek: core.weeklyTarget,
    },
    trainingLoad: {
      effortLoad7d: core.load?.effortLoad7d ?? null,
      band: (core.load?.ratioBand as SnapshotFacts['trainingLoad']['band']) ?? null,
      label: core.load?.ratioLabel ?? null,
    },
    recentPrs: prEvents.map((e) => ({
      exerciseName: e.exerciseName,
      exerciseId: e.exerciseId,
      kind: e.kind,
      value: e.value,
      previousValue: e.previousValue,
      achievedAt: e.achievedAt,
    })),
    progressionHighlights: {
      total: keyExercises.total,
      improved: keyExercises.improved,
      regressed: keyExercises.regressed,
    },
    goals: goals.goals,
    streakDays: core.currentStreak,
    sessions30d: core.sessions30d,
  };

  const agora = Date.now();
  const signals = buildSignals({
    score: facts.score,
    scorePrevious: scoreAntes,
    loadBand: facts.trainingLoad.band,
    activeDaysThisWeek: semanaAtual,
    activeDaysLastWeek: semanaPassada,
    recentPrCount: prCounters.recentPrCount,
    daysSinceLastPr: prCounters.daysSinceLastPr,
    sessionsInStallWindow: prCounters.sessionsInStallWindow,
    keyExercises: { total: keyExercises.total, improved: keyExercises.improved },
    goalsAchievedRecently: goals.goals
      .filter((g) => g.status === 'achieved' && g.achievedAt)
      .map((g) => ({
        label: g.displayLabel,
        daysAgo: Math.floor((agora - new Date(g.achievedAt!).getTime()) / 86_400_000),
      }))
      .filter((g) => g.daysAgo <= SIGNAL_RULES.RECENT_WINDOW_DAYS && g.daysAgo >= 0),
    activeGoals: goals.goals
      .filter((g) => g.status === 'active')
      .map((g) => ({ label: g.displayLabel, progress: g.progress })),
  });

  logger.info(
    { personalId, studentId, signalCount: signals.length, hasScore: facts.score != null },
    '[performance] snapshot_generated',
  );

  return {
    generatedAt: new Date().toISOString(),
    studentId,
    facts,
    signals,
    aiSummary: null,
    snapshotHash: hashSnapshot(facts, signals),
  };
}
