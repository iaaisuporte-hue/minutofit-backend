/**
 * Treino Livre com banco real (Fase 1 — backend).
 *
 * O aluno monta um treino ad-hoc e o executa na mesma engine da ficha: a sessão
 * chega com `source: 'free'` e `plan_id` nulo, pelo caminho que o registro
 * retroativo já usava.
 *
 * O que só o Postgres prova aqui: o `client_key` sustenta a idempotência da
 * sessão SEM plano (o índice parcial da migration 1833 é a rede de segurança do
 * advisory lock), o cap diário do ledger não paga o segundo treino do dia, e a
 * aderência do cockpit do personal deixa de somar séries que ninguém prescreveu.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createSetLog,
  createSessionRow,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
  restorePerformanceSchema,
} from './helpers/integrationDb';

import type { CreateSessionInput } from '../services/workoutSessionService';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(120_000);

const TAG = 'itest-freeworkout';

describeWithDb('Treino Livre · sessão sem ficha, idempotente e fora da aderência', () => {
  let c: Client;
  let criarSessao: typeof import('../services/workoutSessionService').createSession;
  let resumoDoAluno: typeof import('../services/workoutSessionService').getStudentExecutionSummary;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    const svc = await import('../services/workoutSessionService');
    criarSessao = svc.createSession;
    resumoDoAluno = svc.getStudentExecutionSummary;
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  async function novoAluno(): Promise<number> {
    seq += 1;
    return createUser(c, TAG, `aluno-${seq}`);
  }

  /** Payload típico do Treino Livre: 3 séries de um exercício da biblioteca. */
  function treinoLivre(exerciseId: string, clientKey: string | null): CreateSessionInput {
    return {
      source: 'free',
      status: 'completed',
      title: 'Treino Livre',
      planId: null,
      prescribed: [{ exerciseId, name: 'Supino Livre', sets: '3', reps: '10' }],
      sets: [1, 2, 3].map((setIndex) => ({
        exerciseId,
        name: 'Supino Livre',
        orderIndex: 0,
        setIndex,
        repsDone: 10,
        loadDoneKg: 40,
        status: 'done' as const,
      })),
      awardGamification: true,
      muscleGroups: ['chest'],
      clientKey,
    };
  }

  async function contarSessoes(userId: number): Promise<number> {
    const { rows } = await c.query(
      `SELECT COUNT(*)::int n FROM workout_sessions WHERE user_id = $1`,
      [userId],
    );
    return rows[0].n;
  }

  async function xpDaSessao(userId: number): Promise<{ n: number; total: number }> {
    const { rows } = await c.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount), 0)::int total
         FROM xp_events WHERE user_id = $1 AND kind = 'workout_session'`,
      [userId],
    );
    return { n: rows[0].n, total: rows[0].total };
  }

  it('grava execução real sem ficha: sessão, séries, log raso e XP uma vez', async () => {
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Supino Livre ${seq}`);

    const r = await criarSessao(userId, null, treinoLivre(ex, `${TAG}-k1-${userId}`));

    expect(r.duplicate).toBe(false);
    expect(r.setCount).toBe(3);

    const sessao = await c.query(
      `SELECT source, plan_id, personal_id, client_key, status
         FROM workout_sessions WHERE id = $1`,
      [r.id],
    );
    expect(sessao.rows[0]).toMatchObject({
      source: 'free',
      plan_id: null,
      personal_id: null,
      client_key: `${TAG}-k1-${userId}`,
      status: 'completed',
    });

    const series = await c.query(
      `SELECT COUNT(*)::int n FROM workout_set_logs WHERE session_id = $1`,
      [r.id],
    );
    expect(series.rows[0].n).toBe(3);

    // Log raso: a projeção que alimenta streak e o dashboard do personal.
    const raso = await c.query(
      `SELECT workout_id FROM user_workout_logs WHERE user_id = $1`,
      [userId],
    );
    expect(raso.rows).toHaveLength(1);
    expect(raso.rows[0].workout_id).toBe(`session-${r.id}`);

    expect(await xpDaSessao(userId)).toEqual({ n: 1, total: 30 });
  });

  it('reenvio com a mesma client_key devolve a sessão existente — uma linha, um crédito', async () => {
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Remada Livre ${seq}`);
    const input = treinoLivre(ex, `${TAG}-k2-${userId}`);

    const primeira = await criarSessao(userId, null, input);
    const segunda = await criarSessao(userId, null, input);

    expect(primeira.duplicate).toBe(false);
    expect(segunda.duplicate).toBe(true);
    expect(segunda.id).toBe(primeira.id);
    // O replay devolve o mesmo total de séries da sessão original.
    expect(segunda.setCount).toBe(3);

    expect(await contarSessoes(userId)).toBe(1);
    expect(await xpDaSessao(userId)).toEqual({ n: 1, total: 30 });

    // Sem a chave, o mesmo payload é um treino novo — é a diferença entre
    // "reenviei" e "treinei de novo", e só o cliente sabe qual das duas é.
    const semChave = await criarSessao(userId, null, treinoLivre(ex, null));
    expect(semChave.duplicate).toBe(false);
    expect(await contarSessoes(userId)).toBe(2);
  });

  it('dois treinos livres no mesmo dia: duas sessões, um crédito de XP', async () => {
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Agachamento Livre ${seq}`);

    const manha = await criarSessao(userId, null, treinoLivre(ex, `${TAG}-k3a-${userId}`));
    const noite = await criarSessao(userId, null, treinoLivre(ex, `${TAG}-k3b-${userId}`));

    expect(noite.id).not.toBe(manha.id);
    expect(await contarSessoes(userId)).toBe(2);

    // `perDay: 1` em workout_session: o segundo treino fica registrado inteiro,
    // só não paga de novo. Sem punição, sem moeda dobrada.
    expect(await xpDaSessao(userId)).toEqual({ n: 1, total: 30 });

    const raso = await c.query(
      `SELECT COUNT(*)::int n FROM user_workout_logs WHERE user_id = $1`,
      [userId],
    );
    expect(raso.rows[0].n).toBe(2);
  });

  it('sessão livre sem conteúdo não paga XP', async () => {
    const vazia = await novoAluno();
    const semSeries = await criarSessao(vazia, null, {
      source: 'free',
      status: 'completed',
      title: 'Treino Livre',
      planId: null,
      prescribed: [],
      sets: [],
      awardGamification: true,
      clientKey: `${TAG}-k4-${vazia}`,
    });
    expect(semSeries.setCount).toBe(0);
    expect(await xpDaSessao(vazia)).toEqual({ n: 0, total: 0 });

    const desistiu = await novoAluno();
    const ex = await createExercise(c, TAG, `Abandonado ${seq}`);
    await criarSessao(desistiu, null, {
      ...treinoLivre(ex, `${TAG}-k5-${desistiu}`),
      status: 'abandoned',
    });
    expect(await xpDaSessao(desistiu)).toEqual({ n: 0, total: 0 });

    const raso = await c.query(
      `SELECT COUNT(*)::int n FROM user_workout_logs WHERE user_id = ANY($1)`,
      [[vazia, desistiu]],
    );
    expect(raso.rows[0].n).toBe(0);
  });

  /**
   * Carteira com uma ficha executada 8 de 10 — a linha de base de 80% contra a
   * qual medimos o que cada sessão sem prescrição faz (ou não faz) com a conta.
   */
  async function fichaOitoDeDez(): Promise<{
    personalId: number;
    studentId: number;
    planId: number;
  }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-resumo-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );

    const plano = await c.query(
      `INSERT INTO personal_workout_plans (personal_id, student_id, title, payload_json)
       VALUES ($1, $2, 'Ficha A', '[]'::jsonb) RETURNING id`,
      [personalId, studentId],
    );
    const planId = plano.rows[0].id;

    const daFicha = await createSessionRow(c, { userId: studentId, daysAgo: 1 });
    await c.query(
      `UPDATE workout_sessions
          SET plan_id = $2, personal_id = $3, source = 'personal',
              prescribed_snapshot = '[{"name":"Supino","sets":"10"}]'::jsonb
        WHERE id = $1`,
      [daFicha, planId, personalId],
    );
    for (let i = 1; i <= 8; i++) {
      await createSetLog(c, {
        sessionId: daFicha,
        exerciseId: null,
        name: 'Supino',
        setIndex: i,
        reps: 10,
        loadKg: 40,
      });
    }

    return { personalId, studentId, planId };
  }

  it('aderência mede a ficha: o treino livre aparece na lista mas fica fora da conta', async () => {
    const { personalId, studentId } = await fichaOitoDeDez();

    // Treino livre no mesmo período: 12 séries, nada prescrito.
    const livre = await createSessionRow(c, { userId: studentId, daysAgo: 0 });
    for (let i = 1; i <= 12; i++) {
      await createSetLog(c, {
        sessionId: livre,
        exerciseId: null,
        name: 'Livre',
        setIndex: i,
        reps: 12,
        loadKg: 20,
      });
    }

    const resumo = await resumoDoAluno(personalId, studentId);

    expect(resumo.adherencePct).toBe(80);
    expect(resumo.adherencePct!).toBeLessThanOrEqual(100);
    expect(resumo.sessions).toHaveLength(2);

    const naLista = resumo.sessions.find((s) => s.id === livre);
    expect(naLista).toBeDefined();
    expect(naLista!.source).toBe('free');
    expect(naLista!.setsDone).toBe(12);
    expect(naLista!.prescribedSets).toBe(0);

    // Frequência continua contando o treino livre: é comportamento real do
    // aluno, e o motor de risco depende disso.
    expect(resumo.total).toBe(2);
  });

  it('sessão com planId mas sem prescrição (Lab guiado) não mexe na aderência', async () => {
    const { personalId, studentId, planId } = await fichaOitoDeDez();
    const ex = await createExercise(c, TAG, `Rosca Guiada ${seq}`);

    // Formato exato que o MovementLabPage envia no modo guiado: `planId` e
    // `dayIndex` preenchidos, NENHUM `prescribed`, séries detalhadas. É análise
    // de um exercício, não execução da ficha — se entrasse só no numerador,
    // 80% viraria 120% (clampado a 100), e o personal leria ficha perfeita.
    const lab = await criarSessao(studentId, null, {
      source: 'movement_lab',
      status: 'completed',
      title: 'Rosca Direta',
      planId,
      dayIndex: 0,
      sets: [1, 2, 3, 4].map((setIndex) => ({
        exerciseId: ex,
        name: 'Rosca Direta',
        orderIndex: 0,
        setIndex,
        repsDone: 12,
        status: 'done' as const,
      })),
      awardGamification: false,
    });

    const resumo = await resumoDoAluno(personalId, studentId);

    expect(resumo.adherencePct).toBe(80);
    expect(resumo.sessions).toHaveLength(2);

    const naLista = resumo.sessions.find((s) => s.id === lab.id);
    expect(naLista).toBeDefined();
    expect(naLista!.source).toBe('movement_lab');
    expect(naLista!.setsDone).toBe(4);
    expect(naLista!.prescribedSets).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Contrato HTTP
  // -------------------------------------------------------------------------

  /**
   * Os testes acima chamam `createSession` direto — e por isso ficaram 6/6
   * verdes com o Treino Livre quebrado em produção: o defeito estava na
   * coerção do corpo, dentro do router, que nenhum deles atravessava
   * (`Number(null) === 0` → `plan_id = 0` → violação de FK → 500 em 100% dos
   * registros). Daqui para frente o payload entra pelo HTTP, como o app manda.
   */
  describe('rota POST /api/training/sessions', () => {
    let app: import('express').Express;
    let token: (userId: number) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const rotas = (await import('../routes/training')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      app = express();
      app.use(express.json());
      app.use('/api/training', rotas);

      token = (userId) =>
        generateAccessToken({
          id: userId,
          email: `${userId}@test.local`,
          role: 'user',
          profileCompleted: true,
          products: ['app'],
        });
    });

    /** Aluno com PAR-Q válido — sem isso o gate de liberação devolve 403. */
    async function alunoLiberado(): Promise<number> {
      const userId = await novoAluno();
      await c.query(
        `UPDATE users
            SET parq_signed_at = now(),
                parq_expires_at = now() + interval '1 year',
                parq_signature_data = 'assinatura-de-teste',
                parq_any_yes = false,
                sem_historico_hipertensao = true,
                sem_historico_cardiaco = true,
                sem_restricao_medica_exercicio = true,
                apto_para_atividade_fisica = true,
                aceita_responsabilidade_informacoes = true
          WHERE id = $1`,
        [userId],
      );
      return userId;
    }

    async function cabecalho(sessionId: number) {
      const { rows } = await c.query(
        `SELECT plan_id, day_index, source, status FROM workout_sessions WHERE id = $1`,
        [sessionId],
      );
      return rows[0];
    }

    it('treino livre com planId/dayIndex null explícitos grava sessão sem ficha', async () => {
      const request = (await import('supertest')).default;
      const userId = await alunoLiberado();
      const ex = await createExercise(c, TAG, `Supino HTTP ${seq}`);

      // Payload exato do Treino Livre: os campos vêm no corpo, com valor null.
      const res = await request(app)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(userId)}`)
        .send({
          source: 'free',
          status: 'completed',
          title: 'Treino Livre',
          planId: null,
          dayIndex: null,
          awardGamification: true,
          muscleGroups: ['chest'],
          clientKey: `${TAG}-http-1-${userId}`,
          prescribed: [{ exerciseId: ex, name: 'Supino HTTP', sets: '3', reps: '10' }],
          sets: [1, 2, 3].map((setIndex) => ({
            exerciseId: ex,
            name: 'Supino HTTP',
            orderIndex: 0,
            setIndex,
            repsDone: 10,
            loadDoneKg: 40,
            status: 'done',
          })),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.setCount).toBe(3);

      expect(await cabecalho(res.body.data.id)).toMatchObject({
        plan_id: null,
        day_index: null,
        source: 'free',
        status: 'completed',
      });
    });

    it('lixo em planId não vira ficha 0 — cai como sessão sem plano', async () => {
      const request = (await import('supertest')).default;
      const userId = await alunoLiberado();

      // '' e 0 são as duas formas de "ausente" que a coerção antiga aceitava
      // como id; 9007199254740991 estoura o int4 e chegava ao banco.
      for (const planId of ['', 0, 9007199254740991, 'abc']) {
        const res = await request(app)
          .post('/api/training/sessions')
          .set('Authorization', `Bearer ${token(userId)}`)
          .send({
            source: 'free',
            status: 'completed',
            title: 'Treino Livre',
            planId,
            prescribed: [],
            sets: [],
            clientKey: `${TAG}-http-lixo-${userId}-${String(planId)}`,
          });

        expect(res.status).toBe(201);
        expect((await cabecalho(res.body.data.id)).plan_id).toBeNull();
      }
    });

    it('um único dia de histórico já devolve a última carga do exercício', async () => {
      const request = (await import('supertest')).default;
      const userId = await alunoLiberado();
      const ex = await createExercise(c, TAG, `Leg Press HTTP ${seq}`);

      await request(app)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(userId)}`)
        .send({
          source: 'free',
          status: 'completed',
          title: 'Treino Livre',
          planId: null,
          clientKey: `${TAG}-http-stats-${userId}`,
          sets: [{ exerciseId: ex, name: 'Leg Press', orderIndex: 0, setIndex: 1, repsDone: 10, loadDoneKg: 110, status: 'done' }],
        })
        .expect(201);

      const stats = await request(app)
        .get('/api/training/stats')
        .set('Authorization', `Bearer ${token(userId)}`);

      expect(stats.status).toBe(200);
      const linha = stats.body.data.exerciseProgression.find((e: any) => e.exerciseId === ex);
      // Antes o exercício só aparecia com ≥2 dias de carga: o chip "última:
      // X kg" sumia e o resumo dizia "1ª vez" para quem treinou ontem.
      expect(linha).toBeDefined();
      expect(linha.lastLoadKg).toBe(110);
      expect(linha.firstLoadKg).toBe(110);
      expect(linha.deltaKg).toBe(0);
      expect(linha.points).toHaveLength(1);
    });

    it('fluxo prescrito segue idêntico: planId numérico e dayIndex 0 chegam ao banco', async () => {
      const request = (await import('supertest')).default;
      const { studentId, planId } = await fichaOitoDeDez();
      await c.query(
        `UPDATE users
            SET parq_signed_at = now(), parq_expires_at = now() + interval '1 year',
                parq_signature_data = 'assinatura-de-teste', parq_any_yes = false,
                sem_historico_hipertensao = true, sem_historico_cardiaco = true,
                sem_restricao_medica_exercicio = true, apto_para_atividade_fisica = true,
                aceita_responsabilidade_informacoes = true
          WHERE id = $1`,
        [studentId],
      );
      const ex = await createExercise(c, TAG, `Supino Ficha ${seq}`);

      const res = await request(app)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(studentId)}`)
        .send({
          source: 'personal',
          status: 'completed',
          title: 'Ficha A',
          planId,
          // Índice 0 é o PRIMEIRO dia da ficha, não "ausente" — precisa
          // sobreviver à sanitização.
          dayIndex: 0,
          awardGamification: true,
          prescribed: [{ exerciseId: ex, name: 'Supino Ficha', sets: '2', reps: '10' }],
        });

      expect(res.status).toBe(201);
      expect(await cabecalho(res.body.data.id)).toMatchObject({
        plan_id: planId,
        day_index: 0,
        source: 'personal',
      });
    });
  });
});
