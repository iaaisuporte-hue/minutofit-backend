/**
 * Snapshot do S2CORE Readiness contra banco REAL (SPEC Mobile P3 §34–§36).
 *
 * Três coisas só existem no Postgres e não se testam com pool mockado:
 * o CHECK que recusa score sem breakdown (a amarra do CLAUDE.md), a semântica
 * do UPSERT por `(user_id, snapshot_date)`, e o fato de o histórico de outros
 * dias NÃO ser tocado quando o de hoje é recalculado.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb,
  finishSuite, hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-p3-readiness';

describeWithDb('Readiness · snapshot e imutabilidade', () => {
  let c: Client;
  let userId: number;
  let svc: typeof import('../modules/readiness/v1/readiness.service');

  const linha = (over: Record<string, unknown> = {}) => ({
    score: 74, state: 'ready', recommendation: 'NORMAL', confidence: 'high',
    data_completeness: 0.88, mode: 'established',
    components: JSON.stringify([{ key: 'subjective', value: 80 }]),
    factors: JSON.stringify([]), muscle_recovery: JSON.stringify([]),
    algorithm_version: '1.0', ...over,
  });

  async function inserir(dia: string, over: Record<string, unknown> = {}) {
    const v = linha(over);
    return c.query(
      `INSERT INTO readiness_snapshot
         (user_id, snapshot_date, score, state, recommendation, confidence,
          data_completeness, mode, components, factors, muscle_recovery, algorithm_version)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12) RETURNING id`,
      [userId, dia, v.score, v.state, v.recommendation, v.confidence, v.data_completeness,
        v.mode, v.components, v.factors, v.muscle_recovery, v.algorithm_version],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    userId = await createUser(c, TAG, 'atleta');
    svc = await import('../modules/readiness/v1/readiness.service');
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await finishSuite(c);
  });

  describe('a amarra do CLAUDE.md, imposta pelo BANCO', () => {
    it('score COM breakdown grava', async () => {
      const r = await inserir('2026-08-01');
      expect(r.rows[0].id).toBeDefined();
    });

    it('score SEM breakdown é RECUSADO — número-resumo sem interpretação não entra', async () => {
      await expect(inserir('2026-08-02', { components: JSON.stringify([]) }))
        .rejects.toThrow(/chk_readiness_has_components/);
    });

    it('score NULL pode vir sem breakdown — "não dá para afirmar" é resultado válido', async () => {
      const r = await inserir('2026-08-03', { score: null, state: 'calibrating', recommendation: 'CHECKIN_FIRST', components: JSON.stringify([]) });
      expect(r.rows[0].id).toBeDefined();
    });
  });

  describe('CHECKs de domínio', () => {
    it('score fora de 0–100 é recusado', async () => {
      await expect(inserir('2026-08-04', { score: 140 })).rejects.toThrow(/chk_readiness_score_range/);
    });

    it('estado inventado é recusado', async () => {
      await expect(inserir('2026-08-05', { state: 'incrivel' })).rejects.toThrow(/chk_readiness_state/);
    });

    it('recomendação inventada é recusada', async () => {
      await expect(inserir('2026-08-06', { recommendation: 'BEAST_MODE' })).rejects.toThrow(/chk_readiness_recommendation/);
    });

    it('cobertura fora de 0–1 é recusada', async () => {
      await expect(inserir('2026-08-07', { data_completeness: 1.5 })).rejects.toThrow(/chk_readiness_completeness/);
    });
  });

  describe('um snapshot por dia (§35)', () => {
    it('gravar o mesmo dia duas vezes viola a unicidade — o serviço usa UPSERT', async () => {
      await inserir('2026-08-10');
      await expect(inserir('2026-08-10')).rejects.toThrow(/uq_readiness_v1_user_date/);
    });
  });

  describe('imutabilidade do histórico (§36)', () => {
    it('recalcular hoje NÃO reescreve os dias anteriores', async () => {
      await inserir('2026-07-01', { score: 55, algorithm_version: '0.9' });
      await inserir('2026-07-02', { score: 61, algorithm_version: '0.9' });

      // O serviço calcula e grava o snapshot de HOJE.
      await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });

      const { rows } = await c.query(
        `SELECT snapshot_date, score, algorithm_version FROM readiness_snapshot
          WHERE user_id = $1 AND snapshot_date IN ('2026-07-01','2026-07-02')
          ORDER BY snapshot_date`,
        [userId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => Number(r.score))).toEqual([55, 61]);
      // A versão antiga permanece: um snapshot de 0.9 continua sendo 0.9.
      expect(rows.map((r) => r.algorithm_version)).toEqual(['0.9', '0.9']);
    });
  });

  describe('serviço ponta a ponta', () => {
    it('calcula, grava e devolve do cache na segunda chamada (§59)', async () => {
      const primeira = await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
      expect(primeira.cached).toBe(false);
      const segunda = await svc.obterReadinessDeHoje(userId);
      expect(segunda.cached).toBe(true);
      expect(segunda.score).toBe(primeira.score);
    });

    it('invalidar apaga o snapshot do dia e o próximo cálculo reconstrói (§58)', async () => {
      await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
      await svc.invalidarReadiness(userId);
      const r = await svc.obterReadinessDeHoje(userId);
      expect(r.cached).toBe(false);
    });

    it('usuário novo entra em cold start — score null, nunca um número inventado', async () => {
      const novo = await createUser(c, TAG, 'recem-chegado');
      const r = await svc.obterReadinessDeHoje(novo, { forcarRecalculo: true });
      expect(r.score).toBeNull();
      expect(r.state).toBe('calibrating');
      expect(r.confidence).toBe('low');
    });
  });

  describe('resumo do Personal — minimização (§27, §28)', () => {
    it('devolve resumo e motivos, NUNCA dado bruto de saúde', async () => {
      await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
      const resumo = await svc.obterResumoParaPersonal(userId);
      expect(resumo).not.toBeNull();
      const chaves = Object.keys(resumo!);
      expect(chaves.sort()).toEqual(['confidence', 'date', 'muscleRecovery', 'reasons', 'score', 'state']);
      // Nada de componentes, check-in, sono ou qualquer registro de saúde.
      expect(chaves).not.toContain('components');
      expect(chaves).not.toContain('subjective');
      expect(JSON.stringify(resumo)).not.toMatch(/slept_well|in_pain|hrv|resting/i);
    });

    it('aluno sem snapshot do dia devolve null, não um resumo vazio enganoso', async () => {
      const outro = await createUser(c, TAG, 'sem-snapshot');
      expect(await svc.obterResumoParaPersonal(outro)).toBeNull();
    });
  });

  describe('feedback de esforço (§46, §47)', () => {
    it('congela a previsão junto do relato — é o que permite comparar depois', async () => {
      const prev = await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
      await svc.registrarFeedbackDeEsforco(userId, null, 'hard');
      const { rows } = await c.query(
        `SELECT perceived, predicted_score, predicted_recommendation, algorithm_version
           FROM workout_effort_feedback WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      expect(rows[0].perceived).toBe('hard');
      expect(rows[0].predicted_recommendation).toBe(prev.recommendation);
      expect(rows[0].algorithm_version).toBe('1.0');
    });

    it('percepção fora do enum é recusada pelo banco', async () => {
      await expect(
        c.query(`INSERT INTO workout_effort_feedback (user_id, perceived) VALUES ($1,'destruidor')`, [userId]),
      ).rejects.toThrow(/chk_effort_perceived/);
    });
  });
});

describeWithDb('Readiness · o caminho de CACHE devolve o mesmo produto', () => {
  let c: Client;
  let userId: number;
  let svc: typeof import('../modules/readiness/v1/readiness.service');

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, 'itest-p3-cache');
    userId = await createUser(c, 'itest-p3-cache', 'atleta');
    svc = await import('../modules/readiness/v1/readiness.service');
  });
  afterAll(async () => { await cleanFixtures(c, 'itest-p3-cache'); await finishSuite(c); });

  it('manchete e microcopy NÃO vêm vazias do cache', async () => {
    // Regressão: `deLinha` devolvia '' para as duas, e a tela ficava sem título
    // a partir da segunda visita do dia (achado do QA P3).
    const calculado = await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
    const doCache = await svc.obterReadinessDeHoje(userId);
    expect(doCache.cached).toBe(true);
    expect(doCache.headline).toBeTruthy();
    expect(doCache.microcopy).toBeTruthy();
    expect(doCache.headline).toBe(calculado.headline);
    expect(doCache.microcopy).toBe(calculado.microcopy);
  });

  it('cache e cálculo concordam em tudo que o produto exibe', async () => {
    const calc = await svc.obterReadinessDeHoje(userId, { forcarRecalculo: true });
    const cache = await svc.obterReadinessDeHoje(userId);
    const visivel = (r: typeof calc) => ({
      score: r.score, state: r.state, recommendation: r.recommendation,
      confidence: r.confidence, headline: r.headline, microcopy: r.microcopy,
      factors: r.factors, muscleRecovery: r.muscleRecovery,
    });
    expect(visivel(cache)).toEqual(visivel(calc));
  });
});
