/**
 * Persistência das metas de performance (Spec 033, Onda P4).
 *
 * Toda função aqui recebe `userId` e o usa no WHERE — não existe leitura ou
 * escrita de meta que dispense o dono. Um `getGoal(id)` sem usuário viraria,
 * uma refatoração depois, o buraco por onde alguém lê a meta do vizinho
 * trocando o número na URL.
 */
import type { PoolClient } from 'pg';

import pool from '../../config/database';
import type { GoalKind, GoalStatus } from './goals.engine';

export interface GoalRow {
  id: string;
  user_id: number;
  kind: GoalKind;
  exercise_id: string | null;
  exercise_name: string | null;
  target_value: string;
  target_reps: number | null;
  unit: string;
  baseline_value: string | null;
  best_value: string | null;
  status: GoalStatus;
  starts_on: string;
  due_on: string | null;
  achieved_at: string | null;
  metric_version: number;
  created_at: string;
  updated_at: string;
}

/**
 * `starts_on` e `due_on` chegam como DATE. O driver converteria para `Date` no
 * fuso do processo — e uma meta que vence dia 31 viraria dia 30 num servidor a
 * oeste. O `::text` mantém `YYYY-MM-DD`, que é a forma em que o resto do módulo
 * compara dias.
 */
const COLUMNS = `
  id::text, user_id, kind, exercise_id::text, exercise_name,
  target_value::text, target_reps, unit,
  baseline_value::text, best_value::text,
  status, starts_on::text, due_on::text, achieved_at, metric_version,
  created_at, updated_at`;

export async function listGoals(userId: number): Promise<GoalRow[]> {
  const { rows } = await pool.query<GoalRow>(
    `SELECT ${COLUMNS}
       FROM user_performance_goals
      WHERE user_id = $1
      ORDER BY (status = 'active') DESC, created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

export async function getGoal(userId: number, goalId: string): Promise<GoalRow | null> {
  const { rows } = await pool.query<GoalRow>(
    `SELECT ${COLUMNS} FROM user_performance_goals WHERE user_id = $1 AND id = $2::bigint`,
    [userId, goalId],
  );
  return rows[0] ?? null;
}

export async function countActiveGoals(userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_performance_goals
      WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export interface InsertGoalInput {
  userId: number;
  kind: GoalKind;
  exerciseId: string | null;
  exerciseName: string | null;
  targetValue: number;
  targetReps: number | null;
  unit: string;
  baselineValue: number | null;
  startsOn: string;
  dueOn: string | null;
  metricVersion: number;
}

export async function insertGoal(input: InsertGoalInput): Promise<GoalRow> {
  const { rows } = await pool.query<GoalRow>(
    `INSERT INTO user_performance_goals
       (user_id, kind, exercise_id, exercise_name, target_value, target_reps, unit,
        baseline_value, best_value, status, starts_on, due_on, metric_version)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $8, 'active', $9::date, $10::date, $11)
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      input.kind,
      input.exerciseId,
      input.exerciseName,
      input.targetValue,
      input.targetReps,
      input.unit,
      input.baselineValue,
      input.startsOn,
      input.dueOn,
      input.metricVersion,
    ],
  );
  return rows[0];
}

/**
 * Abandona a meta.
 *
 * O WHERE exige `status = 'active'`: reenviar o cancelamento de uma meta já
 * concluída não pode reescrever o desfecho dela. O retorno `null` diz ao
 * service que nada mudou, e ele responde 409 em vez de fingir sucesso.
 */
export async function abandonGoal(userId: number, goalId: string): Promise<GoalRow | null> {
  const { rows } = await pool.query<GoalRow>(
    `UPDATE user_performance_goals
        SET status = 'abandoned', updated_at = now()
      WHERE user_id = $1 AND id = $2::bigint AND status = 'active'
      RETURNING ${COLUMNS}`,
    [userId, goalId],
  );
  return rows[0] ?? null;
}

/**
 * Expira metas vencidas na leitura, sem cron.
 *
 * `due_on < hoje` — a meta que vence HOJE ainda está viva o dia inteiro. Quem
 * se propôs a chegar a 100 kg até o dia 31 tem o dia 31; expirar às 00h01 seria
 * cobrar um prazo que o aluno leu como inclusivo.
 */
export async function expireOverdueGoals(userId: number, today: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE user_performance_goals
        SET status = 'expired', updated_at = now()
      WHERE user_id = $1 AND status = 'active' AND due_on IS NOT NULL AND due_on < $2::date`,
    [userId, today],
  );
  return rowCount ?? 0;
}

/** Metas ativas — a lista que a avaliação pós-treino percorre. */
export async function loadActiveGoals(
  client: PoolClient | typeof pool,
  userId: number,
): Promise<GoalRow[]> {
  const { rows } = await client.query<GoalRow>(
    `SELECT ${COLUMNS} FROM user_performance_goals
      WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows;
}

/**
 * Serializa a avaliação de metas de UM usuário.
 *
 * Duas sessões terminando ao mesmo tempo — o aluno registra num aparelho
 * enquanto o personal registra no dele — leriam ambas a meta como `active` e
 * ambas gravariam a conclusão, com dois `achieved_at` diferentes disputando a
 * mesma linha. O lock é transacional (liberado no COMMIT/ROLLBACK) e a chave é
 * derivada do usuário, então alunos diferentes nunca esperam uns pelos outros.
 *
 * O `2` do primeiro argumento separa este espaço de chaves do usado pela
 * detecção de recordes: metas e PRs de um mesmo aluno podem avaliar em
 * paralelo sem se bloquear.
 */
export async function lockGoalEvaluation(client: PoolClient, userId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [2, userId]);
}

/**
 * Grava o melhor valor observado.
 *
 * `GREATEST` com COALESCE no banco, e não comparação em TypeScript: o valor
 * lido pode ter envelhecido entre o SELECT e o UPDATE, e deixar o Postgres
 * decidir elimina a corrida sem uma segunda leitura.
 */
export async function updateGoalBest(
  client: PoolClient,
  goalId: string,
  observed: number,
): Promise<void> {
  await client.query(
    `UPDATE user_performance_goals
        SET best_value = GREATEST(COALESCE(best_value, $2::numeric), $2::numeric),
            updated_at = now()
      WHERE id = $1::bigint AND status = 'active'`,
    [goalId, observed],
  );
}

/**
 * Conclui a meta.
 *
 * `AND status = 'active'` é o que torna a operação idempotente: reprocessar a
 * mesma sessão encontra a meta já `achieved`, não atualiza linha nenhuma e
 * devolve `false` — sem tocar em `achieved_at` e sem emitir um segundo evento.
 * `achievedAt` vem de fora (é o `performed_at` da sessão) porque a conquista
 * pertence ao dia do TREINO, não ao dia do processamento.
 */
export async function markGoalAchieved(
  client: PoolClient,
  goalId: string,
  achievedAt: Date,
  observed: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE user_performance_goals
        SET status = 'achieved',
            achieved_at = $2,
            best_value = GREATEST(COALESCE(best_value, $3::numeric), $3::numeric),
            updated_at = now()
      WHERE id = $1::bigint AND status = 'active'`,
    [goalId, achievedAt, observed],
  );
  return (rowCount ?? 0) > 0;
}

/** Metas concluídas numa janela — alimenta o fator `goal.achieved` do score. */
export async function countGoalsAchievedSince(
  userId: number,
  sinceDays: number,
): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_performance_goals
      WHERE user_id = $1 AND status = 'achieved'
        AND achieved_at >= now() - ($2::int * INTERVAL '1 day')`,
    [userId, sinceDays],
  );
  return rows[0]?.n ?? 0;
}
