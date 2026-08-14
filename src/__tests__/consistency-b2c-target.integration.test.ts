/**
 * O denominador da consistência para o aluno B2C (hardening pré-C2).
 *
 * O aluno que assina sozinho nunca tem ficha, e até aqui isso o deixava com
 * consistência permanentemente indefinida — a aba só mostrava números
 * absolutos, e os três marcos de semana eram inalcançáveis para sempre. A meta
 * de frequência que ele mesmo declarou passa a servir de denominador.
 *
 * O que estes testes travam é a PRECEDÊNCIA e o fato de a regra viver num lugar
 * só: se alguém reintroduzir a composição manual num consumidor, a consistência
 * daquele consumidor divergirá e um destes casos quebra.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  describeWithDb,
  hasTestDb,
  finishSuite,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(120_000);

const TAG = 'itest-b2c';

describeWithDb('Consistência · o denominador do aluno sem personal', () => {
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
    // `finishSuite` libera o lock no `finally`: limpeza que falha não
    // pode reter o advisory lock e travar as suítes seguintes.
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  async function novoAluno(): Promise<number> {
    seq += 1;
    const { createUser } = await import('./helpers/integrationDb');
    return createUser(c, TAG, `b2c-${seq}`);
  }

  /** Meta de frequência declarada pelo próprio aluno. */
  async function criarMeta(userId: number, alvo: number, status = 'active'): Promise<void> {
    await c.query(
      `INSERT INTO user_performance_goals
         (user_id, kind, target_value, unit, status, starts_on, achieved_at, metric_version)
       VALUES ($1, 'weekly_frequency', $2, 'sessions', $3, CURRENT_DATE - 60,
               CASE WHEN $3 = 'achieved' THEN NOW() ELSE NULL END, 1)`,
      [userId, alvo, status],
    );
  }

  /** Ficha prescrita por um personal. O preset é o número de dias, não '4x'. */
  async function criarFicha(userId: number, preset: string): Promise<void> {
    // Usa o helper canônico: `users` tem colunas NOT NULL (cpf, phone) que um
    // INSERT à mão esquece — e o helper é quem sabe disso.
    const { createUser } = await import('./helpers/integrationDb');
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    await c.query(`UPDATE users SET role = 'personal' WHERE id = $1`, [personalId]);
    await c.query(
      `INSERT INTO personal_workout_plans (personal_id, student_id, title, week_preset, created_at)
       VALUES ($1, $2, 'Ficha do teste', $3, NOW() - INTERVAL '60 days')`,
      [personalId, userId, preset],
    );
  }

  /** N dias distintos de treino dentro da janela de 28 dias. */
  async function treinar(userId: number, dias: number): Promise<void> {
    for (let i = 0; i < dias; i += 1) {
      await c.query(
        `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
         VALUES ($1, 'free', 'completed', NOW() - ($2 || ' days')::interval,
                 NOW() - ($2 || ' days')::interval, 'Treino B2C')`,
        [userId, i],
      );
    }
  }

  async function alvo(userId: number) {
    const { loadWeeklyFrequencyTarget } = await import(
      '../modules/performance/performance.repository'
    );
    return loadWeeklyFrequencyTarget(userId);
  }

  it('CASO A · sem personal + meta de 3, treinou 3 na semana → alvo é a meta', async () => {
    const userId = await novoAluno();
    await criarMeta(userId, 3);

    const resolvido = await alvo(userId);
    expect(resolvido.weeklyTarget).toBe(3);
    expect(resolvido.source).toBe('goal');
  });

  it('CASO B · sem personal + meta de 4 → o denominador é 4, e 3 treinos dão 75%', async () => {
    const { computeConsistencyPct, resolveConsistencyTarget } = await import(
      '../modules/performance/consistency.engine'
    );
    const userId = await novoAluno();
    await criarMeta(userId, 4);

    const resolvido = await alvo(userId);
    expect(resolvido.weeklyTarget).toBe(4);

    // 28 dias = 4 semanas: alvo cheio 16; 12 dias ativos = 75%.
    const target = resolveConsistencyTarget(4, resolvido.daysSinceStarted);
    expect(target).toBe(16);
    expect(computeConsistencyPct(12, target)).toBe(75);
  });

  it('CASO C · sem personal e sem meta → null, nunca um padrão inventado', async () => {
    const { computeConsistencyPct } = await import('../modules/performance/consistency.engine');
    const userId = await novoAluno();
    await treinar(userId, 5);

    const resolvido = await alvo(userId);
    expect(resolvido.weeklyTarget).toBeNull();
    expect(resolvido.source).toBeNull();
    // Nem 3x, nem 4x, nem nada arbitrário: a tela mostra o absoluto.
    expect(computeConsistencyPct(5, null)).toBeNull();
  });

  it('CASO D · ficha de 4x vence meta pessoal de 3x — sem inflar consistência', async () => {
    const userId = await novoAluno();
    await criarFicha(userId, '4');
    await criarMeta(userId, 3);

    const resolvido = await alvo(userId);
    expect(resolvido.weeklyTarget).toBe(4);
    expect(resolvido.source).toBe('plan');
  });

  it('entre metas ativas vale a MAIOR — declarar uma modesta não afrouxa o alvo', async () => {
    const userId = await novoAluno();
    await criarMeta(userId, 2);
    await criarMeta(userId, 5);

    expect((await alvo(userId)).weeklyTarget).toBe(5);
  });

  it('meta concluída ou abandonada não serve de denominador', async () => {
    const userId = await novoAluno();
    await criarMeta(userId, 4, 'achieved');
    await criarMeta(userId, 2, 'abandoned');

    const resolvido = await alvo(userId);
    expect(resolvido.weeklyTarget).toBeNull();
  });

  it('a consistência exibida no overview usa o mesmo alvo', async () => {
    // Fonte única na prática: o serviço não recompõe nada — se recompusesse, o
    // aluno com meta veria `targetPerWeek: null` aqui e 3 no resolvedor.
    const { computePerformanceCore } = await import(
      '../modules/performance/performance.service'
    );
    const userId = await novoAluno();
    await criarMeta(userId, 3);
    await treinar(userId, 6);

    const core = await computePerformanceCore(userId);
    expect(core.weeklyTarget).toBe(3);
    expect(core.consistencyPct).not.toBeNull();
  });

  it('B2C com meta destrava os marcos de semana — sem lógica duplicada', async () => {
    // A prova do encadeamento inteiro: a correção entrou no Performance, e os
    // marcos passaram a funcionar por CONSUMIREM o resultado canônico.
    const { evaluateMilestones, listMilestonesForUser } = await import(
      '../modules/community/milestones.service'
    );
    const userId = await novoAluno();
    await criarMeta(userId, 3);
    // Quatro semanas com 3 treinos cada, terminando na semana passada.
    for (let semana = 1; semana <= 4; semana += 1) {
      for (const dia of [0, 2, 4]) {
        await c.query(
          `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
           VALUES ($1, 'free', 'completed', $2::timestamptz, $2::timestamptz, 'Treino B2C')`,
          [
            userId,
            new Date(Date.now() - (semana * 7 + (6 - dia)) * 86_400_000).toISOString(),
          ],
        );
      }
    }

    await evaluateMilestones(userId);
    const { rows } = await c.query<{ code: string }>(
      `SELECT code FROM user_milestones WHERE user_id = $1 ORDER BY code`,
      [userId],
    );
    const codigos = rows.map((r) => r.code);
    expect(codigos).toContain('first_full_week');

    // E a aba deixa de marcar os marcos de semana como indisponíveis.
    const lista = await listMilestonesForUser(userId);
    expect(lista.find((m) => m.code === 'four_consistent_weeks')?.available).toBe(true);
  });

  it('sem meta e sem ficha, a aba diz as DUAS saídas', async () => {
    const { listMilestonesForUser } = await import('../modules/community/milestones.service');
    const userId = await novoAluno();

    const lista = await listMilestonesForUser(userId);
    const semanal = lista.find((m) => m.code === 'four_consistent_weeks')!;
    expect(semanal.available).toBe(false);
    expect(semanal.unavailableReason).toMatch(/ficha ou de uma meta/i);
  });
});
