/**
 * Recordes e progressão — invariantes que só o banco prova (Spec 033, P2).
 *
 * Rodar:
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/<db> npm test
 *
 * Sem `TEST_DATABASE_URL` a suíte se auto-pula. Ver helpers/integrationDb.ts.
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
  runBackfill,
} from './helpers/integrationDb';

/** Namespace desta suíte — não colide com as fixtures das outras. */
const TAG = 'itest-p2';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const EX_UUID_NULL = null;

describeWithDb('Performance P2 · integração com banco real', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    // Enfileira contra a outra suíte de integração — as duas dividem o banco.
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    // O catálogo de features é semeado no boot do app (`ensurePlanFeaturesSchema`).
    // Num banco de teste que subiu antes desta onda, a chave `performance` não
    // existe — e o gate responderia "sem acesso" para todo mundo, mascarando o
    // que estes testes querem provar.
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

  /** Concede Premium ao usuário para atravessar o gate nos testes de leitura. */
  async function grantPremium(userId: number): Promise<void> {
    const tier = await c.query(
      `SELECT id FROM subscription_tiers WHERE LOWER(name) = 'premium' LIMIT 1`);
    if (tier.rows.length === 0) throw new Error('tier Premium ausente no banco de teste');
    await c.query(
      `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
       VALUES ($1, $2, 'active', NOW())`,
      [userId, tier.rows[0].id],
    );
  }

  async function session(
    userId: number,
    exerciseId: string | null,
    name: string,
    sets: { reps: number | null; load: number | null; status?: 'done' | 'skipped' }[],
    daysAgo = 1,
  ): Promise<number> {
    const sid = await createSessionRow(c, { userId, daysAgo, sessionRpe: 7 });
    let i = 1;
    for (const s of sets) {
      await createSetLog(c, {
        sessionId: sid, exerciseId, name, setIndex: i++, reps: s.reps, loadKg: s.load, status: s.status,
      });
    }
    return sid;
  }

  // ── 1. detecção online ──────────────────────────────────────────────────

  describe('1 · sessão → séries → métricas → recorde', () => {
    it('a sessão gravada pelo serviço detecta e persiste o recorde', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-detect');
      const ex = await createExercise(c, TAG, 'Supino Detect');

      const res = await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 8,
        sets: [
          { exerciseId: ex, name: 'Supino Detect', setIndex: 1, repsDone: 10, loadDoneKg: 70, status: 'done' },
          { exerciseId: ex, name: 'Supino Detect', setIndex: 2, repsDone: 8, loadDoneKg: 75, status: 'done' },
        ],
      });

      // a resposta traz os recordes para a UI celebrar
      expect(res.prEvents.length).toBeGreaterThan(0);
      // primeira vez: tudo é estreia, então não celebra
      expect(res.prEvents.every((p) => p.isFirst)).toBe(true);
      expect(res.celebrate).toBe(false);

      const { rows } = await c.query(
        `SELECT kind, value::float8 AS v, is_first, session_id
           FROM user_pr_events WHERE user_id = $1 ORDER BY kind`, [userId]);
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
      expect(byKind.max_load.v).toBe(75);
      expect(byKind.session_volume.v).toBe(10 * 70 + 8 * 75);
      expect(byKind.best_e1rm.v).toBe(95); // 75×(1+8/30)=95 exato
      expect(byKind.max_load.session_id).toBe(res.id);
    });

    it('a segunda sessão melhor gera recorde com previous_value e celebra', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-improve');
      const ex = await createExercise(c, TAG, 'Agacho Improve');
      const payload = (load: number) => ({
        source: 'free' as const, status: 'completed' as const, sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Agacho Improve', setIndex: 1, repsDone: 5, loadDoneKg: load, status: 'done' as const }],
      });

      await createSession(userId, null, payload(100));
      const segunda = await createSession(userId, null, payload(110));

      const maxLoad = segunda.prEvents.find((p) => p.kind === 'max_load');
      expect(maxLoad?.value).toBe(110);
      expect(maxLoad?.previousValue).toBe(100);
      expect(maxLoad?.isFirst).toBe(false);
      // agora sim: melhora real sobre marca própria
      expect(segunda.celebrate).toBe(true);
    });

    it('empate e queda não geram recorde', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-tie');
      const ex = await createExercise(c, TAG, 'Remada Tie');
      const payload = (load: number) => ({
        source: 'free' as const, status: 'completed' as const, sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Remada Tie', setIndex: 1, repsDone: 5, loadDoneKg: load, status: 'done' as const }],
      });

      await createSession(userId, null, payload(80));
      const empate = await createSession(userId, null, payload(80));
      const queda = await createSession(userId, null, payload(70));

      expect(empate.prEvents.some((p) => p.kind === 'max_load')).toBe(false);
      expect(empate.celebrate).toBe(false);
      expect(queda.prEvents.some((p) => p.kind === 'max_load')).toBe(false);

      const total = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE user_id=$1 AND kind='max_load'`, [userId]);
      expect(total.rows[0].n).toBe(1); // só a estreia
    });

    it('sequência 70 → 75 → 75 → 73 → 80 grava exatamente 70, 75 e 80', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-seq');
      const ex = await createExercise(c, TAG, 'Supino Seq');
      for (const load of [70, 75, 75, 73, 80]) {
        await createSession(userId, null, {
          source: 'free', status: 'completed', sessionRpe: 7,
          sets: [{ exerciseId: ex, name: 'Supino Seq', setIndex: 1, repsDone: 5, loadDoneKg: load, status: 'done' }],
        });
      }
      const { rows } = await c.query(
        `SELECT value::float8 AS v, previous_value::float8 AS pv FROM user_pr_events
          WHERE user_id=$1 AND kind='max_load' ORDER BY value`, [userId]);
      expect(rows.map((r) => r.v)).toEqual([70, 75, 80]);
      expect(rows.map((r) => r.pv)).toEqual([null, 70, 75]);
    });

    it('sessão retroativa grava o recorde mas NÃO celebra', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-retro');
      const ex = await createExercise(c, TAG, 'Levantamento Retro');
      await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Levantamento Retro', setIndex: 1, repsDone: 5, loadDoneKg: 90, status: 'done' }],
      });
      const ontem = new Date();
      ontem.setDate(ontem.getDate() - 2);
      const retro = await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7, performedAt: ontem,
        sets: [{ exerciseId: ex, name: 'Levantamento Retro', setIndex: 1, repsDone: 5, loadDoneKg: 120, status: 'done' }],
      });
      expect(retro.prEvents.some((p) => p.kind === 'max_load')).toBe(true);
      expect(retro.celebrate).toBe(false);
    });

    it('sessão abandonada não gera recorde', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-abandon');
      const ex = await createExercise(c, TAG, 'Ex Abandon');
      const res = await createSession(userId, null, {
        source: 'free', status: 'abandoned', sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Ex Abandon', setIndex: 1, repsDone: 5, loadDoneKg: 999, status: 'done' }],
      });
      expect(res.prEvents).toHaveLength(0);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE user_id=$1`, [userId]);
      expect(rows[0].n).toBe(0);
    });
  });

  // ── 2. idempotência / retry ─────────────────────────────────────────────

  describe('2 · retry não duplica recorde', () => {
    it('replay da mesma conclusão de ficha devolve a sessão e nenhum PR novo', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-replay');
      const ex = await createExercise(c, TAG, 'Supino Replay');
      const plan = await c.query(
        `INSERT INTO personal_workout_plans (personal_id, student_id, title, week_preset, payload_json)
         VALUES ($1,$1,'Ficha P2','4','[]'::jsonb) RETURNING id`, [userId]);
      const payload = {
        source: 'personal' as const, status: 'completed' as const, planId: plan.rows[0].id, dayIndex: 0,
        sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Supino Replay', setIndex: 1, repsDone: 5, loadDoneKg: 100, status: 'done' as const }],
      };

      const first = await createSession(userId, null, payload);
      const second = await createSession(userId, null, payload);

      expect(second.duplicate).toBe(true);
      expect(second.prEvents).toHaveLength(0);
      expect(second.celebrate).toBe(false);

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE user_id=$1`, [userId]);
      expect(rows[0].n).toBe(first.prEvents.length);
    });

    it('sessão avulsa repetida com os MESMOS valores não gera segundo recorde', async () => {
      // Aqui não há chave natural de dedup (sem plano), então nascem duas
      // sessões. Mesmo assim o ledger não cresce: os candidatos da segunda não
      // superam o recorde que a primeira acabou de criar.
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-replay-avulso');
      const ex = await createExercise(c, TAG, 'Rosca Replay');
      const payload = {
        source: 'free' as const, status: 'completed' as const, sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Rosca Replay', setIndex: 1, repsDone: 10, loadDoneKg: 30, status: 'done' as const }],
      };
      const first = await createSession(userId, null, payload);
      const second = await createSession(userId, null, payload);

      expect(second.id).not.toBe(first.id); // duas sessões distintas
      expect(second.prEvents).toHaveLength(0); // mas nenhum recorde novo
    });

    it('backfill depois da detecção online não duplica', async () => {
      const antes = await c.query(`SELECT count(*)::int AS n FROM user_pr_events
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      await runBackfill(c);
      const depois = await c.query(`SELECT count(*)::int AS n FROM user_pr_events
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      expect(depois.rows[0].n).toBe(antes.rows[0].n);
    });
  });

  // ── 3. concorrência ─────────────────────────────────────────────────────

  describe('3 · concorrência', () => {
    it('duas sessões simultâneas do mesmo aluno produzem uma cadeia correta', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-race');
      const ex = await createExercise(c, TAG, 'Agacho Race');

      // marca inicial
      await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Agacho Race', setIndex: 1, repsDone: 5, loadDoneKg: 100, status: 'done' }],
      });

      // duas melhoras disparadas juntas: sem o advisory lock ambas leriam 100
      const [a, b] = await Promise.all([
        createSession(userId, null, {
          source: 'free', status: 'completed', sessionRpe: 7,
          sets: [{ exerciseId: ex, name: 'Agacho Race', setIndex: 1, repsDone: 5, loadDoneKg: 110, status: 'done' }],
        }),
        createSession(userId, null, {
          source: 'free', status: 'completed', sessionRpe: 7,
          sets: [{ exerciseId: ex, name: 'Agacho Race', setIndex: 1, repsDone: 5, loadDoneKg: 120, status: 'done' }],
        }),
      ]);
      expect(a.id).not.toBe(b.id);

      const { rows } = await c.query(
        `SELECT value::float8 AS v, previous_value::float8 AS pv FROM user_pr_events
          WHERE user_id=$1 AND kind='max_load' ORDER BY value`, [userId]);

      // O melhor recorde é sempre o maior valor real.
      expect(Math.max(...rows.map((r) => r.v))).toBe(120);
      // A cadeia é coerente: cada previous_value é o valor imediatamente
      // anterior da sequência, sem "buracos" nem repetição de anterior.
      const valores = rows.map((r) => r.v);
      const anteriores = rows.map((r) => r.pv);
      expect(anteriores[0]).toBeNull();
      for (let i = 1; i < rows.length; i += 1) {
        expect(anteriores[i]).toBe(valores[i - 1]);
      }
      // Nenhum valor duplicado — a constraint e o lock seguram juntos.
      expect(new Set(valores).size).toBe(valores.length);
    });

    it('sessões simultâneas de alunos DIFERENTES não se bloqueiam entre si', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const u1 = await createUser(c, TAG, 'p2-race-a');
      const u2 = await createUser(c, TAG, 'p2-race-b');
      const ex = await createExercise(c, TAG, 'Supino Paralelo');
      const mk = (uid: number) => createSession(uid, null, {
        source: 'free' as const, status: 'completed' as const, sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Supino Paralelo', setIndex: 1, repsDone: 5, loadDoneKg: 60, status: 'done' as const }],
      });
      const [r1, r2] = await Promise.all([mk(u1), mk(u2)]);
      expect(r1.prEvents.length).toBeGreaterThan(0);
      expect(r2.prEvents.length).toBeGreaterThan(0);
    });
  });

  // ── 4. exercício removido ───────────────────────────────────────────────

  describe('4 · exercício removido do catálogo', () => {
    it('recorde sobrevive, some do catálogo e continua saindo no endpoint', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const { getPrRecords } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-orphan');
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Exercicio Sumido');

      await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Exercicio Sumido', setIndex: 1, repsDone: 5, loadDoneKg: 140, status: 'done' }],
      });
      await c.query(`DELETE FROM exercises WHERE id = $1`, [ex]);

      const { rows } = await c.query(
        `SELECT exercise_id, exercise_name FROM user_pr_events WHERE user_id=$1`, [userId]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.exercise_id === EX_UUID_NULL)).toBe(true);
      expect(rows.every((r) => r.exercise_name === 'Exercicio Sumido')).toBe(true);

      const resposta = await getPrRecords(userId, {});
      const orfao = resposta.records.find(
        (r) => r.exerciseName === 'Exercicio Sumido' && r.kind === 'max_load');
      expect(orfao).toBeDefined();
      expect(orfao?.exerciseId).toBeNull();
      expect(orfao?.exerciseInCatalog).toBe(false);
      expect(orfao?.value).toBe(140);
      // e as outras categorias do mesmo órfão também sobrevivem
      expect(resposta.records.filter((r) => r.exerciseName === 'Exercicio Sumido').length)
        .toBeGreaterThan(1);

      // e na linha do tempo também
      expect(resposta.events.some((e) => e.exerciseName === 'Exercicio Sumido')).toBe(true);
    });

    it('LEFT JOIN é contrato: com INNER JOIN o recorde órfão desapareceria', async () => {
      const userId = await createUser(c, TAG, 'p2-leftjoin');
      const ex = await createExercise(c, TAG, 'Prova LeftJoin');
      const sid = await session(userId, ex, 'Prova LeftJoin', [{ reps: 5, load: 88 }]);
      expect(sid).toBeGreaterThan(0);
      await runBackfill(c);
      await c.query(`DELETE FROM exercises WHERE id = $1`, [ex]);

      const left = await c.query(
        `SELECT p.exercise_name FROM user_pr_events p
           LEFT JOIN exercises e ON e.id = p.exercise_id WHERE p.user_id = $1`, [userId]);
      const inner = await c.query(
        `SELECT p.exercise_name FROM user_pr_events p
           JOIN exercises e ON e.id = p.exercise_id WHERE p.user_id = $1`, [userId]);

      expect(left.rows.length).toBeGreaterThan(0);
      expect(inner.rows).toHaveLength(0);
    });

    it('exercício novo com o mesmo nome começa do zero, sem herdar o órfão', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'p2-rebirth');
      const antigo = await createExercise(c, TAG, 'Renascido');
      await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7,
        sets: [{ exerciseId: antigo, name: 'Renascido', setIndex: 1, repsDone: 5, loadDoneKg: 200, status: 'done' }],
      });
      await c.query(`DELETE FROM exercises WHERE id = $1`, [antigo]);

      const novo = await createExercise(c, TAG, 'Renascido');
      const res = await createSession(userId, null, {
        source: 'free', status: 'completed', sessionRpe: 7,
        sets: [{ exerciseId: novo, name: 'Renascido', setIndex: 1, repsDone: 5, loadDoneKg: 50, status: 'done' }],
      });
      // 50 < 200, mas o histórico do exercício apagado não compete
      expect(res.prEvents.find((p) => p.kind === 'max_load')?.isFirst).toBe(true);
    });

    it('dois exercícios removidos não colapsam num bloco só', async () => {
      const { getPrRecords } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-two-orphans');
      await grantPremium(userId);
      const a = await createExercise(c, TAG, 'Orfao Um');
      const b = await createExercise(c, TAG, 'Orfao Dois');
      await session(userId, a, 'Orfao Um', [{ reps: 5, load: 60 }]);
      await session(userId, b, 'Orfao Dois', [{ reps: 5, load: 60 }]);
      await runBackfill(c);
      await c.query(`DELETE FROM exercises WHERE id = ANY($1)`, [[a, b]]);

      const { records } = await getPrRecords(userId, { kind: 'max_load' });
      const nomes = records.map((r) => r.exerciseName).sort();
      expect(nomes).toEqual(['Orfao Dois', 'Orfao Um']);
    });
  });

  // ── 5. leitura: progressão e gating ─────────────────────────────────────

  describe('5 · progressão', () => {
    it('agrega por dia e devolve os deltas de carga e e1RM', async () => {
      const { getProgression } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-prog');
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Supino Prog');
      await session(userId, ex, 'Supino Prog', [{ reps: 10, load: 60 }], 20);
      await session(userId, ex, 'Supino Prog', [{ reps: 10, load: 70 }], 10);

      const { exercises, gated } = await getProgression(userId, 90);
      expect(gated).toBe(false);
      const serie = exercises.find((e) => e.exerciseId === ex)!;
      expect(serie.points).toHaveLength(2);
      expect(serie.firstLoadKg).toBe(60);
      expect(serie.lastLoadKg).toBe(70);
      expect(serie.deltaKg).toBe(10);
      expect(serie.pointCount).toBe(2);
      // e1RM: 60×(1+10/30)=80 → 70×(1+10/30)=93.33→93.5
      expect(serie.firstE1rm).toBe(80);
      expect(serie.lastE1rm).toBe(93.5);
    });

    it('duas sessões no MESMO dia viram um ponto só', async () => {
      const { getProgression } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-sameday');
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Agacho SameDay');
      await session(userId, ex, 'Agacho SameDay', [{ reps: 5, load: 80 }], 3);
      await session(userId, ex, 'Agacho SameDay', [{ reps: 5, load: 90 }], 3);

      const { exercises } = await getProgression(userId, 90, ex);
      expect(exercises[0].points).toHaveLength(1);
      expect(exercises[0].points[0].maxLoadKg).toBe(90); // o melhor do dia
    });

    it('filtra por exercício e clampa a janela', async () => {
      const { getProgression } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-filter');
      await grantPremium(userId);
      const a = await createExercise(c, TAG, 'Filtro A');
      const b = await createExercise(c, TAG, 'Filtro B');
      await session(userId, a, 'Filtro A', [{ reps: 5, load: 50 }], 5);
      await session(userId, b, 'Filtro B', [{ reps: 5, load: 60 }], 5);

      const so = await getProgression(userId, 90, a);
      expect(so.exercises).toHaveLength(1);
      expect(so.exercises[0].exerciseId).toBe(a);

      expect((await getProgression(userId, 5)).windowDays).toBe(30);
      expect((await getProgression(userId, 9999)).windowDays).toBe(180);
    });

    it('série pulada não entra na progressão', async () => {
      const { getProgression } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-skip-prog');
      await grantPremium(userId);
      const ex = await createExercise(c, TAG, 'Pulada Prog');
      await session(userId, ex, 'Pulada Prog', [
        { reps: 5, load: 50 },
        { reps: 5, load: 300, status: 'skipped' },
      ], 2);
      const { exercises } = await getProgression(userId, 90, ex);
      expect(exercises[0].points[0].maxLoadKg).toBe(50);
    });
  });

  describe('6 · gating premium — o backend é a autoridade', () => {
    it('sem a feature, /prs e /progression vêm gated e VAZIOS', async () => {
      const { getPrRecords, getProgression } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-free'); // sem assinatura → Free
      const ex = await createExercise(c, TAG, 'Ex Gate');
      await session(userId, ex, 'Ex Gate', [{ reps: 5, load: 100 }], 2);
      await runBackfill(c);

      // os dados EXISTEM no banco…
      const noBanco = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE user_id=$1`, [userId]);
      expect(noBanco.rows[0].n).toBeGreaterThan(0);

      // …mas o serviço não os entrega: o corte é no servidor, não na tela.
      const prs = await getPrRecords(userId, {});
      expect(prs.gated).toBe(true);
      expect(prs.records).toHaveLength(0);
      expect(prs.events).toHaveLength(0);

      const prog = await getProgression(userId, 90);
      expect(prog.gated).toBe(true);
      expect(prog.exercises).toHaveLength(0);
    });

    it('com Premium, os mesmos dados são entregues', async () => {
      const { getPrRecords } = await import('../modules/performance/performance.service');
      const userId = await createUser(c, TAG, 'p2-premium');
      const ex = await createExercise(c, TAG, 'Ex Premium');
      await session(userId, ex, 'Ex Premium', [{ reps: 5, load: 100 }], 2);
      await runBackfill(c);
      await grantPremium(userId);

      const prs = await getPrRecords(userId, {});
      expect(prs.gated).toBe(false);
      expect(prs.records.length).toBeGreaterThan(0);
    });
  });

  describe('7 · isolamento entre usuários', () => {
    it('o recorde de um aluno nunca aparece para outro', async () => {
      const { getPrRecords } = await import('../modules/performance/performance.service');
      const dono = await createUser(c, TAG, 'p2-owner');
      const outro = await createUser(c, TAG, 'p2-other');
      await grantPremium(dono);
      await grantPremium(outro);
      const ex = await createExercise(c, TAG, 'Ex Privado');
      await session(dono, ex, 'Ex Privado', [{ reps: 5, load: 123 }], 2);
      await runBackfill(c);

      const doDono = await getPrRecords(dono, {});
      const doOutro = await getPrRecords(outro, {});
      expect(doDono.records.some((r) => r.value === 123)).toBe(true);
      expect(doOutro.records).toHaveLength(0);
    });
  });
});
