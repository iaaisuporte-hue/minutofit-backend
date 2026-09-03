/**
 * Execução dinâmica do treino com banco real (Fase A — backend).
 *
 * O aluno troca e acrescenta exercício durante a sessão, e a partir da migration
 * 1836 o banco distingue as três origens. O que só o Postgres prova aqui: o
 * CHECK do enum, a inferência de `replacement` a partir do UUID que o cliente
 * mandou (inclusive quando o vínculo com o catálogo se perde), e a aritmética da
 * aderência — série extra fora do numerador, substituição dentro.
 *
 * Todo caminho novo é exercitado também pela ROTA, não só pelo serviço. Foi
 * exatamente essa lacuna que deixou o Treino Livre 6/6 verde e quebrado em
 * produção: o defeito morava na coerção do corpo, dentro do router, que nenhum
 * teste atravessava.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
  restorePerformanceSchema,
} from './helpers/integrationDb';

import type { CreateSessionInput, SetLogInput } from '../services/workoutSessionService';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(120_000);

const TAG = 'itest-dynexec';

/** UUID bem-formado que NUNCA existiu em `exercises` — o órfão dos testes. */
const UUID_ORFAO = '11111111-2222-4333-8444-555555555555';

describeWithDb('Execução dinâmica · procedência da série e aderência à ficha', () => {
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

  /** Aluno com PAR-Q válido — sem isso o gate de liberação devolve 403 no POST. */
  async function liberar(userId: number): Promise<number> {
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

  type LinhaGravada = {
    exercise_name: string;
    execution_source: string;
    substituted_from_exercise_id: string | null;
    substitution_reason: string | null;
  };

  async function seriesDaSessao(sessionId: number): Promise<LinhaGravada[]> {
    const { rows } = await c.query<LinhaGravada>(
      `SELECT exercise_name, execution_source, substituted_from_exercise_id, substitution_reason
         FROM workout_set_logs
        WHERE session_id = $1
        ORDER BY order_index, set_index`,
      [sessionId],
    );
    return rows;
  }

  function sessaoCom(sets: SetLogInput[], prescribed: CreateSessionInput['prescribed'] = []): CreateSessionInput {
    return {
      source: 'personal',
      status: 'completed',
      title: 'Treino A',
      planId: null,
      prescribed,
      sets,
      awardGamification: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Gravação da procedência
  // ---------------------------------------------------------------------------

  it('grava as três origens na mesma sessão, com o vínculo da troca', async () => {
    const userId = await novoAluno();
    const original = await createExercise(c, TAG, `Supino Reto ${seq}`);
    const trocado = await createExercise(c, TAG, `Supino Halteres ${seq}`);
    const extra = await createExercise(c, TAG, `Rosca Extra ${seq}`);

    const r = await criarSessao(
      userId,
      null,
      sessaoCom([
        // Sem `executionSource`: é o cliente de antes da coluna existir.
        { exerciseId: original, name: 'Supino Reto', orderIndex: 0, setIndex: 1, repsDone: 10, status: 'done' },
        {
          exerciseId: trocado,
          name: 'Supino Halteres',
          orderIndex: 1,
          setIndex: 1,
          repsDone: 10,
          status: 'done',
          executionSource: 'replacement',
          substitutedFromExerciseId: original,
          substitutionReason: 'banco ocupado',
        },
        {
          exerciseId: extra,
          name: 'Rosca Extra',
          orderIndex: 2,
          setIndex: 1,
          repsDone: 12,
          status: 'done',
          executionSource: 'user_added',
        },
      ]),
    );

    const linhas = await seriesDaSessao(r.id);
    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toMatchObject({
      execution_source: 'prescribed',
      substituted_from_exercise_id: null,
      substitution_reason: null,
    });
    expect(linhas[1]).toMatchObject({
      execution_source: 'replacement',
      substituted_from_exercise_id: original,
      substitution_reason: 'banco ocupado',
    });
    expect(linhas[2]).toMatchObject({
      execution_source: 'user_added',
      substituted_from_exercise_id: null,
    });
  });

  it('origem desconhecida vira prescrita — a sessão não é recusada', async () => {
    const userId = await novoAluno();
    const ex = await createExercise(c, TAG, `Leg Press ${seq}`);

    const r = await criarSessao(
      userId,
      null,
      sessaoCom([
        // Cliente de versão futura, typo, ou payload adulterado: nada disso
        // justifica descartar um treino já feito.
        { exerciseId: ex, name: 'Leg Press', setIndex: 1, repsDone: 10, status: 'done', executionSource: 'sabotagem' as never },
        { exerciseId: ex, name: 'Leg Press', setIndex: 2, repsDone: 10, status: 'done', executionSource: null as never },
        { exerciseId: ex, name: 'Leg Press', setIndex: 3, repsDone: 10, status: 'done', executionSource: 'USER_ADDED' as never },
      ]),
    );

    const linhas = await seriesDaSessao(r.id);
    expect(linhas.map((l) => l.execution_source)).toEqual(['prescribed', 'prescribed', 'prescribed']);
  });

  it('substituição sem origem explícita é inferida pelo exercício de origem', async () => {
    const userId = await novoAluno();
    const original = await createExercise(c, TAG, `Agachamento Livre ${seq}`);
    const trocado = await createExercise(c, TAG, `Agachamento Smith ${seq}`);

    const r = await criarSessao(
      userId,
      null,
      sessaoCom([
        {
          exerciseId: trocado,
          name: 'Agachamento Smith',
          setIndex: 1,
          repsDone: 8,
          status: 'done',
          substitutedFromExerciseId: original,
        },
      ]),
    );

    const linhas = await seriesDaSessao(r.id);
    expect(linhas[0]).toMatchObject({
      execution_source: 'replacement',
      substituted_from_exercise_id: original,
    });
  });

  it('troca de exercício fora do catálogo continua sendo troca — só perde o vínculo', async () => {
    const userId = await novoAluno();
    const trocado = await createExercise(c, TAG, `Remada Curvada ${seq}`);

    const r = await criarSessao(
      userId,
      null,
      sessaoCom([
        // Explícita: o fato da substituição é verdadeiro mesmo com a FK zerada.
        {
          exerciseId: trocado,
          name: 'Remada Curvada',
          orderIndex: 0,
          setIndex: 1,
          repsDone: 10,
          status: 'done',
          executionSource: 'replacement',
          substitutedFromExerciseId: UUID_ORFAO,
        },
        // Inferida: o UUID que o CLIENTE mandou é o que decide, não o que
        // sobreviveu à checagem contra `exercises`.
        {
          exerciseId: trocado,
          name: 'Remada Curvada',
          orderIndex: 0,
          setIndex: 2,
          repsDone: 10,
          status: 'done',
          substitutedFromExerciseId: UUID_ORFAO,
        },
      ]),
    );

    const linhas = await seriesDaSessao(r.id);
    expect(linhas.map((l) => l.execution_source)).toEqual(['replacement', 'replacement']);
    expect(linhas.every((l) => l.substituted_from_exercise_id === null)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Aderência à ficha
  // ---------------------------------------------------------------------------

  /** Personal com aluno vinculado e consents de leitura de treino. */
  async function carteira(): Promise<{ personalId: number; studentId: number }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-carteira-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );
    for (const scope of ['profile', 'workouts']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'personal', $3, 'granted')`,
        [studentId, personalId, scope],
      );
    }
    return { personalId, studentId };
  }

  function serie(exerciseId: string, nome: string, ordem: number, indice: number, origem?: SetLogInput['executionSource']): SetLogInput {
    return {
      exerciseId,
      name: nome,
      orderIndex: ordem,
      setIndex: indice,
      repsDone: 10,
      loadDoneKg: 30,
      status: 'done',
      executionSource: origem,
    };
  }

  it('exercício extra não entra no numerador da aderência', async () => {
    const { personalId, studentId } = await carteira();
    const prescrito = await createExercise(c, TAG, `Supino Ficha ${seq}`);
    const extra = await createExercise(c, TAG, `Abdominal Extra ${seq}`);

    await criarSessao(
      studentId,
      null,
      sessaoCom(
        [
          ...Array.from({ length: 8 }, (_, i) => serie(prescrito, 'Supino', 0, i + 1)),
          ...Array.from({ length: 4 }, (_, i) => serie(extra, 'Abdominal', 1, i + 1, 'user_added')),
        ],
        [{ exerciseId: prescrito, name: 'Supino', sets: '10', reps: '10' }],
      ),
    );

    const resumo = await resumoDoAluno(personalId, studentId);

    // 8 de 10, não 12 de 10. Antes da coluna, as quatro extras somavam no
    // numerador e o clamp mascarava o erro em "100%".
    expect(resumo.adherencePct).toBe(80);
    expect(resumo.sessions[0].setsDone).toBe(8);
    expect(resumo.sessions[0].prescribedSets).toBe(10);
    expect(resumo.sessions[0].extraExercisesCount).toBe(1);
    expect(resumo.sessions[0].substitutionsCount).toBe(0);
  });

  it('substituição conta na aderência: o aluno cumpriu o estímulo com outro exercício', async () => {
    const { personalId, studentId } = await carteira();
    const prescrito = await createExercise(c, TAG, `Supino Original ${seq}`);
    const trocado = await createExercise(c, TAG, `Supino Trocado ${seq}`);

    await criarSessao(
      studentId,
      null,
      sessaoCom(
        [
          ...Array.from({ length: 5 }, (_, i) => serie(prescrito, 'Supino', 0, i + 1)),
          ...Array.from({ length: 5 }, (_, i) => ({
            ...serie(trocado, 'Supino Halteres', 1, i + 1, 'replacement' as const),
            substitutedFromExerciseId: prescrito,
            substitutionReason: 'dor no ombro',
          })),
        ],
        [{ exerciseId: prescrito, name: 'Supino', sets: '10', reps: '10' }],
      ),
    );

    const resumo = await resumoDoAluno(personalId, studentId);

    expect(resumo.adherencePct).toBe(100);
    expect(resumo.sessions[0].setsDone).toBe(10);
    expect(resumo.sessions[0].substitutionsCount).toBe(1);
    expect(resumo.sessions[0].extraExercisesCount).toBe(0);
  });

  it('série pulada continua fora da conta, seja qual for a origem', async () => {
    const { personalId, studentId } = await carteira();
    const prescrito = await createExercise(c, TAG, `Puxada ${seq}`);

    await criarSessao(
      studentId,
      null,
      sessaoCom(
        [
          serie(prescrito, 'Puxada', 0, 1),
          serie(prescrito, 'Puxada', 0, 2),
          { ...serie(prescrito, 'Puxada', 0, 3), status: 'skipped' },
          { ...serie(prescrito, 'Puxada', 0, 4), status: 'skipped' },
        ],
        [{ exerciseId: prescrito, name: 'Puxada', sets: '4', reps: '10' }],
      ),
    );

    const resumo = await resumoDoAluno(personalId, studentId);
    expect(resumo.adherencePct).toBe(50);
    expect(resumo.sessions[0].setsDone).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Contrato HTTP
  // ---------------------------------------------------------------------------

  describe('rotas', () => {
    let appAluno: import('express').Express;
    let appPersonal: import('express').Express;
    let token: (userId: number, role: string, produto: string) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const rotasTraining = (await import('../routes/training')).default;
      const rotasPersonal = (await import('../routes/personal')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      appAluno = express();
      appAluno.use(express.json());
      appAluno.use('/api/training', rotasTraining);

      appPersonal = express();
      appPersonal.use(express.json());
      appPersonal.use('/api/personal', rotasPersonal);

      token = (userId, role, produto) =>
        generateAccessToken({
          id: userId,
          email: `${userId}@test.local`,
          role: role as 'user',
          profileCompleted: true,
          products: [produto],
        });
    });

    it('GET /training/sessions/:id devolve o nome do exercício substituído', async () => {
      const request = (await import('supertest')).default;
      const userId = await novoAluno();
      const original = await createExercise(c, TAG, `Crucifixo Máquina ${seq}`);
      const trocado = await createExercise(c, TAG, `Crucifixo Halteres ${seq}`);

      const sessao = await criarSessao(
        userId,
        null,
        sessaoCom([
          serie(trocado, 'Crucifixo Halteres', 0, 1),
          {
            ...serie(trocado, 'Crucifixo Halteres', 1, 1, 'replacement'),
            substitutedFromExerciseId: original,
            substitutionReason: 'máquina ocupada',
          },
          // Troca cujo exercício de origem não está (mais) no catálogo.
          {
            ...serie(trocado, 'Crucifixo Halteres', 2, 1, 'replacement'),
            substitutedFromExerciseId: UUID_ORFAO,
          },
        ]),
      );

      const res = await request(appAluno)
        .get(`/api/training/sessions/${sessao.id}`)
        .set('Authorization', `Bearer ${token(userId, 'user', 'app')}`);

      expect(res.status).toBe(200);
      const sets = res.body.data.sets;
      expect(sets).toHaveLength(3);

      // Campos que já existiam continuam na resposta — o JOIN não pode ter
      // trocado o `SELECT *` por uma lista que esquece coluna.
      expect(sets[0]).toMatchObject({
        exercise_name: 'Crucifixo Halteres',
        reps_done: 10,
        status: 'done',
        execution_source: 'prescribed',
        substituted_from_name: null,
      });
      expect(sets[0].load_done_kg).not.toBeUndefined();
      expect(sets[0].session_id).toBe(sessao.id);

      expect(sets[1]).toMatchObject({
        execution_source: 'replacement',
        substitution_reason: 'máquina ocupada',
      });
      expect(sets[1].substituted_from_name).toContain('Crucifixo Máquina');

      // Origem órfã: sem nome, sem quebrar a resposta.
      expect(sets[2].execution_source).toBe('replacement');
      expect(sets[2].substituted_from_name).toBeNull();
    });

    it('GET /personal/students/:id/training-summary repassa troca e extra', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await carteira();
      const prescrito = await createExercise(c, TAG, `Desenvolvimento ${seq}`);
      const trocado = await createExercise(c, TAG, `Desenvolvimento Halteres ${seq}`);
      const extra1 = await createExercise(c, TAG, `Elevação Lateral ${seq}`);
      const extra2 = await createExercise(c, TAG, `Encolhimento ${seq}`);

      await criarSessao(
        studentId,
        null,
        sessaoCom(
          [
            serie(prescrito, 'Desenvolvimento', 0, 1),
            {
              ...serie(trocado, 'Desenvolvimento Halteres', 1, 1, 'replacement'),
              substitutedFromExerciseId: prescrito,
            },
            // Dois exercícios extras, três séries: a contagem é de EXERCÍCIO.
            serie(extra1, 'Elevação Lateral', 2, 1, 'user_added'),
            serie(extra1, 'Elevação Lateral', 2, 2, 'user_added'),
            serie(extra2, 'Encolhimento', 3, 1, 'user_added'),
          ],
          [{ exerciseId: prescrito, name: 'Desenvolvimento', sets: '2', reps: '10' }],
        ),
      );

      const res = await request(appPersonal)
        .get(`/api/personal/students/${studentId}/training-summary`)
        .set('Authorization', `Bearer ${token(personalId, 'personal', 'personal')}`);

      expect(res.status).toBe(200);
      const sessao = res.body.data.sessions[0];
      expect(sessao.substitutionsCount).toBe(1);
      expect(sessao.extraExercisesCount).toBe(2);
      expect(sessao.setsDone).toBe(2);
      expect(res.body.data.adherencePct).toBe(100);
    });

    it('POST /training/sessions aceita o payload com as três origens', async () => {
      const request = (await import('supertest')).default;
      const userId = await liberar(await novoAluno());
      const prescrito = await createExercise(c, TAG, `Terra HTTP ${seq}`);
      const trocado = await createExercise(c, TAG, `Terra Sumô HTTP ${seq}`);
      const extra = await createExercise(c, TAG, `Panturrilha HTTP ${seq}`);

      const res = await request(appAluno)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(userId, 'user', 'app')}`)
        .send({
          source: 'personal',
          status: 'completed',
          title: 'Treino B',
          planId: null,
          dayIndex: null,
          awardGamification: true,
          prescribed: [{ exerciseId: prescrito, name: 'Terra', sets: '2', reps: '8' }],
          sets: [
            { exerciseId: prescrito, name: 'Terra', orderIndex: 0, setIndex: 1, repsDone: 8, loadDoneKg: 80, status: 'done', executionSource: 'prescribed' },
            {
              exerciseId: trocado,
              name: 'Terra Sumô',
              orderIndex: 0,
              setIndex: 2,
              repsDone: 8,
              loadDoneKg: 70,
              status: 'done',
              executionSource: 'replacement',
              substitutedFromExerciseId: prescrito,
              substitutionReason: 'lombar sensível',
            },
            { exerciseId: extra, name: 'Panturrilha', orderIndex: 1, setIndex: 1, repsDone: 15, loadDoneKg: 40, status: 'done', executionSource: 'user_added' },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.setCount).toBe(3);

      const linhas = await seriesDaSessao(res.body.data.id);
      expect(linhas.map((l) => l.execution_source)).toEqual(['prescribed', 'replacement', 'user_added']);
      expect(linhas[1].substituted_from_exercise_id).toBe(prescrito);
    });

    it('o teto de séries por sessão segue valendo com o campo novo', async () => {
      const request = (await import('supertest')).default;
      const userId = await liberar(await novoAluno());
      const ex = await createExercise(c, TAG, `Cadeira Extensora ${seq}`);

      const serieHttp = (setIndex: number) => ({
        exerciseId: ex,
        name: 'Cadeira Extensora',
        orderIndex: 0,
        setIndex,
        repsDone: 10,
        status: 'done',
        executionSource: 'user_added',
      });

      const acima = await request(appAluno)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(userId, 'user', 'app')}`)
        .send({
          source: 'free',
          status: 'completed',
          planId: null,
          sets: Array.from({ length: 201 }, (_, i) => serieHttp(i + 1)),
        });
      expect(acima.status).toBe(400);
      expect(acima.body.error).toBe('too_many_sets');

      const noLimite = await request(appAluno)
        .post('/api/training/sessions')
        .set('Authorization', `Bearer ${token(userId, 'user', 'app')}`)
        .send({
          source: 'free',
          status: 'completed',
          planId: null,
          sets: Array.from({ length: 200 }, (_, i) => serieHttp(i + 1)),
        });
      expect(noLimite.status).toBe(201);
      expect(noLimite.body.data.setCount).toBe(200);
    });
  });
});
