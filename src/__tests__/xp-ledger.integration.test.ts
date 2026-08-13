/**
 * Ledger de XP com banco real (Spec 034, Onda C0).
 *
 * O que só o Postgres prova: a idempotência mora no UNIQUE de `event_key`, o
 * cap sobrevive a concorrência, e o replay de sessão — que a Spec 033 já
 * deduplica no treino — não vira recompensa dupla na moeda.
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

const TAG = 'itest-c0';

describeWithDb('XP · o ledger fecha a moeda no servidor', () => {
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

  /** Roda `awardXpTx` numa transação própria, como os chamadores reais fazem. */
  async function award(userId: number, kind: string, eventKey: string, dateKey: string) {
    const pool = (await import('../config/database')).default;
    const { awardXpTx } = await import('../services/xpLedgerService');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
         VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const amount = await awardXpTx(client, {
        userId,
        kind: kind as never,
        eventKey,
        dateKey,
      });
      await client.query('COMMIT');
      return amount;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const DIA = '2026-08-13';

  it('o mesmo fato pago uma vez só — o UNIQUE decide, não o código', async () => {
    const userId = await novoAluno();

    expect(await award(userId, 'pr', `${TAG}-pr-a-${userId}`, DIA)).toBe(15);
    expect(await award(userId, 'pr', `${TAG}-pr-a-${userId}`, DIA)).toBe(0);

    const { rows } = await c.query(
      `SELECT COUNT(*)::int n FROM xp_events WHERE event_key = $1`,
      [`${TAG}-pr-a-${userId}`],
    );
    expect(rows[0].n).toBe(1);
  });

  it('o teto diário corta o excedente e depois satura', async () => {
    const userId = await novoAluno();

    // 30 + 20 = 50; o recorde de 15 só cabe pela metade; o segundo não cabe.
    expect(await award(userId, 'workout_session', `${TAG}-w-${userId}`, DIA)).toBe(30);
    expect(await award(userId, 'activity', `${TAG}-a-${userId}`, DIA)).toBe(20);
    expect(await award(userId, 'pr', `${TAG}-p1-${userId}`, DIA)).toBe(10);
    expect(await award(userId, 'pr', `${TAG}-p2-${userId}`, DIA)).toBe(0);

    const { rows } = await c.query(
      `SELECT COALESCE(SUM(amount),0)::int total FROM xp_events
        WHERE user_id = $1 AND awarded_on = $2::date`,
      [userId, DIA],
    );
    expect(rows[0].total).toBe(60);
  });

  it('o teto é por dia do ALUNO: amanhã a moeda volta', async () => {
    const userId = await novoAluno();
    expect(await award(userId, 'workout_session', `${TAG}-d1-${userId}`, DIA)).toBe(30);
    expect(await award(userId, 'workout_session', `${TAG}-d2-${userId}`, '2026-08-14')).toBe(30);
  });

  it('duas concessões simultâneas não estouram o cap', async () => {
    const userId = await novoAluno();

    // Duas transações concorrentes de 30 num teto de 60 com perDay=1: uma paga,
    // a outra encontra o tipo saturado. O FOR UPDATE serializa.
    const [a, b] = await Promise.all([
      award(userId, 'workout_session', `${TAG}-race-a-${userId}`, DIA),
      award(userId, 'workout_session', `${TAG}-race-b-${userId}`, DIA),
    ]);
    expect([a, b].sort()).toEqual([0, 30]);
  });

  it('replay de sessão não paga duas vezes — ponta a ponta pelo createSession', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Supino C0 ${seq}`);

    const input = {
      source: 'free',
      status: 'completed',
      title: 'Treino C0',
      planId: null,
      sets: [{ exerciseId: ex, exerciseName: 'Supino C0', setIndex: 1, repsDone: 10, loadDoneKg: 40, status: 'done' }],
      awardGamification: true,
    } as never;

    const primeira = await createSession(userId, null, input);
    const segunda = await createSession(userId, null, input);

    const { rows } = await c.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::int total
         FROM xp_events WHERE user_id = $1 AND kind = 'workout_session'`,
      [userId],
    );
    // Sem planId o replay cria OUTRA sessão — mas o dia é a chave: um crédito só.
    expect(rows[0].n).toBe(1);
    expect(rows[0].total).toBe(30);
    expect(primeira).toBeDefined();
    expect(segunda).toBeDefined();
  });

  it('o saldo agregado nunca diminui', async () => {
    const userId = await novoAluno();
    const saldo = async () => {
      const { rows } = await c.query(
        `SELECT COALESCE(xp,0)::int xp FROM user_gamification_stats WHERE user_id=$1`,
        [userId],
      );
      return Number(rows[0]?.xp ?? 0);
    };

    const s0 = await saldo();
    await award(userId, 'milestone', `${TAG}-m1-${userId}`, DIA);
    // O award não mexe no agregado (o chamador soma); aqui provamos que nenhum
    // caminho do ledger produz débito: todo amount gravado é positivo por CHECK.
    await expect(
      c.query(
        `INSERT INTO xp_events (user_id, kind, amount, event_key, awarded_on)
         VALUES ($1, 'milestone', -5, $2, $3::date)`,
        [userId, `${TAG}-neg-${userId}`, DIA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await saldo()).toBeGreaterThanOrEqual(s0);
  });
});
