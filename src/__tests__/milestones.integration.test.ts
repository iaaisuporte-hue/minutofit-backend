/**
 * Marcos com banco real (Spec 034, Onda C1).
 *
 * O que só o Postgres prova: o `UNIQUE(user_id, code)` sustenta o
 * reprocessamento, o XP sai do ledger uma vez só, o marco de um aluno não
 * aparece para outro, e a falha da avaliação não derruba o registro do treino.
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
jest.setTimeout(120_000);

const TAG = 'itest-c1';

describeWithDb('Marcos · determinísticos, idempotentes e privados', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
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

  let seq = 0;
  async function novoAluno(): Promise<number> {
    seq += 1;
    return createUser(c, TAG, `aluno-${seq}`);
  }

  /** Sessão executada crua — o caminho de fato usado pelos marcos. */
  async function gravarSessao(userId: number, performedAt: string): Promise<number> {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
       VALUES ($1, 'free', 'completed', $2::timestamptz, $2::timestamptz, 'Treino C1')
       RETURNING id`,
      [userId, performedAt],
    );
    return rows[0].id;
  }

  async function marcos(userId: number): Promise<string[]> {
    const { rows } = await c.query<{ code: string }>(
      `SELECT code FROM user_milestones WHERE user_id = $1 ORDER BY code`,
      [userId],
    );
    return rows.map((r) => r.code);
  }

  async function xpDeMarcos(userId: number) {
    const { rows } = await c.query<{ n: number; total: number }>(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::int total
         FROM xp_events WHERE user_id = $1 AND kind = 'milestone'`,
      [userId],
    );
    return { n: Number(rows[0].n), total: Number(rows[0].total) };
  }

  it('primeiro treino concede o marco, com evidência que aponta a sessão', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    const sessionId = await gravarSessao(userId, '2026-02-02T12:00:00Z');

    const awards = await evaluateMilestones(userId);
    expect(awards.map((a) => a.code)).toContain('first_workout');

    const { rows } = await c.query(
      `SELECT evidence_json, shared_at FROM user_milestones
        WHERE user_id = $1 AND code = 'first_workout'`,
      [userId],
    );
    expect(rows[0].evidence_json.sessionId).toBe(sessionId);
    // Privado por padrão: nasce sem data de compartilhamento.
    expect(rows[0].shared_at).toBeNull();
  });

  it('reprocessar dez vezes produz 1 marco, 1 evento de XP e nenhuma duplicata', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');

    for (let i = 0; i < 10; i += 1) await evaluateMilestones(userId);

    expect(await marcos(userId)).toEqual(['first_workout']);
    expect(await xpDeMarcos(userId)).toEqual({ n: 1, total: 10 });
  });

  it('duas avaliações simultâneas não duplicam marco nem XP', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');

    await Promise.all([
      evaluateMilestones(userId),
      evaluateMilestones(userId),
      evaluateMilestones(userId),
    ]);

    expect(await marcos(userId)).toEqual(['first_workout']);
    expect(await xpDeMarcos(userId)).toEqual({ n: 1, total: 10 });
  });

  it('o UNIQUE recusa a segunda concessão mesmo por INSERT direto', async () => {
    const userId = await novoAluno();
    await c.query(
      `INSERT INTO user_milestones (user_id, code, unlocked_at, evidence_json)
       VALUES ($1, 'first_workout', now(), '{}'::jsonb)`,
      [userId],
    );
    await expect(
      c.query(
        `INSERT INTO user_milestones (user_id, code, unlocked_at, evidence_json)
         VALUES ($1, 'first_workout', now(), '{}'::jsonb)`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('o primeiro registro de um exercício não conta como recorde', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Agachamento C1 ${seq}`);
    await gravarSessao(userId, '2026-02-02T12:00:00Z');

    // Linha de base: is_first = true. Não é conquista, é ponto de partida.
    await c.query(
      `INSERT INTO user_pr_events (user_id, exercise_id, exercise_name, kind, value, is_first, achieved_at)
       VALUES ($1, $2, 'Agachamento', 'max_load', 60, true, now())`,
      [userId, ex],
    );
    await evaluateMilestones(userId);
    expect(await marcos(userId)).not.toContain('first_pr');

    // Recorde real: superou o próprio número.
    await c.query(
      `INSERT INTO user_pr_events (user_id, exercise_id, exercise_name, kind, value, previous_value, is_first, achieved_at)
       VALUES ($1, $2, 'Agachamento', 'max_load', 70, 60, false, now())`,
      [userId, ex],
    );
    await evaluateMilestones(userId);
    expect(await marcos(userId)).toContain('first_pr');
  });

  it('o marco de um aluno não vaza para outro', async () => {
    const { evaluateMilestones, listMilestonesForUser } = await import(
      '../modules/community/milestones.service'
    );
    const a = await novoAluno();
    const b = await novoAluno();
    await gravarSessao(a, '2026-02-02T12:00:00Z');
    await evaluateMilestones(a);

    const deB = await listMilestonesForUser(b);
    expect(deB.every((m) => m.unlockedAt === null)).toBe(true);
    expect(await marcos(b)).toEqual([]);
  });

  it('PATCH de compartilhamento só afeta o próprio marco', async () => {
    const { evaluateMilestones, setMilestoneShared } = await import(
      '../modules/community/milestones.service'
    );
    const dono = await novoAluno();
    const outro = await novoAluno();
    await gravarSessao(dono, '2026-02-02T12:00:00Z');
    await evaluateMilestones(dono);

    // O dono compartilha o próprio marco.
    const atualizado = await setMilestoneShared(dono, 'first_workout', true);
    expect(atualizado?.shared).toBe(true);

    // O outro tenta o mesmo código e não encontra nada — não existe para ele.
    expect(await setMilestoneShared(outro, 'first_workout', true)).toBeNull();

    // E consegue voltar a privado.
    const revogado = await setMilestoneShared(dono, 'first_workout', false);
    expect(revogado?.shared).toBe(false);
  });

  it('código fora do catálogo não é aceito no PATCH', async () => {
    const { setMilestoneShared } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    expect(await setMilestoneShared(userId, 'marco_inventado', true)).toBeNull();
  });

  it('a leitura recupera o marco quando o hook pós-COMMIT falhou', async () => {
    // Simula a falha: a sessão existe no banco, mas nenhuma avaliação rodou.
    const { listMilestonesForUser } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');
    expect(await marcos(userId)).toEqual([]);

    const lista = await listMilestonesForUser(userId);
    expect(lista.find((m) => m.code === 'first_workout')?.unlockedAt).not.toBeNull();
    expect(await marcos(userId)).toEqual(['first_workout']);
  });

  it('falha na avaliação de marcos não derruba o registro do treino', async () => {
    const service = await import('../modules/community/milestones.service');
    const { createSession } = await import('../services/workoutSessionService');
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Remada C1 ${seq}`);

    const spy = jest
      .spyOn(service, 'evaluateMilestones')
      .mockRejectedValue(new Error('falha proposital'));

    try {
      const sessao = await createSession(userId, null, {
        source: 'free',
        status: 'completed',
        title: 'Treino com marco quebrado',
        planId: null,
        sets: [
          { exerciseId: ex, exerciseName: 'Remada', setIndex: 1, repsDone: 10, loadDoneKg: 30, status: 'done' },
        ],
        awardGamification: true,
      } as never);
      expect(sessao).toBeDefined();
    } finally {
      spy.mockRestore();
    }

    const { rows } = await c.query(
      `SELECT COUNT(*)::int n FROM workout_sessions WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('o treino real concede o marco pelo hook pós-COMMIT', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Supino C1 ${seq}`);

    const sessao = (await createSession(userId, null, {
      source: 'free',
      status: 'completed',
      title: 'Primeiro treino',
      planId: null,
      sets: [
        { exerciseId: ex, exerciseName: 'Supino', setIndex: 1, repsDone: 10, loadDoneKg: 40, status: 'done' },
      ],
      awardGamification: true,
    } as never)) as { milestonesUnlocked?: Array<{ code: string }> };

    expect(sessao.milestonesUnlocked?.map((m) => m.code)).toContain('first_workout');
    expect(await marcos(userId)).toContain('first_workout');
  });

  it('marco preso pelo teto diário é pago na avaliação seguinte', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const { dayKey } = await import('../utils/appDay');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');

    // Enche o teto do dia ANTES do marco existir.
    await c.query(
      `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
       VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await c.query(
      `INSERT INTO xp_events (user_id, kind, amount, event_key, awarded_on)
       VALUES ($1,'workout_session',30,$2,$3::date), ($1,'activity',20,$4,$3::date),
              ($1,'pr',10,$5,$3::date)`,
      [userId, `${TAG}-cap-w-${userId}`, dayKey(), `${TAG}-cap-a-${userId}`, `${TAG}-cap-p-${userId}`],
    );

    await evaluateMilestones(userId);
    expect(await marcos(userId)).toContain('first_workout');
    // O marco existe, mas o XP não coube: 0 pago hoje.
    expect((await xpDeMarcos(userId)).n).toBe(0);

    // Libera o teto (como faria o dia seguinte) e reavalia: agora paga.
    await c.query(`DELETE FROM xp_events WHERE user_id = $1 AND kind <> 'milestone'`, [userId]);
    await evaluateMilestones(userId);
    expect(await xpDeMarcos(userId)).toEqual({ n: 1, total: 10 });
  });

  it('o dia do marco é o do ALUNO — treino das 23h não vira o dia seguinte', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    // 02/02 23:00 BRT = 03/02 02:00 UTC. O marco carimba o instante do fato, e
    // o dia usado no ledger é o do aluno.
    await gravarSessao(userId, '2026-02-03T02:00:00Z');
    await evaluateMilestones(userId);

    const { rows } = await c.query(
      `SELECT (unlocked_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
         FROM user_milestones WHERE user_id = $1 AND code = 'first_workout'`,
      [userId],
    );
    expect(rows[0].dia).toBe('2026-02-02');
  });

  it('marco de dia vira meio-dia do fuso do ALUNO, não meia-noite UTC', async () => {
    // `'2026-02-10'::timestamptz` no Postgres é 09/02 21:00 em São Paulo: o
    // marco conquistado hoje apareceria carimbado ONTEM. Cinco dos sete marcos
    // nascem de um dia de calendário, então isto vale para a maioria deles.
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const { dayKey } = await import('../utils/appDay');
    const userId = await novoAluno();

    // 10 metas concluídas hoje, sem hora: o marco carimba o dia.
    const hoje = dayKey();
    for (let i = 0; i < 10; i += 1) {
      await c.query(
        `INSERT INTO user_performance_goals
           (user_id, kind, target_value, unit, status, starts_on, achieved_at, metric_version)
         VALUES ($1, 'weekly_frequency', $2, 'sessions', 'achieved', CURRENT_DATE, NOW(), 1)`,
        [userId, i + 1],
      );
    }
    await evaluateMilestones(userId);

    const { rows } = await c.query(
      `SELECT (unlocked_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
         FROM user_milestones WHERE user_id = $1 AND code = 'ten_goals'`,
      [userId],
    );
    expect(rows[0].dia).toBe(hoje);
  });

  it('vários marcos no mesmo dia: o teto adia, não corta pela metade', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const { dayKey } = await import('../utils/appDay');
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Levantamento C1 ${seq}`);

    await gravarSessao(userId, '2026-02-02T12:00:00Z');
    await c.query(
      `INSERT INTO user_pr_events (user_id, exercise_id, exercise_name, kind, value, previous_value, is_first, achieved_at)
       VALUES ($1, $2, 'Levantamento', 'max_load', 90, 80, false, now())`,
      [userId, ex],
    );
    for (let i = 0; i < 10; i += 1) {
      await c.query(
        `INSERT INTO user_performance_goals
           (user_id, kind, target_value, unit, status, starts_on, achieved_at, metric_version)
         VALUES ($1, 'weekly_frequency', $2, 'sessions', 'achieved', CURRENT_DATE, NOW(), 1)`,
        [userId, i + 1],
      );
    }

    // Deixa 25 de folga no teto: cabem 2 marcos de 10, nunca 2,5.
    await c.query(
      `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
       VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await c.query(
      `INSERT INTO xp_events (user_id, kind, amount, event_key, awarded_on)
       VALUES ($1, 'workout_session', 30, $2, $3::date), ($1, 'pr', 5, $4, $3::date)`,
      [userId, `${TAG}-multi-w-${userId}`, dayKey(), `${TAG}-multi-p-${userId}`],
    );

    await evaluateMilestones(userId);

    const marcosGanhos = await marcos(userId);
    expect(marcosGanhos.length).toBeGreaterThanOrEqual(3);

    const pago = await xpDeMarcos(userId);
    // Dois marcos inteiros (20), nunca um terceiro pela metade.
    expect(pago.total).toBe(20);
    expect(pago.n).toBe(2);
    expect(pago.total % 10).toBe(0);

    // No dia seguinte (teto liberado) os restantes são repescados.
    await c.query(`DELETE FROM xp_events WHERE user_id = $1 AND kind <> 'milestone'`, [userId]);
    await evaluateMilestones(userId);
    const depois = await xpDeMarcos(userId);
    expect(depois.n).toBe(marcosGanhos.length);
    expect(depois.total).toBe(marcosGanhos.length * 10);
  });

  it('a aba diz o que está indisponível em vez de prometer caminho que não há', async () => {
    // Aluno sem ficha nunca terá alvo semanal: exibir "quatro semanas
    // consistentes" com critério seria prometer algo inalcançável.
    const { listMilestonesForUser } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');

    const lista = await listMilestonesForUser(userId);
    const semanais = lista.filter((m) =>
      ['first_full_week', 'four_consistent_weeks', 'comeback'].includes(m.code),
    );
    expect(semanais).toHaveLength(3);
    for (const m of semanais) {
      expect(m.available).toBe(false);
      expect(m.unavailableReason).toMatch(/ficha/i);
    }
    // O desafio também: a tabela dele só nasce na C2.
    expect(lista.find((m) => m.code === 'challenge_completed')?.available).toBe(false);
    // E o que foi conquistado continua disponível.
    expect(lista.find((m) => m.code === 'first_workout')?.available).toBe(true);
  });

  it('exclusão de conta leva os marcos junto', async () => {
    const { evaluateMilestones } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();
    await gravarSessao(userId, '2026-02-02T12:00:00Z');
    await evaluateMilestones(userId);
    expect(await marcos(userId)).toHaveLength(1);

    await c.query('DELETE FROM users WHERE id = $1', [userId]);

    const { rows } = await c.query(
      `SELECT COUNT(*)::int n FROM user_milestones WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBe(0);
  });
});
