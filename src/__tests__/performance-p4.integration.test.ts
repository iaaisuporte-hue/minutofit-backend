/**
 * Metas de performance com banco real (Spec 033, Onda P4).
 *
 * O que só existe aqui, e não nos unitários: o fluxo inteiro
 * `sessão → séries → métricas → recorde → avaliação de meta`, e as garantias que
 * dependem do Postgres — idempotência do reprocessamento, corrida entre duas
 * sessões simultâneas, sobrevivência da meta à exclusão do exercício, cascata
 * na exclusão da conta.
 *
 * Como rodar:
 *   TEST_DATABASE_URL=postgresql://... npm test
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createUser,
  describeWithDb,
  hasTestDb,
  releaseSuiteLock,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(90_000);

const TAG = 'itest-p4';

describeWithDb('Performance P4 · Metas com banco real', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    // Precondição da suíte: o schema do módulo na versão corrente. Uma chamada,
    // sem saber quais migrations existem — o helper descobre. Sem isto, a ordem
    // das suítes passa a importar, e a que rodar depois de um round trip de
    // migration encontra a tabela na forma de outra onda.
    await restorePerformanceSchema(c);
    await cleanFixtures(c, TAG);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await releaseSuiteLock(c);
    await c.end();
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  async function grantPremium(userId: number): Promise<void> {
    const tier = await c.query(`SELECT id FROM subscription_tiers WHERE LOWER(name)='premium' LIMIT 1`);
    await c.query(
      `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
       VALUES ($1, $2, 'active', NOW())`,
      [userId, tier.rows[0].id],
    );
  }

  /**
   * Grava um recorde de carga direto no ledger.
   *
   * A medição de `exercise_load` lê `user_pr_events`, que é o mesmo lugar de
   * onde a aba Recordes lê — inserir aqui simula o que o engine de PR grava ao
   * fim de um treino, sem precisar de uma sessão completa a cada passo.
   *
   * `ON CONFLICT DO NOTHING` reproduz o comportamento real: o índice único da
   * P1 recusa o mesmo recorde duas vezes, e o engine de PR também não gravaria
   * um evento que não supera nada. É o que torna o caso de empate fiel.
   */
  async function recordLoad(userId: number, exerciseId: string, value: number): Promise<void> {
    await c.query(
      `INSERT INTO user_pr_events
         (user_id, exercise_id, exercise_name, kind, value, reps, load_kg, is_first, achieved_at, formula_version)
       VALUES ($1, $2::uuid, 'Supino', 'max_load', $3, 5, $3, false, NOW(), 1)
       ON CONFLICT DO NOTHING`,
      [userId, exerciseId, value],
    );
  }

  async function goalRow(id: string) {
    const { rows } = await c.query(
      `SELECT status, achieved_at, best_value::float8 AS best, baseline_value::float8 AS baseline
         FROM user_performance_goals WHERE id = $1::bigint`,
      [id],
    );
    return rows[0];
  }

  // ── Cenário determinístico ────────────────────────────────────────────────

  it('percorre baseline 70 → alvo 100 com o progresso esperado a cada passo', async () => {
    const { createGoal, getGoalDetail, evaluateGoalsAfterSession } =
      await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'percurso');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino percurso');

    await recordLoad(userId, ex, 70);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 100 });
    expect(goal.baselineValue).toBe(70);
    expect(goal.progress).toBe(0);
    expect(goal.remaining).toBe(30);

    // (valor observado, progresso esperado) — (x − 70) ÷ (100 − 70)
    const passos: [number, number][] = [
      [75, 0.167],
      [80, 0.333],
      [90, 0.667],
      [100, 1],
    ];

    for (const [carga, esperado] of passos) {
      await recordLoad(userId, ex, carga);
      await evaluateGoalsAfterSession(userId, new Date());
      const dto = await getGoalDetail(userId, goal.id);
      expect(dto.progress).toBe(esperado);
      expect(dto.currentValue).toBe(carga);
    }

    const concluida = await getGoalDetail(userId, goal.id);
    expect(concluida.status).toBe('achieved');
    expect(concluida.remaining).toBe(0);

    // 105 depois da conclusão não recria nada: a conquista tem uma data só.
    const antes = await goalRow(goal.id);
    await recordLoad(userId, ex, 105);
    const novas = await evaluateGoalsAfterSession(userId, new Date(Date.now() + 60_000));
    expect(novas).toHaveLength(0);
    const depois = await goalRow(goal.id);
    expect(depois.achieved_at).toEqual(antes.achieved_at);
    expect(depois.status).toBe('achieved');
  });

  it('empate não move nada — 90 seguido de 90 não gera conquista nem novo melhor', async () => {
    const { createGoal, evaluateGoalsAfterSession } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'empate');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino empate');
    await recordLoad(userId, ex, 70);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 100 });
    await recordLoad(userId, ex, 90);
    await evaluateGoalsAfterSession(userId, new Date());
    const primeiro = await goalRow(goal.id);

    await recordLoad(userId, ex, 90);
    const conquistas = await evaluateGoalsAfterSession(userId, new Date());

    expect(conquistas).toHaveLength(0);
    const segundo = await goalRow(goal.id);
    expect(segundo.best).toBe(primeiro.best);
    expect(segundo.status).toBe('active');
  });

  it('regressão preserva baseline e melhor: treino leve não desfaz o pesado', async () => {
    const { createGoal, getGoalDetail, evaluateGoalsAfterSession } =
      await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'regressao');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino regressao');
    await recordLoad(userId, ex, 70);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 100 });
    await recordLoad(userId, ex, 90);
    await evaluateGoalsAfterSession(userId, new Date());

    // Uma sessão leve não vira evento de recorde, então o melhor não muda —
    // e é exatamente esse o comportamento que se quer provar.
    await evaluateGoalsAfterSession(userId, new Date());

    const dto = await getGoalDetail(userId, goal.id);
    expect(dto.baselineValue).toBe(70);
    expect(dto.currentValue).toBe(90);
    expect(dto.progress).toBe(0.667);
  });

  // ── Fluxo completo pelo registro de treino ────────────────────────────────

  it('sessão real conclui a meta: séries → métricas → recorde → meta', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const { createGoal, getGoalDetail } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'fluxo');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Agachamento fluxo');
    await recordLoad(userId, ex, 60);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 80 });
    expect(goal.status).toBe('active');

    const res = await createSession(userId, null, {
      source: 'free',
      status: 'completed',
      title: 'Treino de pernas',
      sets: [
        { exerciseId: ex, exerciseName: 'Agachamento fluxo', setIndex: 1, repsDone: 5, loadDoneKg: 80, status: 'done' },
      ],
      awardGamification: true,
    } as never);

    expect((res as { goalsAchieved: unknown[] }).goalsAchieved).toHaveLength(1);

    const dto = await getGoalDetail(userId, goal.id);
    expect(dto.status).toBe('achieved');
    expect(dto.achievedAt).not.toBeNull();

    // A métrica da sessão existe: a meta não passou à frente da fundação.
    const metrics = await c.query(
      `SELECT 1 FROM workout_session_metrics WHERE session_id = $1`,
      [(res as { id: number }).id],
    );
    expect(metrics.rowCount).toBe(1);
  });

  it('reprocessar a mesma avaliação é idempotente', async () => {
    const { createGoal, evaluateGoalsAfterSession } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'idem');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino idem');
    await recordLoad(userId, ex, 50);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 60 });
    await recordLoad(userId, ex, 60);

    const quando = new Date();
    const primeira = await evaluateGoalsAfterSession(userId, quando);
    const depoisDaPrimeira = await goalRow(goal.id);
    const segunda = await evaluateGoalsAfterSession(userId, new Date(Date.now() + 3_600_000));

    expect(primeira).toHaveLength(1);
    expect(segunda).toHaveLength(0);
    expect((await goalRow(goal.id)).achieved_at).toEqual(depoisDaPrimeira.achieved_at);
  });

  it('duas sessões simultâneas concluem a meta uma única vez', async () => {
    const { createGoal, evaluateGoalsAfterSession } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'corrida');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino corrida');
    await recordLoad(userId, ex, 50);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 60 });
    await recordLoad(userId, ex, 60);

    const [a, b] = await Promise.all([
      evaluateGoalsAfterSession(userId, new Date()),
      evaluateGoalsAfterSession(userId, new Date(Date.now() + 1_000)),
    ]);

    // Exatamente uma das duas avaliações reivindica a conquista.
    expect(a.length + b.length).toBe(1);
    const { rows } = await c.query(
      `SELECT COUNT(*)::int AS n FROM user_performance_goals
        WHERE id = $1::bigint AND status = 'achieved' AND achieved_at IS NOT NULL`,
      [goal.id],
    );
    expect(rows[0].n).toBe(1);
  });

  // ── Meta de dois alvos ────────────────────────────────────────────────────

  it('"30 kg × 12 reps" não é cumprida por 35 kg × 8', async () => {
    const { createGoal, getGoalDetail, evaluateGoalsAfterSession } =
      await import('../modules/performance/goals.service');
    const { createSession } = await import('../services/workoutSessionService');

    const userId = await createUser(c, TAG, 'repsload');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Rosca direta');

    const goal = await createGoal(userId, {
      kind: 'exercise_reps_at_load',
      exerciseId: ex,
      targetValue: 30,
      targetReps: 12,
    });
    expect(goal.progressUnit).toBe('reps');

    await createSession(userId, null, {
      source: 'free',
      status: 'completed',
      sets: [
        { exerciseId: ex, exerciseName: 'Rosca direta', setIndex: 1, repsDone: 8, loadDoneKg: 35, status: 'done' },
      ],
    } as never);

    const parcial = await getGoalDetail(userId, goal.id);
    expect(parcial.status).toBe('active');
    expect(parcial.currentValue).toBe(8);

    // Agora sim: a carga pedida COM as repetições pedidas.
    await createSession(userId, null, {
      source: 'free',
      status: 'completed',
      sets: [
        { exerciseId: ex, exerciseName: 'Rosca direta', setIndex: 1, repsDone: 12, loadDoneKg: 30, status: 'done' },
      ],
    } as never);
    await evaluateGoalsAfterSession(userId, new Date());

    expect((await getGoalDetail(userId, goal.id)).status).toBe('achieved');
  });

  // ── Frequência: mesma definição de dia ativo da aba Consistência ──────────

  it('meta semanal conta presença registrada pelo personal, como o calendário', async () => {
    const { createGoal, getGoalDetail } = await import('../modules/performance/goals.service');
    const { dayKey } = await import('../utils/appDay');
    const { startOfIsoWeek } = await import('../modules/performance/goals.engine');

    const userId = await createUser(c, TAG, 'semanal');
    const personalId = await createUser(c, TAG, 'personal-semanal');
    await grantPremium(userId);

    const goal = await createGoal(userId, { kind: 'weekly_frequency', targetValue: 3 });
    expect(goal.baselineValue).toBe(0);

    // Um dia dentro da semana corrente, vindo só do log do personal.
    const inicio = startOfIsoWeek(dayKey());
    await c.query(
      `INSERT INTO personal_session_logs (personal_id, student_id, status, session_at)
       VALUES ($1, $2, 'present', ($3::date + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo')`,
      [personalId, userId, inicio],
    );

    const dto = await getGoalDetail(userId, goal.id);
    expect(dto.currentValue).toBe(1);
    expect(dto.progress).toBe(0.333);
  });

  // ── Exercício removido ────────────────────────────────────────────────────

  it('excluir o exercício não apaga nem quebra a meta', async () => {
    const { createGoal, getGoalDetail, getGoalsForUser } =
      await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'orfa');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Remada que some');
    await recordLoad(userId, ex, 40);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 60 });

    // O DELETE precisa PASSAR — era isto que o CHECK da P1 impedia.
    await expect(c.query(`DELETE FROM exercises WHERE id = $1::uuid`, [ex])).resolves.toBeDefined();

    const dto = await getGoalDetail(userId, goal.id);
    expect(dto.exerciseId).toBeNull();
    expect(dto.exerciseName).toBe('Remada que some');
    expect(dto.status).toBe('active');

    const lista = await getGoalsForUser(userId);
    expect(lista.goals.some((g) => g.id === goal.id)).toBe(true);
  });

  // ── Autorização e gating ──────────────────────────────────────────────────

  it('meta de outro usuário responde 404, não 403', async () => {
    const { createGoal, getGoalDetail, abandonGoalForUser } =
      await import('../modules/performance/goals.service');

    const dono = await createUser(c, TAG, 'dono');
    const intruso = await createUser(c, TAG, 'intruso');
    await grantPremium(dono);
    await grantPremium(intruso);

    const goal = await createGoal(dono, { kind: 'weekly_frequency', targetValue: 4 });

    await expect(getGoalDetail(intruso, goal.id)).rejects.toMatchObject({ status: 404 });
    await expect(abandonGoalForUser(intruso, goal.id)).rejects.toMatchObject({ status: 404 });

    // E a meta do dono continua intacta depois da tentativa.
    expect((await goalRow(goal.id)).status).toBe('active');
  });

  it('sem Premium o backend recusa — esconder o botão não é proteção', async () => {
    const { createGoal, getGoalsForUser } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'free');
    const lista = await getGoalsForUser(userId);
    expect(lista.gated).toBe(true);
    expect(lista.goals).toHaveLength(0);

    await expect(
      createGoal(userId, { kind: 'weekly_frequency', targetValue: 3 }),
    ).rejects.toMatchObject({ code: 'PREMIUM_REQUIRED', status: 403 });
  });

  // ── Regras de criação ─────────────────────────────────────────────────────

  it('recusa meta que já nasceria cumprida', async () => {
    const { createGoal } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'jaatingida');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino forte');
    await recordLoad(userId, ex, 105);

    await expect(
      createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 100 }),
    ).rejects.toMatchObject({ code: 'GOAL_ALREADY_MET', status: 422 });
  });

  it('recusa a sexta meta ativa, e a duplicata da mesma meta', async () => {
    const { createGoal, abandonGoalForUser } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'limite');
    await grantPremium(userId);

    const criadas: { id: string }[] = [];
    for (const alvo of [2, 3, 4, 5, 6]) {
      criadas.push(await createGoal(userId, { kind: 'weekly_frequency', targetValue: alvo }));
    }
    await expect(
      createGoal(userId, { kind: 'weekly_frequency', targetValue: 7 }),
    ).rejects.toMatchObject({ code: 'GOAL_LIMIT', status: 422 });

    // Abrindo espaço, a duplicata de uma meta ativa continua barrada.
    await abandonGoalForUser(userId, criadas[0].id);
    await expect(
      createGoal(userId, { kind: 'weekly_frequency', targetValue: 3 }),
    ).rejects.toMatchObject({ code: 'GOAL_DUPLICATE', status: 409 });
  });

  it('valida entrada: tipo de exercício sem exercício, alvo fora de faixa, prazo no passado', async () => {
    const { createGoal } = await import('../modules/performance/goals.service');
    const { dayKey } = await import('../utils/appDay');

    const userId = await createUser(c, TAG, 'validacao');
    await grantPremium(userId);

    await expect(
      createGoal(userId, { kind: 'exercise_load', targetValue: 100 }),
    ).rejects.toMatchObject({ code: 'EXERCISE_REQUIRED' });

    await expect(
      createGoal(userId, {
        kind: 'exercise_load',
        exerciseId: '00000000-0000-4000-8000-000000000000',
        targetValue: 100,
      }),
    ).rejects.toMatchObject({ code: 'EXERCISE_NOT_FOUND' });

    await expect(
      createGoal(userId, { kind: 'weekly_frequency', targetValue: 99 }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });

    const ontem = new Date(Date.now() - 86_400_000);
    await expect(
      createGoal(userId, { kind: 'weekly_frequency', targetValue: 3, dueOn: dayKey(ontem) }),
    ).rejects.toMatchObject({ code: 'INVALID_DUE_DATE' });
  });

  // ── Prazo e cancelamento ──────────────────────────────────────────────────

  it('a meta que vence hoje sobrevive ao dia; a de ontem expira na leitura', async () => {
    const { createGoal, getGoalsForUser } = await import('../modules/performance/goals.service');
    const { dayKey } = await import('../utils/appDay');

    const userId = await createUser(c, TAG, 'prazo');
    await grantPremium(userId);

    const hoje = await createGoal(userId, { kind: 'weekly_frequency', targetValue: 3, dueOn: dayKey() });
    const vencida = await createGoal(userId, { kind: 'monthly_frequency', targetValue: 10 });
    // Vence ontem: o caminho legítimo (criação) recusa data passada, então o
    // envelhecimento é feito no banco — é o que o tempo faria sozinho.
    await c.query(
      `UPDATE user_performance_goals SET due_on = CURRENT_DATE - 1 WHERE id = $1::bigint`,
      [vencida.id],
    );

    const lista = await getGoalsForUser(userId);
    expect(lista.goals.find((g) => g.id === hoje.id)!.status).toBe('active');
    expect(lista.goals.find((g) => g.id === vencida.id)!.status).toBe('expired');
  });

  it('meta abandonada não é concluída por treino posterior', async () => {
    const { createGoal, abandonGoalForUser, evaluateGoalsAfterSession, getGoalDetail } =
      await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'abandono');
    await grantPremium(userId);
    const ex = await createExercise(c, TAG, 'Supino abandono');
    await recordLoad(userId, ex, 50);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 60 });
    const abandonada = await abandonGoalForUser(userId, goal.id);
    expect(abandonada.status).toBe('abandoned');

    await recordLoad(userId, ex, 80);
    const conquistas = await evaluateGoalsAfterSession(userId, new Date());

    expect(conquistas).toHaveLength(0);
    const dto = await getGoalDetail(userId, goal.id);
    expect(dto.status).toBe('abandoned');
    expect(dto.achievedAt).toBeNull();

    // Abandonar de novo não é sucesso silencioso.
    await expect(abandonGoalForUser(userId, goal.id)).rejects.toMatchObject({ status: 409 });
  });

  // ── Score e LGPD ──────────────────────────────────────────────────────────

  it('meta concluída aparece como fator do Progress Score', async () => {
    const { createGoal, evaluateGoalsAfterSession } = await import('../modules/performance/goals.service');
    const { getPerformanceOverview } = await import('../modules/performance/performance.service');

    const userId = await createUser(c, TAG, 'score');
    await grantPremium(userId);
    await c.query(`UPDATE users SET created_at = NOW() - INTERVAL '120 days' WHERE id = $1`, [userId]);
    const ex = await createExercise(c, TAG, 'Supino score');
    await recordLoad(userId, ex, 50);

    const goal = await createGoal(userId, { kind: 'exercise_load', exerciseId: ex, targetValue: 60 });
    await recordLoad(userId, ex, 60);
    await evaluateGoalsAfterSession(userId, new Date());
    expect((await goalRow(goal.id)).status).toBe('achieved');

    // Seis sessões nos últimos 60 dias tiram a conta do onboarding do score.
    // Com a MÉTRICA junto: o score conta `workout_session_metrics`, não sessões
    // cruas — é o satélite da P1 que define "sessão executada" para ele.
    for (let i = 1; i <= 6; i += 1) {
      const { rows } = await c.query(
        `INSERT INTO workout_sessions (user_id, status, source, started_at, performed_at)
         VALUES ($1, 'completed', 'free', NOW() - ($2 || ' days')::interval, NOW() - ($2 || ' days')::interval)
         RETURNING id, performed_at`,
        [userId, i * 3],
      );
      await c.query(
        `INSERT INTO workout_session_metrics
           (session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg, formula_version)
         VALUES ($1, $2, $3, 4, 40, 1000, 1)`,
        [rows[0].id, userId, rows[0].performed_at],
      );
    }

    const overview = await getPerformanceOverview(userId);
    expect(overview.score?.factors.some((f) => f.id === 'goal.achieved')).toBe(true);
  });

  it('excluir a conta leva as metas junto', async () => {
    const { createGoal } = await import('../modules/performance/goals.service');

    const userId = await createUser(c, TAG, 'lgpd');
    await grantPremium(userId);
    const goal = await createGoal(userId, { kind: 'weekly_frequency', targetValue: 3 });

    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const { rows } = await c.query(
      `SELECT COUNT(*)::int AS n FROM user_performance_goals WHERE id = $1::bigint`,
      [goal.id],
    );
    expect(rows[0].n).toBe(0);
  });
});
