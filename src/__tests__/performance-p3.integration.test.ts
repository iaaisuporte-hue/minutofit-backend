/**
 * Progress Score ponta a ponta — Spec 033, Onda P3.
 *
 * Fluxo real: sessões → séries → métricas → recordes → score. Os valores
 * esperados são calculados à mão a partir do fixture e conferidos um a um —
 * "não é null" não prova fórmula nenhuma.
 *
 * Rodar:
 *   TEST_DATABASE_URL=postgresql://... npm test
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createSessionRow,
  createSetLog,
  createUser,
  describeWithDb,
  hasTestDb,
  releaseSuiteLock,
  restorePerformanceSchema,
  runBackfill,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const TAG = 'itest-p3';

describeWithDb('Performance P3 · Progress Score com banco real', () => {
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

  /** Premium: o score é leitura interpretada e vive atrás do gate da P2. */
  async function grantPremium(userId: number): Promise<void> {
    const tier = await c.query(`SELECT id FROM subscription_tiers WHERE LOWER(name)='premium' LIMIT 1`);
    await c.query(
      `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
       VALUES ($1, $2, 'active', NOW())`,
      [userId, tier.rows[0].id],
    );
  }

  /** Envelhece a conta: o score exige 28 dias de casa. */
  async function ageAccount(userId: number, days: number): Promise<void> {
    await c.query(`UPDATE users SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1`,
      [userId, days]);
  }

  async function sessionWith(
    userId: number, daysAgo: number,
    sets: { exerciseId: string; name: string; reps: number; load: number | null }[],
  ): Promise<number> {
    const sid = await createSessionRow(c, { userId, daysAgo, sessionRpe: 7 });
    let i = 1;
    for (const s of sets) {
      await createSetLog(c, {
        sessionId: sid, exerciseId: s.exerciseId, name: s.name,
        setIndex: i++, reps: s.reps, loadKg: s.load,
      });
    }
    return sid;
  }

  // ── cenário determinístico de 4 semanas ────────────────────────────────

  describe('1 · quatro semanas de evolução', () => {
    /**
     * Desenho do fixture, com a janela do score (28 dias) em mente:
     *
     *   JANELA ANTERIOR (dias 29–56)   JANELA ATUAL (dias 1–28)
     *   Semana 1 (d49) baseline        Semana 3 (d17) estabilidade
     *   Semana 2 (d35) +pequena        Semana 4 (d3)  +relevante
     *
     * Três exercícios, todos com 2 dias em CADA janela — os três entram como
     * comparáveis. Todos melhoram o melhor e1RM da janela atual sobre a
     * anterior, então improved = 3 de 3.
     */
    let userId: number;
    let supino: string, agacho: string, remada: string;

    beforeAll(async () => {
      userId = await createUser(c, TAG, 'quatro-semanas');
      await ageAccount(userId, 120);
      await grantPremium(userId);
      supino = await createExercise(c, TAG, 'Supino P3');
      agacho = await createExercise(c, TAG, 'Agacho P3');
      remada = await createExercise(c, TAG, 'Remada P3');

      const treino = (s: string, n: string, load: number) =>
        [{ exerciseId: s, name: n, reps: 10, load }];

      // ── janela ANTERIOR ──
      await sessionWith(userId, 49, treino(supino, 'Supino P3', 60));
      await sessionWith(userId, 47, treino(agacho, 'Agacho P3', 100));
      await sessionWith(userId, 45, treino(remada, 'Remada P3', 50));
      await sessionWith(userId, 35, treino(supino, 'Supino P3', 62));
      await sessionWith(userId, 33, treino(agacho, 'Agacho P3', 102));
      await sessionWith(userId, 31, treino(remada, 'Remada P3', 52));

      // ── janela ATUAL ──
      await sessionWith(userId, 17, treino(supino, 'Supino P3', 70));
      await sessionWith(userId, 15, treino(agacho, 'Agacho P3', 110));
      await sessionWith(userId, 13, treino(remada, 'Remada P3', 58));
      await sessionWith(userId, 5, treino(supino, 'Supino P3', 72));
      await sessionWith(userId, 4, treino(agacho, 'Agacho P3', 112));
      await sessionWith(userId, 3, treino(remada, 'Remada P3', 60));

      await runBackfill(c);
    });

    it('identifica os três exercícios como comparáveis e todos em melhora', async () => {
      const { loadKeyExerciseProgression } = await import('../modules/performance/performance.repository');
      const key = await loadKeyExerciseProgression(userId, 28);
      expect(key).toEqual({ total: 3, improved: 3, regressed: 0 });
    });

    it('agrega as janelas com a tonelagem certa', async () => {
      const { loadScoreAggregates } = await import('../modules/performance/performance.repository');
      const agg = await loadScoreAggregates(userId, 28);

      // atual: 10×70 + 10×110 + 10×58 + 10×72 + 10×112 + 10×60 = 4820
      expect(Number(agg.tonnageCurrent)).toBe(4820);
      // anterior: 10×60 + 10×100 + 10×50 + 10×62 + 10×102 + 10×52 = 4260
      expect(Number(agg.tonnagePrevious)).toBe(4260);
      expect(agg.sessionsInLookback).toBe(12);
      expect(agg.daysSinceLastSession).toBeLessThanOrEqual(4);
    });

    it('calcula o score com os componentes esperados', async () => {
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const overview = await getPerformanceOverview(userId);
      const score = overview.score!;

      expect(overview.gated).toBe(false);
      expect(score.status).toBe('ok');

      const byId = Object.fromEntries(score.factors.map((f) => [f.id, f.delta]));

      // progressão: 3 de 3 → round(1.0 × 18) = +18
      expect(byId['progression.load']).toBe(18);
      expect(byId['progression.regression']).toBeUndefined();

      // volume: (4820-4260)/4260 = +13,15% → /0,30 = 0,438 → round(0,438×8) = +4
      expect(byId['volume.trend']).toBe(4);

      // recordes reais na janela atual (as estreias ficaram na anterior) → +6
      expect(byId['pr.recent']).toBe(6);

      // sem ficha ativa → consistência não participa
      expect(byId['consistency.high']).toBeUndefined();
      expect(byId['consistency.low']).toBeUndefined();
      // treinou há 3 dias → sem inatividade
      expect(byId['inactivity']).toBeUndefined();

      // 50 + 18 + 4 + 6 = 78
      expect(score.value).toBe(78);
    });

    it('grava o snapshot do dia com a versão da fórmula', async () => {
      const { rows } = await c.query(
        `SELECT score, status, trend, factors, inputs, formula_version
           FROM user_performance_snapshots WHERE user_id = $1`, [userId]);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].score)).toBe(78);
      expect(rows[0].status).toBe('ok');
      expect(rows[0].formula_version).toBe(1);
      // `inputs` existe para auditar o número depois
      expect(rows[0].inputs).toMatchObject({ keyExercises: { total: 3, improved: 3 } });
      expect(Array.isArray(rows[0].factors)).toBe(true);
      expect(rows[0].factors.length).toBeGreaterThan(0);
    });

    it('recalcular NÃO cria linha nova nem muda o número (idempotência)', async () => {
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const a = await getPerformanceOverview(userId);
      const b = await getPerformanceOverview(userId);
      expect(b.score!.value).toBe(a.score!.value);

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM user_performance_snapshots WHERE user_id = $1`, [userId]);
      expect(rows[0].n).toBe(1);
    });

    it('a headline descreve o período sem atribuir causa', async () => {
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const { headline } = await getPerformanceOverview(userId);
      expect(headline.length).toBeGreaterThan(10);
      // linguagem observacional: nada de "porque você dormiu mal"
      expect(headline.toLowerCase()).not.toMatch(/porque|devido a|por causa/);
    });
  });

  // ── casos de borda ──────────────────────────────────────────────────────

  describe('2 · dados insuficientes', () => {
    it('conta nova recebe onboarding, não um número', async () => {
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'novo');
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Ex Novo');
      await sessionWith(userId, 1, [{ exerciseId: ex, name: 'Ex Novo', reps: 10, load: 40 }]);

      const { score, headline } = await getPerformanceOverview(userId);
      expect(score!.status).toBe('onboarding');
      expect(score!.value).toBeNull();
      expect(score!.factors).toHaveLength(1);
      expect(headline).toMatch(/continue registrando/i);
    });
  });

  describe('3 · peso corporal não distorce o score', () => {
    it('treino sem carga externa não gera tonelagem nem fator de volume', async () => {
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const { loadScoreAggregates } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'bodyweight');
      await ageAccount(userId, 120);
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Barra Fixa P3');

      for (const d of [40, 38, 20, 18, 10, 5, 3]) {
        await sessionWith(userId, d, [{ exerciseId: ex, name: 'Barra Fixa P3', reps: 10, load: null }]);
      }
      await runBackfill(c);

      const agg = await loadScoreAggregates(userId, 28);
      // A garantia da P1: ausência de carga é NULL, nunca 0 nem 1e10.
      expect(agg.tonnageCurrent).toBeNull();
      expect(agg.tonnagePrevious).toBeNull();

      const { score } = await getPerformanceOverview(userId);
      const ids = score!.factors.map((f) => f.id);
      expect(ids).not.toContain('volume.trend');
      expect(score!.value).toBeGreaterThanOrEqual(0);
      expect(score!.value).toBeLessThanOrEqual(100);
    });
  });

  describe('4 · sessão parcial conta como execução real', () => {
    it('partial entra nas métricas e no score, como completed', async () => {
      const { loadScoreAggregates } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'parcial');
      await ageAccount(userId, 120);
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Ex Parcial');

      const sid = await createSessionRow(c, { userId, daysAgo: 5, status: 'partial', sessionRpe: 6 });
      await createSetLog(c, { sessionId: sid, exerciseId: ex, name: 'Ex Parcial', setIndex: 1, reps: 8, loadKg: 40 });
      // abandonada NÃO entra
      const sidAb = await createSessionRow(c, { userId, daysAgo: 4, status: 'abandoned', sessionRpe: 9 });
      await createSetLog(c, { sessionId: sidAb, exerciseId: ex, name: 'Ex Parcial', setIndex: 1, reps: 8, loadKg: 400 });
      await runBackfill(c);

      const agg = await loadScoreAggregates(userId, 28);
      // só a parcial: 8 × 40 = 320. A abandonada (8×400=3200) ficou de fora.
      expect(Number(agg.tonnageCurrent)).toBe(320);
    });
  });

  describe('5 · outliers passam pelos clamps sem estourar', () => {
    it('valores extremos não produzem score fora do intervalo nem NaN', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const { getPerformanceOverview } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'outlier');
      await ageAccount(userId, 120);
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Ex Outlier');

      // o serviço clampa reps em 999 e carga em 9999,99
      for (let i = 0; i < 7; i += 1) {
        await createSession(userId, null, {
          source: 'free', status: 'completed', sessionRpe: 10,
          sets: Array.from({ length: 5 }, (_, k) => ({
            exerciseId: ex, name: 'Ex Outlier', setIndex: k + 1,
            repsDone: 99999, loadDoneKg: 99999, status: 'done' as const,
          })),
        });
      }

      const { score, load } = await getPerformanceOverview(userId);
      expect(Number.isInteger(score!.value)).toBe(true);
      expect(score!.value).toBeGreaterThanOrEqual(0);
      expect(score!.value).toBeLessThanOrEqual(100);
      if (load?.effortLoad7d != null) expect(Number.isFinite(load.effortLoad7d)).toBe(true);

      // e a tonelagem não estourou o NUMERIC
      const { rows } = await c.query(
        `SELECT MAX(tonnage_kg)::float8 AS t FROM workout_session_metrics WHERE user_id = $1`, [userId]);
      expect(Number.isFinite(rows[0].t)).toBe(true);
    });
  });

  describe('6 · gating premium continua valendo', () => {
    it('sem Premium, score e carga não saem — mesmo com dados no banco', async () => {
      const { getPerformanceOverview, getScoreHistory } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'free-score');
      await ageAccount(userId, 120);
      const ex = await createExercise(c, TAG, 'Ex Free P3');
      for (const d of [20, 15, 10, 8, 5, 3, 1]) {
        await sessionWith(userId, d, [{ exerciseId: ex, name: 'Ex Free P3', reps: 10, load: 50 }]);
      }
      await runBackfill(c);

      const overview = await getPerformanceOverview(userId);
      expect(overview.gated).toBe(true);
      expect(overview.score).toBeNull();
      expect(overview.load).toBeNull();
      // o que é Free continua vindo
      expect(overview.consistency.activeDays28).toBeGreaterThan(0);

      const history = await getScoreHistory(userId, 90);
      expect(history.gated).toBe(true);
      expect(history.points).toHaveLength(0);
    });
  });

  describe('7 · histórico do score', () => {
    it('devolve só pontos reais, em ordem cronológica', async () => {
      const { getScoreHistory } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'historico');
      await ageAccount(userId, 120);
      await grantPremium(userId);

      // dias com score + um dia em onboarding (score null), que não deve virar ponto
      for (const [dias, valor] of [[5, 60], [3, 64], [1, 68]] as const) {
        await c.query(
          `INSERT INTO user_performance_snapshots
             (user_id, snapshot_date, score, status, trend, factors, inputs, formula_version)
           VALUES ($1, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - $2::int, $3, 'ok', 'up',
                   '[{"id":"x","label":"y","delta":1}]'::jsonb, '{}'::jsonb, 1)`,
          [userId, dias, valor],
        );
      }
      await c.query(
        `INSERT INTO user_performance_snapshots
           (user_id, snapshot_date, score, status, trend, factors, inputs, formula_version)
         VALUES ($1, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 7, NULL, 'onboarding', 'stable',
                 '[{"id":"onboarding.calibrating","label":"c","delta":0}]'::jsonb, '{}'::jsonb, 1)`,
        [userId],
      );

      const { points, gated } = await getScoreHistory(userId, 90);
      expect(gated).toBe(false);
      expect(points.map((p) => p.score)).toEqual([60, 64, 68]);
      const datas = points.map((p) => p.date);
      expect([...datas].sort()).toEqual(datas);
    });
  });

  describe('8 · observabilidade do método de carga', () => {
    it('reporta a distribuição sem expor dado pessoal', async () => {
      const { getEffortMethodDistribution } = await import('../modules/performance/performance.service');
      const dist = await getEffortMethodDistribution(60);
      expect(Array.isArray(dist)).toBe(true);
      for (const d of dist) {
        expect(typeof d.method).toBe('string');
        expect(Number.isInteger(d.sessions)).toBe(true);
        // só método e contagem — nada de usuário
        expect(Object.keys(d).sort()).toEqual(['method', 'sessions']);
      }
      // hoje o cliente registra a sessão no fim, então o proxy por séries domina
      expect(dist.some((d) => d.method === 'srpe_sets')).toBe(true);
    });
  });
});
