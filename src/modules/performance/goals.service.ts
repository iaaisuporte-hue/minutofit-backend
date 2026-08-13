/**
 * Metas de performance — orquestração (Spec 033, Onda P4).
 *
 * ## De onde vem cada número
 *
 * Nenhuma medição é inventada aqui, e nenhuma é digitada pelo aluno. Carga e
 * e1RM saem de `user_pr_events`, que já foi escrito pelo engine de recordes no
 * momento do treino — usar a mesma fonte garante que a meta e a aba Recordes
 * nunca discordem sobre qual é o melhor supino do aluno. Frequência sai da
 * mesma UNION de três fontes da aba Consistência. Streak sai da gamificação.
 *
 * Se a meta fosse medir por conta própria, o produto teria dois números com o
 * mesmo nome — que é exatamente o defeito que um QA anterior encontrou entre
 * "aderência" e "consistência".
 *
 * ## O que o aluno digita
 *
 * Só o ALVO (e o prazo, se quiser). O ponto de partida é medido pelo sistema.
 * Deixar o aluno declarar o baseline abriria a porta para uma meta que nasce a
 * 90% de progresso.
 */
import type { PoolClient } from 'pg';

import pool from '../../config/database';
import logger from '../../lib/logger';
import { dayKey } from '../../utils/appDay';
import {
  GOAL_METRIC_VERSION,
  MAX_ACTIVE_GOALS,
  computeGoalProgress,
  isExerciseKind,
  isGoalAlreadyMet,
  isMonotonicKind,
  progressTarget,
  progressUnit,
  startOfIsoWeek,
  startOfMonth,
  unitForKind,
  type GoalKind,
  type GoalStatus,
} from './goals.engine';
import {
  abandonGoal,
  countActiveGoals,
  expireOverdueGoals,
  getGoal,
  insertGoal,
  listGoals,
  loadActiveGoals,
  lockGoalEvaluation,
  markGoalAchieved,
  updateGoalBest,
  type GoalRow,
} from './goals.repository';
import {
  countActiveDaysBetween,
  loadBestRepsAtLoad,
  loadFreeSummaryCounters,
} from './performance.repository';
import { hasPerformanceFeature } from './performance.service';

export class GoalError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mede o estado atual de UMA meta.
 *
 * Meta órfã (exercício removido da biblioteca) não tem como ser medida: sem
 * `exercise_id` não há séries a consultar. Ela não vira erro nem some — devolve
 * `null` e a tela mostra o `best_value` que ficou gravado. O histórico do aluno
 * sobrevive à curadoria do catálogo.
 */
async function measureGoal(
  client: PoolClient | typeof pool,
  userId: number,
  goal: GoalRow,
  today: string,
): Promise<number | null> {
  switch (goal.kind) {
    case 'exercise_load':
    case 'exercise_e1rm': {
      if (!goal.exercise_id) return null;
      const kind = goal.kind === 'exercise_load' ? 'max_load' : 'best_e1rm';
      const { rows } = await client.query<{ best: string }>(
        `SELECT MAX(value) AS best FROM user_pr_events
          WHERE user_id = $1 AND exercise_id = $2::uuid AND kind = $3`,
        [userId, goal.exercise_id, kind],
      );
      return num(rows[0]?.best ?? null);
    }

    case 'exercise_reps_at_load': {
      if (!goal.exercise_id) return null;
      // O alvo de carga vira FILTRO: só séries que bateram a carga entram, e o
      // que se mede entre elas é a repetição. 35 kg × 8 não cumpre "30 kg × 12".
      return loadBestRepsAtLoad(userId, goal.exercise_id, Number(goal.target_value));
    }

    case 'weekly_frequency':
      return countActiveDaysBetween(userId, startOfIsoWeek(today), today);

    case 'monthly_frequency':
      return countActiveDaysBetween(userId, startOfMonth(today), today);

    case 'streak':
      // O streak sai da MESMA consulta consolidada do resumo Free. Uma query
      // avulsa só para ele foi removida na revisão da P1 (fan-out de conexões)
      // e há um teste que impede a volta dela — com razão: são dois números do
      // mesmo lugar, e vale mais uma viagem do que duas.
      return (await loadFreeSummaryCounters(userId, 30)).currentStreak;
  }
}

export interface GoalDto {
  id: string;
  kind: GoalKind;
  status: GoalStatus;
  exerciseId: string | null;
  exerciseName: string | null;
  /** Alvo bruto. Em `exercise_reps_at_load` é a CARGA; o alvo de reps vai à parte. */
  targetValue: number;
  targetReps: number | null;
  unit: string;
  /** Unidade do eixo do progresso — `reps` no tipo de dois alvos. */
  progressUnit: string;
  baselineValue: number | null;
  currentValue: number | null;
  /** 0..1, ou `null` quando não há medição. Nunca NaN. */
  progress: number | null;
  remaining: number | null;
  startsOn: string;
  dueOn: string | null;
  achievedAt: string | null;
  metricVersion: number;
  createdAt: string;
  /** O valor lido é o melhor histórico (monotônica) ou o do período (cíclica)? */
  monotonic: boolean;
}

async function toDto(
  client: PoolClient | typeof pool,
  userId: number,
  goal: GoalRow,
  today: string,
): Promise<GoalDto> {
  // Meta encerrada não é remedida: o número dela é o do dia em que encerrou.
  // Remedir mostraria "concluída" ao lado de um valor atual menor que o alvo.
  const measured = goal.status === 'active' ? await measureGoal(client, userId, goal, today) : null;

  const target = progressTarget(goal.kind, Number(goal.target_value), goal.target_reps);
  const stored = num(goal.best_value);
  const progress = computeGoalProgress({
    kind: goal.kind,
    baseline: num(goal.baseline_value),
    target,
    current: measured ?? (goal.status === 'active' ? null : stored),
    best: stored,
  });

  return {
    id: goal.id,
    kind: goal.kind,
    status: goal.status,
    exerciseId: goal.exercise_id,
    exerciseName: goal.exercise_name,
    targetValue: Number(goal.target_value),
    targetReps: goal.target_reps,
    unit: goal.unit,
    progressUnit: progressUnit(goal.kind),
    baselineValue: num(goal.baseline_value),
    currentValue: progress.displayValue,
    progress: progress.ratio,
    remaining: progress.remaining,
    startsOn: goal.starts_on,
    dueOn: goal.due_on,
    achievedAt: goal.achieved_at,
    metricVersion: goal.metric_version,
    createdAt: goal.created_at,
    monotonic: isMonotonicKind(goal.kind),
  };
}

export interface GoalsResponse {
  gated: boolean;
  goals: GoalDto[];
  activeCount: number;
  maxActive: number;
}

/**
 * Lista as metas do aluno.
 *
 * A expiração acontece aqui, na leitura, e não num cron: o único momento em que
 * "esta meta venceu" precisa ser verdade é quando alguém olha. Um job diário
 * custaria infraestrutura para adiantar em algumas horas um fato que a própria
 * consulta resolve — e ainda daria uma segunda fonte de verdade para o mesmo
 * estado.
 */
export async function getGoalsForUser(userId: number): Promise<GoalsResponse> {
  if (!(await hasPerformanceFeature(userId))) {
    return { gated: true, goals: [], activeCount: 0, maxActive: MAX_ACTIVE_GOALS };
  }

  const today = dayKey();
  await expireOverdueGoals(userId, today);

  const rows = await listGoals(userId);
  const goals = await Promise.all(rows.map((r) => toDto(pool, userId, r, today)));
  return {
    gated: false,
    goals,
    activeCount: goals.filter((g) => g.status === 'active').length,
    maxActive: MAX_ACTIVE_GOALS,
  };
}

export async function getGoalDetail(userId: number, goalId: string): Promise<GoalDto> {
  if (!(await hasPerformanceFeature(userId))) {
    throw new GoalError('PREMIUM_REQUIRED', 403, 'Metas fazem parte do plano Premium.');
  }
  const today = dayKey();
  await expireOverdueGoals(userId, today);

  const row = await getGoal(userId, goalId);
  // 404 e não 403 quando a meta é de outro usuário: responder "existe, mas não
  // é sua" já entrega a informação de que ela existe.
  if (!row) throw new GoalError('GOAL_NOT_FOUND', 404, 'Meta não encontrada.');
  return toDto(pool, userId, row, today);
}

export interface CreateGoalInput {
  kind: GoalKind;
  exerciseId?: string | null;
  targetValue: number;
  targetReps?: number | null;
  dueOn?: string | null;
}

/** Faixas de sanidade por tipo. Barram o dedo escorregado, não a ambição. */
const TARGET_RANGE: Record<GoalKind, { min: number; max: number }> = {
  exercise_load: { min: 1, max: 500 },
  exercise_e1rm: { min: 1, max: 600 },
  exercise_reps_at_load: { min: 1, max: 500 },
  weekly_frequency: { min: 1, max: 7 },
  monthly_frequency: { min: 1, max: 31 },
  streak: { min: 2, max: 365 },
};

export async function createGoal(userId: number, input: CreateGoalInput): Promise<GoalDto> {
  if (!(await hasPerformanceFeature(userId))) {
    throw new GoalError('PREMIUM_REQUIRED', 403, 'Metas fazem parte do plano Premium.');
  }

  const kind = input.kind;
  const range = TARGET_RANGE[kind];
  const target = Number(input.targetValue);
  if (!Number.isFinite(target) || target < range.min || target > range.max) {
    throw new GoalError('INVALID_TARGET', 400, `Alvo fora da faixa (${range.min}–${range.max}).`);
  }

  let exerciseId: string | null = null;
  let exerciseName: string | null = null;
  if (isExerciseKind(kind)) {
    if (!input.exerciseId) {
      throw new GoalError('EXERCISE_REQUIRED', 400, 'Escolha o exercício da meta.');
    }
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM exercises WHERE id = $1::uuid`,
      [input.exerciseId],
    );
    if (!rows[0]) throw new GoalError('EXERCISE_NOT_FOUND', 400, 'Exercício não encontrado.');
    exerciseId = rows[0].id;
    // O nome é copiado, não referenciado: é ele que mantém a meta legível
    // depois que o exercício sai do catálogo.
    exerciseName = rows[0].name;
  }

  let targetReps: number | null = null;
  if (kind === 'exercise_reps_at_load') {
    const reps = Number(input.targetReps);
    if (!Number.isInteger(reps) || reps < 1 || reps > 100) {
      throw new GoalError('INVALID_REPS', 400, 'Informe entre 1 e 100 repetições.');
    }
    targetReps = reps;
  }

  const today = dayKey();
  let dueOn: string | null = null;
  if (input.dueOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) {
      throw new GoalError('INVALID_DUE_DATE', 400, 'Data de prazo inválida.');
    }
    // Prazo no passado é meta nascida expirada. Hoje vale — quem quer fechar a
    // semana hoje tem o dia inteiro.
    if (input.dueOn < today) {
      throw new GoalError('INVALID_DUE_DATE', 400, 'O prazo precisa ser hoje ou uma data futura.');
    }
    dueOn = input.dueOn;
  }

  if ((await countActiveGoals(userId)) >= MAX_ACTIVE_GOALS) {
    throw new GoalError(
      'GOAL_LIMIT',
      422,
      `Você já tem ${MAX_ACTIVE_GOALS} metas ativas. Conclua ou abandone uma antes de criar outra.`,
    );
  }

  // Baseline medido AGORA, com a mesma função que medirá o progresso depois.
  // Usar dois caminhos diferentes para o mesmo número faria a meta nascer com
  // progresso não-zero por diferença de método.
  const probe: GoalRow = {
    id: '0',
    user_id: userId,
    kind,
    exercise_id: exerciseId,
    exercise_name: exerciseName,
    target_value: String(target),
    target_reps: targetReps,
    unit: unitForKind(kind),
    baseline_value: null,
    best_value: null,
    status: 'active',
    starts_on: today,
    due_on: dueOn,
    achieved_at: null,
    metric_version: GOAL_METRIC_VERSION,
    created_at: today,
    updated_at: today,
  };
  const baseline = await measureGoal(pool, userId, probe, today);

  const axis = progressTarget(kind, target, targetReps);
  if (isGoalAlreadyMet(baseline, axis)) {
    throw new GoalError(
      'GOAL_ALREADY_MET',
      422,
      'Você já está nesse patamar. Escolha um alvo acima do seu melhor atual.',
    );
  }

  try {
    const row = await insertGoal({
      userId,
      kind,
      exerciseId,
      exerciseName,
      targetValue: target,
      targetReps,
      unit: unitForKind(kind),
      baselineValue: baseline,
      startsOn: today,
      dueOn,
      metricVersion: GOAL_METRIC_VERSION,
    });
    return toDto(pool, userId, row, today);
  } catch (err) {
    // Índice único parcial: a mesma meta ativa duas vezes completaria duas
    // vezes e daria o bônus do score em dobro.
    if ((err as { code?: string }).code === '23505') {
      throw new GoalError('GOAL_DUPLICATE', 409, 'Você já tem essa meta em andamento.');
    }
    throw err;
  }
}

export async function abandonGoalForUser(userId: number, goalId: string): Promise<GoalDto> {
  if (!(await hasPerformanceFeature(userId))) {
    throw new GoalError('PREMIUM_REQUIRED', 403, 'Metas fazem parte do plano Premium.');
  }

  const row = await abandonGoal(userId, goalId);
  if (row) return toDto(pool, userId, row, dayKey());

  // Nada mudou: ou a meta não é deste usuário, ou já estava encerrada. As duas
  // respostas são diferentes de propósito.
  const existing = await getGoal(userId, goalId);
  if (!existing) throw new GoalError('GOAL_NOT_FOUND', 404, 'Meta não encontrada.');
  throw new GoalError('GOAL_NOT_ACTIVE', 409, 'Esta meta já foi encerrada.');
}

export interface GoalAchievement {
  id: string;
  kind: GoalKind;
  exerciseName: string | null;
  targetValue: number;
  targetReps: number | null;
  progressUnit: string;
}

/**
 * Avalia as metas do aluno depois de um treino.
 *
 * Roda FORA da transação da sessão, e essa é a ordem que importa: só depois do
 * COMMIT existem `workout_set_logs`, `workout_session_metrics` e os eventos de
 * recorde de que a medição depende. Avaliar antes leria o estado anterior ao
 * treino e concluiria que nada mudou — o aluno bateria 100 kg e a meta de 100
 * kg continuaria aberta até o treino seguinte.
 *
 * Falha aqui não derruba o registro do treino: a sessão já está gravada, e a
 * próxima leitura de `GET /goals` reavalia tudo. Metas são leitura derivada;
 * perder o treino por causa delas seria trocar o essencial pelo acessório.
 */
export async function evaluateGoalsAfterSession(
  userId: number,
  performedAt: Date,
): Promise<GoalAchievement[]> {
  const client = await pool.connect();
  const achievements: GoalAchievement[] = [];
  try {
    await client.query('BEGIN');
    await lockGoalEvaluation(client, userId);

    const today = dayKey();
    const goals = await loadActiveGoals(client, userId);

    for (const goal of goals) {
      const observed = await measureGoal(client, userId, goal, today);
      if (observed == null || !Number.isFinite(observed)) continue;

      const axis = progressTarget(goal.kind, Number(goal.target_value), goal.target_reps);

      if (observed >= axis) {
        // `markGoalAchieved` só afeta linha `active`: reprocessar a mesma
        // sessão devolve `false`, não toca em `achieved_at` e não repete o
        // evento. É aqui que mora a idempotência.
        const changed = await markGoalAchieved(client, goal.id, performedAt, observed);
        if (changed) {
          achievements.push({
            id: goal.id,
            kind: goal.kind,
            exerciseName: goal.exercise_name,
            targetValue: Number(goal.target_value),
            targetReps: goal.target_reps,
            progressUnit: progressUnit(goal.kind),
          });
        }
        continue;
      }

      // Só métricas monotônicas guardam o melhor. Numa meta semanal, gravar o
      // melhor faria a semana ruim herdar o número da semana boa.
      if (isMonotonicKind(goal.kind)) {
        const stored = num(goal.best_value);
        if (stored == null || observed > stored) {
          await updateGoalBest(client, goal.id, observed);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.warn({ err, userId }, '[performance] falha ao avaliar metas após sessão');
    return [];
  } finally {
    client.release();
  }

  if (achievements.length > 0) {
    logger.info(
      { userId, goalIds: achievements.map((a) => a.id), kinds: achievements.map((a) => a.kind) },
      '[performance] metas concluídas',
    );
  }
  return achievements;
}
