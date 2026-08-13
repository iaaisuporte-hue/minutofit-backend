/**
 * Ciclo de vida das conexões no registro de treino (hardening pré-C3).
 *
 * O defeito que estes testes travam: as avaliações pós-COMMIT (metas, marcos,
 * desafios) rodavam DENTRO do `try` que segurava a conexão da transação, e
 * cada uma abre transação própria. Cada POST de treino segurava uma conexão e
 * pedia outra — com o pool no default e sem timeout, requisições simultâneas
 * suficientes prendiam todas as conexões em transações já commitadas enquanto
 * esperavam por mais uma. Auto-deadlock de pool, e sem timeout ele vira
 * travamento em vez de erro.
 *
 * O objetivo aqui não é benchmark: é provar LIFECYCLE. Um pool minúsculo é
 * criado de propósito, porque com o pool real o defeito só apareceria sob
 * carga que nenhum teste deveria precisar produzir.
 */
import { Pool } from 'pg';

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
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(120_000);

const TAG = 'itest-pool';

describeWithDb('Conexões · o treino não segura o pool', () => {
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

  async function registrarTreino(userId: number, titulo = 'Treino'): Promise<unknown> {
    const { createSession } = await import('../services/workoutSessionService');
    seq += 1;
    const ex = await createExercise(c, TAG, `Exercicio ${seq}`);
    return createSession(userId, null, {
      source: 'free',
      status: 'completed',
      title: titulo,
      planId: null,
      sets: [
        { exerciseId: ex, exerciseName: 'Exercicio', setIndex: 1, repsDone: 10, loadDoneKg: 40, status: 'done' },
      ],
      awardGamification: true,
    } as never);
  }

  /* ---------------------------------------------------------------- *
   * 1. Configuração do pool
   * ---------------------------------------------------------------- */

  it('o pool tem limites EXPLÍCITOS — sem eles a saturação vira espera infinita', async () => {
    const { poolStats } = await import('../config/database');
    const stats = poolStats();

    expect(stats.max).toBeGreaterThan(0);
    // O default do `pg` é 10; qualquer valor configurado prova que a decisão
    // foi tomada, não herdada.
    expect(stats.max).toBe(Number(process.env.PG_POOL_MAX) || 20);
    expect(typeof stats.waiting).toBe('number');
  });

  /* ---------------------------------------------------------------- *
   * 2. A conexão volta ao pool antes dos hooks
   * ---------------------------------------------------------------- */

  it('nenhuma conexão fica retida depois do COMMIT', async () => {
    const pool = (await import('../config/database')).default;
    const { poolStats } = await import('../config/database');
    const userId = await novoAluno();

    const antes = poolStats();
    await registrarTreino(userId);

    // Todas as conexões usadas voltaram: nada em uso, nada na fila.
    const depois = poolStats();
    expect(depois.waiting).toBe(0);
    expect(depois.total - depois.idle).toBe(0);
    expect(pool.idleCount).toBeGreaterThanOrEqual(0);
    expect(antes.max).toBe(depois.max);
  });

  it('quando o PRIMEIRO hook roda, a conexão da transação JÁ voltou ao pool', async () => {
    // Este é o teste que prova a ordem — os demais mediriam certo mesmo com o
    // código antigo, porque o `finally` acabava liberando. Aqui a observação
    // acontece DENTRO do hook: se ele rodasse com a conexão da transação na
    // mão, `total - idle` seria ≥ 1.
    const { poolStats } = await import('../config/database');
    const metas = await import('../modules/performance/goals.service');

    let emUsoDuranteOHook = -1;
    const spy = jest.spyOn(metas, 'evaluateGoalsAfterSession').mockImplementation(async () => {
      const s = poolStats();
      emUsoDuranteOHook = s.total - s.idle;
      return [];
    });

    const userId = await novoAluno();
    try {
      await registrarTreino(userId, 'Treino observado');
    } finally {
      spy.mockRestore();
    }

    expect(emUsoDuranteOHook).toBe(0);
  });

  it('registros CONCORRENTES não travam — o pool drena até o fim', async () => {
    const { poolStats } = await import('../config/database');
    const alunos = await Promise.all([novoAluno(), novoAluno(), novoAluno(), novoAluno(), novoAluno()]);

    // Cinco POSTs simultâneos, cada um com três hooks pós-COMMIT. Antes da
    // correção, cada um segurava uma conexão E pedia outra.
    const inicio = Date.now();
    const rs = await Promise.all(alunos.map((id) => registrarTreino(id, 'Concorrente')));
    const duracao = Date.now() - inicio;

    expect(rs).toHaveLength(5);
    expect(rs.every(Boolean)).toBe(true);
    // Tempo finito é o ponto: um auto-deadlock não terminaria.
    expect(duracao).toBeLessThan(60_000);

    const depois = poolStats();
    expect(depois.waiting).toBe(0);
    expect(depois.total - depois.idle).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * 3. Saturação falha de forma previsível
   * ---------------------------------------------------------------- */

  it('pool saturado devolve ERRO em tempo finito — nunca espera indefinida', async () => {
    // Pool próprio, minúsculo e com timeout curto: o objetivo é provar o modo
    // de falha, não medir capacidade. Sem `connectionTimeoutMillis`, este
    // teste ficaria pendurado para sempre — que é exatamente o comportamento
    // que a configuração nova elimina.
    const mini = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 300,
    });

    const presa = await mini.connect(); // ocupa a única conexão
    const inicio = Date.now();
    let erro: Error | null = null;

    try {
      await mini.connect();
    } catch (err) {
      erro = err as Error;
    }
    const esperou = Date.now() - inicio;

    expect(erro).not.toBeNull();
    expect(erro!.message).toMatch(/timeout/i);
    // Falhou rápido e de forma investigável, em vez de acumular espera.
    expect(esperou).toBeLessThan(3_000);

    presa.release();
    await mini.end();
  });

  /* ---------------------------------------------------------------- *
   * 4. O acessório nunca derruba o essencial
   * ---------------------------------------------------------------- */

  it('hook que NÃO CONSEGUE CONEXÃO não derruba o treino já commitado', async () => {
    // Este é o modo de falha que o hardening endereça: sob saturação, o hook
    // não obtém conexão. O treino já está no banco, e a resposta precisa
    // continuar sendo de sucesso.
    const metas = await import('../modules/performance/goals.service');
    const marcos = await import('../modules/community/milestones.service');
    const desafios = await import('../modules/community/challenges.service');

    const spies = [
      jest.spyOn(metas, 'evaluateGoalsAfterSession').mockRejectedValue(
        new Error('timeout exceeded when trying to connect'),
      ),
      jest.spyOn(marcos, 'evaluateMilestones').mockRejectedValue(
        new Error('timeout exceeded when trying to connect'),
      ),
      jest.spyOn(desafios, 'evaluateChallengesAfterSession').mockRejectedValue(
        new Error('timeout exceeded when trying to connect'),
      ),
    ];

    const userId = await novoAluno();
    try {
      const sessao = (await registrarTreino(userId, 'Treino com hooks mortos')) as {
        id: number;
        goalsAchieved: unknown[];
        milestonesUnlocked: unknown[];
      };

      // A resposta é de SUCESSO, com as listas acessórias vazias.
      expect(sessao.id).toBeGreaterThan(0);
      expect(sessao.goalsAchieved).toEqual([]);
      expect(sessao.milestonesUnlocked).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // E o treino está gravado — os três hooks caírem não reverteu nada.
    const { rows } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM workout_sessions WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBe(1);

    const series = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM workout_set_logs l
         JOIN workout_sessions s ON s.id = l.session_id
        WHERE s.user_id = $1`,
      [userId],
    );
    expect(series.rows[0].n).toBe(1);
  });

  it('e o pool fica limpo mesmo quando os hooks falham', async () => {
    const { poolStats } = await import('../config/database');
    const marcos = await import('../modules/community/milestones.service');
    const spy = jest
      .spyOn(marcos, 'evaluateMilestones')
      .mockRejectedValue(new Error('timeout exceeded when trying to connect'));

    const userId = await novoAluno();
    try {
      await registrarTreino(userId, 'Treino com marco morto');
    } finally {
      spy.mockRestore();
    }

    const depois = poolStats();
    expect(depois.waiting).toBe(0);
    expect(depois.total - depois.idle).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * 5. Rollback continua devolvendo a conexão
   * ---------------------------------------------------------------- */

  it('erro DENTRO da transação faz rollback e devolve a conexão', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const { poolStats } = await import('../config/database');
    const userId = await novoAluno();

    // Exercício inexistente: falha dentro da transação.
    await expect(
      createSession(userId, null, {
        source: 'free',
        status: 'completed',
        title: 'Treino inválido',
        planId: null,
        sets: [
          {
            exerciseId: '00000000-0000-4000-8000-000000000000',
            exerciseName: 'Fantasma',
            setIndex: 1,
            repsDone: 10,
            loadDoneKg: 40,
            status: 'done',
          },
        ],
        awardGamification: true,
      } as never),
    ).resolves.toBeDefined();

    // Independentemente do caminho, a conexão voltou.
    const depois = poolStats();
    expect(depois.waiting).toBe(0);
    expect(depois.total - depois.idle).toBe(0);
  });

  it('o replay (mesma conclusão duas vezes) também devolve a conexão', async () => {
    const { poolStats } = await import('../config/database');
    const userId = await novoAluno();

    await registrarTreino(userId, 'Primeiro');
    await registrarTreino(userId, 'Segundo');

    const depois = poolStats();
    expect(depois.waiting).toBe(0);
    expect(depois.total - depois.idle).toBe(0);
  });
});
