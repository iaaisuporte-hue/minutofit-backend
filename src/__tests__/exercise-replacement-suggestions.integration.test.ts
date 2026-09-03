/**
 * Motor de Substituições Inteligentes (Sprint P2A) com banco real.
 *
 * O que só o Postgres prova aqui: os FILTER_RULES (visibilidade, status,
 * body_part) filtram DE VERDADE em SQL antes de qualquer score chegar a
 * existir, o tier `PERSONAL_DEFINED` ignora o threshold sem se misturar com
 * o heurístico, e o histórico (`workout_set_logs.substituted_from_exercise_id`)
 * só pesa em candidato que já era elegível por outro motivo — nunca resgata
 * um candidato de `body_part` incompatível. Score bruto nunca é testado
 * diretamente (o harness proíbe expô-lo na resposta, §10) — os testes
 * verificam efeito observável: quem aparece, em que ordem, com que rótulo.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-p2a-replacement';

type Servico = typeof import('../services/exerciseReplacementSuggestionService');

describeWithDb('Motor de Substituições Inteligentes · candidatos, filtros, score e tiers', () => {
  let c: Client;
  let svc: Servico;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    svc = await import('../services/exerciseReplacementSuggestionService');
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  /** Personal + aluno com vínculo ativo — pré-requisito do tier PERSONAL_DEFINED e da biblioteca do personal. */
  async function dupla(): Promise<{ personalId: number; studentId: number }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );
    return { personalId, studentId };
  }

  async function insertExercise(opts: {
    name: string;
    bodyPart: string;
    targetMuscle: string;
    equipment?: string;
    secondaryMuscles?: string[];
    tags?: string[];
    ownerPersonalId?: number | null;
    status?: 'active' | 'archived';
  }): Promise<string> {
    seq += 1;
    const uniqueName = `${opts.name} ${seq}`;
    const { rows } = await c.query(
      `INSERT INTO exercises
         (source, name, normalized_name, body_part, target_muscle, equipment,
          secondary_muscles, tags, owner_personal_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        TAG,
        uniqueName,
        uniqueName.toLowerCase(),
        opts.bodyPart,
        opts.targetMuscle,
        opts.equipment ?? 'barra',
        opts.secondaryMuscles ?? [],
        opts.tags ?? [],
        opts.ownerPersonalId ?? null,
        opts.status ?? 'active',
      ],
    );
    return rows[0].id as string;
  }

  async function definePersonalAlternative(
    originalId: string,
    alternativeId: string,
    personalId: number,
  ): Promise<void> {
    await c.query(
      `INSERT INTO exercise_replacement_alternatives (original_exercise_id, alternative_exercise_id, personal_id)
       VALUES ($1, $2, $3)`,
      [originalId, alternativeId, personalId],
    );
  }

  /** Registra que `userId` já substituiu `originalId` por `candidateId` numa sessão real (fonte do sinal de histórico). */
  async function logSubstitutionHistory(userId: number, originalId: string, candidateId: string): Promise<void> {
    const { rows } = await c.query(
      `INSERT INTO workout_sessions (user_id, source, status, prescribed_snapshot)
       VALUES ($1, 'free', 'completed', '[]'::jsonb) RETURNING id`,
      [userId],
    );
    const sessionId = rows[0].id;
    await c.query(
      `INSERT INTO workout_set_logs
         (session_id, exercise_id, exercise_name, order_index, set_index, substituted_from_exercise_id, status)
       VALUES ($1, $2, 'Exercício substituto', 0, 1, $3, 'done')`,
      [sessionId, candidateId, originalId],
    );
  }

  function ids(result: Awaited<ReturnType<Servico['getReplacementSuggestions']>>): string[] {
    return result.suggestions.map((s) => s.exercise.id);
  }

  /**
   * `target_muscle` único por teste (sufixo incremental). A visibilidade
   * GLOBAL de exercícios é por desenho (`owner_personal_id IS NULL`), então
   * sem isto exercícios "compatíveis" (mesmo body_part + target_muscle)
   * plantados por testes DIFERENTES entram no MESMO pool de candidatos —
   * MAX_SUGGESTIONS=5 então passa a competir entre suítes e o teste fica
   * flaky por ordem de execução, não por bug do motor.
   */
  function uniqueTarget(base: string): string {
    seq += 1;
    return `${base} #${seq}`;
  }

  // ---------------------------------------------------------------------------
  // Os 10 casos do "TESTES UNITÁRIOS — MOTOR" da spec original
  // ---------------------------------------------------------------------------

  it('1. candidato com mesmo body_part + target_muscle ranqueia bem (passa o threshold)', async () => {
    const userId = await createUser(c, TAG, `u1-${seq}`);
    const tm = uniqueTarget('Peitoral maior');
    const original = await insertExercise({ name: 'Supino Reto', bodyPart: 'peito', targetMuscle: tm });
    const candidato = await insertExercise({ name: 'Supino Inclinado', bodyPart: 'peito', targetMuscle: tm });

    const res = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(res)).toContain(candidato);
    const sug = res.suggestions.find((s) => s.exercise.id === candidato)!;
    expect(sug.tier).toBe('HEURISTIC');
    expect(sug.label).toBe('Boa alternativa'); // 40 < score(=40) < 70 no máximo alcançável sem contexto extra
  });

  it('2. candidato com body_part incompatível é filtrado, mesmo com target_muscle idêntico', async () => {
    const userId = await createUser(c, TAG, `u2-${seq}`);
    const tm = uniqueTarget('Peitoral maior');
    const original = await insertExercise({ name: 'Supino Reto', bodyPart: 'peito', targetMuscle: tm });
    const incompativel = await insertExercise({ name: 'Supino de Perna(?!)', bodyPart: 'perna', targetMuscle: tm });

    const res = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(res)).not.toContain(incompativel);
  });

  it('3. alternativa explícita do Personal fica acima das heurísticas mesmo com score baixo/zero', async () => {
    const { personalId, studentId } = await dupla();
    const tm = uniqueTarget('Peitoral maior');
    const original = await insertExercise({ name: 'Supino Reto', bodyPart: 'peito', targetMuscle: tm });
    // Score heurístico ZERO: body_part diferente do original — só entra por ser PERSONAL_DEFINED, que ignora o filtro de body_part.
    const definida = await insertExercise({ name: 'Alternativa do Personal', bodyPart: 'costas', targetMuscle: tm });
    const heuristico = await insertExercise({
      name: 'Supino Halteres', bodyPart: 'peito', targetMuscle: tm, tags: ['empurrar'],
    });
    await definePersonalAlternative(original, definida, personalId);

    const res = await svc.getReplacementSuggestions(studentId, original, personalId);
    expect(res.suggestions[0].exercise.id).toBe(definida);
    expect(res.suggestions[0].tier).toBe('PERSONAL_DEFINED');
    expect(res.suggestions[0].label).toBe('Recomendado pelo seu Personal');
    expect(ids(res)).toContain(heuristico);
    expect(ids(res).indexOf(definida)).toBeLessThan(ids(res).indexOf(heuristico));
  });

  it('4. exercício personalizado (do próprio personal) compatível pode aparecer', async () => {
    const { personalId, studentId } = await dupla();
    const tm = uniqueTarget('Grande dorsal');
    const original = await insertExercise({ name: 'Remada Curvada', bodyPart: 'costas', targetMuscle: tm });
    const doPersonal = await insertExercise({
      name: 'Remada Autoral do Personal', bodyPart: 'costas', targetMuscle: tm, ownerPersonalId: personalId,
    });

    const res = await svc.getReplacementSuggestions(studentId, original, personalId);
    expect(ids(res)).toContain(doPersonal);
  });

  it('5. exercício personalizado incompatível (body_part diferente) não aparece', async () => {
    const { personalId, studentId } = await dupla();
    const tm = uniqueTarget('Grande dorsal');
    const original = await insertExercise({ name: 'Remada Curvada', bodyPart: 'costas', targetMuscle: tm });
    const doPersonalIncompativel = await insertExercise({
      name: 'Agachamento Autoral', bodyPart: 'perna', targetMuscle: tm, ownerPersonalId: personalId,
    });

    const res = await svc.getReplacementSuggestions(studentId, original, personalId);
    expect(ids(res)).not.toContain(doPersonalIncompativel);
  });

  it('6. exercício de OUTRO personal não aparece nunca, mesmo compatível e com score alto', async () => {
    const { personalId, studentId } = await dupla();
    const outroPersonal = await createUser(c, TAG, `outro-personal-${seq}`);
    const tm = uniqueTarget('Bíceps braquial');
    const original = await insertExercise({ name: 'Rosca Direta', bodyPart: 'bíceps', targetMuscle: tm });
    const doOutroPersonal = await insertExercise({
      name: 'Rosca do Outro Personal', bodyPart: 'bíceps', targetMuscle: tm, ownerPersonalId: outroPersonal,
    });

    const res = await svc.getReplacementSuggestions(studentId, original, personalId);
    expect(ids(res)).not.toContain(doOutroPersonal);
  });

  it('7. exercício arquivado não aparece', async () => {
    const userId = await createUser(c, TAG, `u7-${seq}`);
    const tm = uniqueTarget('Quadríceps');
    const original = await insertExercise({ name: 'Leg Press', bodyPart: 'perna', targetMuscle: tm });
    const arquivado = await insertExercise({
      name: 'Agachamento Arquivado', bodyPart: 'perna', targetMuscle: tm, status: 'archived',
    });

    const res = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(res)).not.toContain(arquivado);
  });

  it('8. histórico compatível aplica boost — candidato com histórico ranqueia acima de um idêntico sem histórico', async () => {
    const userId = await createUser(c, TAG, `u8-${seq}`);
    const tm = uniqueTarget('Deltóide anterior');
    const original = await insertExercise({ name: 'Desenvolvimento Militar', bodyPart: 'ombro', targetMuscle: tm });
    const semHistorico = await insertExercise({ name: 'Elevação Lateral', bodyPart: 'ombro', targetMuscle: tm });
    const comHistorico = await insertExercise({ name: 'Arnold Press', bodyPart: 'ombro', targetMuscle: tm });
    await logSubstitutionHistory(userId, original, comHistorico);

    const res = await svc.getReplacementSuggestions(userId, original, null);
    const idsOrdenados = ids(res);
    expect(idsOrdenados).toContain(semHistorico);
    expect(idsOrdenados).toContain(comHistorico);
    expect(idsOrdenados.indexOf(comHistorico)).toBeLessThan(idsOrdenados.indexOf(semHistorico));

    const sugComHistorico = res.suggestions.find((s) => s.exercise.id === comHistorico)!;
    const sugSemHistorico = res.suggestions.find((s) => s.exercise.id === semHistorico)!;
    expect(sugComHistorico.usedBeforeBadge).toBe(true);
    expect(sugSemHistorico.usedBeforeBadge).toBe(false);
  });

  it('9. histórico de candidato incompatível não o torna elegível — continua filtrado por body_part antes de qualquer boost', async () => {
    const userId = await createUser(c, TAG, `u9-${seq}`);
    const tm = uniqueTarget('Grande dorsal');
    const original = await insertExercise({ name: 'Puxada Alta', bodyPart: 'costas', targetMuscle: tm });
    const incompativelComHistorico = await insertExercise({
      name: 'Extensão de Tríceps (histórico)', bodyPart: 'tríceps', targetMuscle: tm,
    });
    await logSubstitutionHistory(userId, original, incompativelComHistorico);

    const res = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(res)).not.toContain(incompativelComHistorico);
  });

  it('10. score abaixo do threshold (sem target_muscle igual) não aparece', async () => {
    const userId = await createUser(c, TAG, `u10-${seq}`);
    const tm = uniqueTarget('Quadríceps');
    const original = await insertExercise({
      name: 'Cadeira Extensora', bodyPart: 'perna', targetMuscle: tm, secondaryMuscles: ['Core'], tags: ['isolado'],
    });
    // Mesmo body_part, mas target_muscle diferente e zero sinais em comum — no máximo 25 pontos possíveis, sempre < 40.
    const abaixoDoThreshold = await insertExercise({
      name: 'Panturrilha em Pé', bodyPart: 'perna', targetMuscle: uniqueTarget('Panturrilha (gastrocnêmio)'),
    });

    const res = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(res)).not.toContain(abaixoDoThreshold);
  });

  // ---------------------------------------------------------------------------
  // Os 4 casos de contexto
  // ---------------------------------------------------------------------------

  it('11. equipamento ocupado (reasonCategory=equipment_unavailable) despriorizada mesmo equipamento', async () => {
    const userId = await createUser(c, TAG, `u11-${seq}`);
    const tm = uniqueTarget('Peitoral maior');
    const original = await insertExercise({
      name: 'Supino Reto Barra', bodyPart: 'peito', targetMuscle: tm, equipment: 'barra',
    });
    // Só o sinal de target_muscle (score=40) — sem penalidade, exatamente no threshold; com a penalidade cai abaixo.
    const mesmoEquipamento = await insertExercise({
      name: 'Supino Declinado Barra', bodyPart: 'peito', targetMuscle: tm, equipment: 'barra',
    });

    const semContexto = await svc.getReplacementSuggestions(userId, original, null);
    expect(ids(semContexto)).toContain(mesmoEquipamento);

    const comEquipamentoIndisponivel = await svc.getReplacementSuggestions(userId, original, null, {
      reasonCategory: 'equipment_unavailable',
    });
    expect(ids(comEquipamentoIndisponivel)).not.toContain(mesmoEquipamento);
  });

  it('11b. equipamento ocupado desprioriza (não necessariamente exclui) um candidato com score alto o bastante para sobreviver à penalidade', async () => {
    const { personalId, studentId } = await dupla();
    const tm = uniqueTarget('Isquiotibiais');
    const original = await insertExercise({
      name: 'Cadeira Flexora', bodyPart: 'perna', targetMuscle: tm, equipment: 'máquina',
      secondaryMuscles: ['Glúteo', 'Core'], tags: ['maquina', 'unilateral'],
    });
    // score cheio alcançável sem histórico: target(40) + secondary(10) + tags(5) + biblioteca do
    // próprio personal(5) = 60. Com equipamento IGUAL e o motivo ativo, -20 → 40: EXATAMENTE no
    // threshold (inclusivo) — sobrevive, mas ranqueia abaixo do equivalente sem penalidade.
    const mesmoEquipamentoAltoScore = await insertExercise({
      name: 'Mesa Flexora', bodyPart: 'perna', targetMuscle: tm, equipment: 'máquina',
      secondaryMuscles: ['Glúteo', 'Core'], tags: ['maquina', 'unilateral'], ownerPersonalId: personalId,
    });
    // Mesmos sinais, equipamento DIFERENTE → sem penalidade, mantém os 60 pontos inteiros.
    const outroEquipamentoAltoScore = await insertExercise({
      name: 'Stiff com Halteres', bodyPart: 'perna', targetMuscle: tm, equipment: 'halteres',
      secondaryMuscles: ['Glúteo', 'Core'], tags: ['maquina', 'unilateral'], ownerPersonalId: personalId,
    });

    const res = await svc.getReplacementSuggestions(studentId, original, personalId, { reasonCategory: 'equipment_unavailable' });
    const idsOrdenados = ids(res);
    expect(idsOrdenados).toContain(mesmoEquipamentoAltoScore); // sobrevive — desprioriza, não exclui por si só
    expect(idsOrdenados).toContain(outroEquipamentoAltoScore);
    expect(idsOrdenados.indexOf(outroEquipamentoAltoScore)).toBeLessThan(idsOrdenados.indexOf(mesmoEquipamentoAltoScore));
  });

  it('12. dor/desconforto nunca afirma segurança — cautionAdvisory ativo suprime TODOS os rótulos de confiança', async () => {
    const { personalId, studentId } = await dupla();
    const tm = uniqueTarget('Quadríceps');
    const original = await insertExercise({ name: 'Agachamento Livre', bodyPart: 'perna', targetMuscle: tm });
    const definida = await insertExercise({ name: 'Alternativa Indicada', bodyPart: 'costas', targetMuscle: tm });
    const heuristico = await insertExercise({ name: 'Leg Press 45', bodyPart: 'perna', targetMuscle: tm });
    await definePersonalAlternative(original, definida, personalId);

    const res = await svc.getReplacementSuggestions(studentId, original, personalId, { reasonCategory: 'pain_discomfort' });
    expect(res.cautionAdvisory).toBe(true);
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(ids(res)).toEqual(expect.arrayContaining([definida, heuristico]));
    for (const s of res.suggestions) {
      expect(s.label).toBeNull();
    }
  });

  it('13. motivo ausente ou "other" usa o ranking padrão (sem penalidade, sem supressão de rótulo)', async () => {
    const userId = await createUser(c, TAG, `u13-${seq}`);
    const tm = uniqueTarget('Grande dorsal');
    const original = await insertExercise({ name: 'Puxada Frontal', bodyPart: 'costas', targetMuscle: tm });
    const candidato = await insertExercise({ name: 'Remada Baixa', bodyPart: 'costas', targetMuscle: tm });

    const semMotivo = await svc.getReplacementSuggestions(userId, original, null);
    const motivoOutro = await svc.getReplacementSuggestions(userId, original, null, { reasonCategory: 'other' });

    expect(semMotivo.cautionAdvisory).toBe(false);
    expect(motivoOutro.cautionAdvisory).toBe(false);
    expect(ids(semMotivo)).toEqual(ids(motivoOutro));
    expect(semMotivo.suggestions.find((s) => s.exercise.id === candidato)?.label).toBe('Boa alternativa');
    expect(motivoOutro.suggestions.find((s) => s.exercise.id === candidato)?.label).toBe('Boa alternativa');
  });

  it('exercício original inexistente lança erro com status 404 (traduzido pela rota)', async () => {
    const userId = await createUser(c, TAG, `u-404-${seq}`);
    await expect(
      svc.getReplacementSuggestions(userId, '00000000-0000-0000-0000-000000000000', null),
    ).rejects.toMatchObject({ status: 404 });
  });

  // ---------------------------------------------------------------------------
  // Contrato HTTP — molde de personal-finance.integration.test.ts
  // ---------------------------------------------------------------------------

  describe('rota HTTP GET /api/exercises/:id/replacement-suggestions', () => {
    let app: import('express').Express;
    let token: (userId: number, role?: 'user' | 'personal' | 'nutri' | 'admin', products?: string[]) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const catalogRoutes = (await import('../routes/exercises')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      app = express();
      app.use(express.json());
      app.use('/api/exercises', catalogRoutes);

      token = (userId, role = 'user', products = ['personal']) =>
        generateAccessToken({ id: userId, email: `${userId}@test.local`, role, profileCompleted: true, products });
    });

    it('caminho feliz: 200 com sugestões e rótulo pronto para a UI', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      const tm = uniqueTarget('Adutores');
      const original = await insertExercise({ name: 'Cadeira Adutora', bodyPart: 'perna', targetMuscle: tm });
      const candidato = await insertExercise({ name: 'Cadeira Abdutora', bodyPart: 'perna', targetMuscle: tm });
      void personalId;

      const res = await request(app)
        .get(`/api/exercises/${original}/replacement-suggestions`)
        .set('Authorization', `Bearer ${token(studentId)}`);

      expect(res.status).toBe(200);
      expect(res.body.originalExerciseId).toBe(original);
      expect(res.body.cautionAdvisory).toBe(false);
      const encontrado = res.body.suggestions.find((s: any) => s.exercise.id === candidato);
      expect(encontrado).toBeDefined();
      expect(encontrado.label).toBe('Boa alternativa');
      // §10 do harness — nunca a pontuação numérica exposta ao cliente.
      expect(encontrado.score).toBeUndefined();
    });

    it('id inexistente/não visível responde 404', async () => {
      const request = (await import('supertest')).default;
      const userId = await createUser(c, TAG, `http-404-${seq}`);
      const res = await request(app)
        .get('/api/exercises/00000000-0000-0000-0000-000000000000/replacement-suggestions')
        .set('Authorization', `Bearer ${token(userId)}`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('id fora do formato UUID responde 400 sem tocar o banco', async () => {
      const request = (await import('supertest')).default;
      const userId = await createUser(c, TAG, `http-400-${seq}`);
      const res = await request(app)
        .get('/api/exercises/nao-e-um-uuid/replacement-suggestions')
        .set('Authorization', `Bearer ${token(userId)}`);
      expect(res.status).toBe(400);
    });

    it('exercício personalizado de OUTRO personal nunca aparece pelo HTTP, mesmo compatível', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      const outroPersonal = await createUser(c, TAG, `http-outro-${seq}`);
      const tm = uniqueTarget('Tríceps braquial');
      const original = await insertExercise({ name: 'Tríceps Corda', bodyPart: 'tríceps', targetMuscle: tm });
      const doOutroPersonal = await insertExercise({
        name: 'Tríceps Testa do Outro', bodyPart: 'tríceps', targetMuscle: tm, ownerPersonalId: outroPersonal,
      });
      void personalId;

      const res = await request(app)
        .get(`/api/exercises/${original}/replacement-suggestions`)
        .set('Authorization', `Bearer ${token(studentId)}`);

      expect(res.status).toBe(200);
      expect(res.body.suggestions.map((s: any) => s.exercise.id)).not.toContain(doOutroPersonal);
    });
  });

  // ---------------------------------------------------------------------------
  // Resiliência — motor não pode derrubar o processo, nem acoplar a outra rota
  // ---------------------------------------------------------------------------

  describe('resiliência do endpoint', () => {
    it('falha inesperada do motor responde 500 (nunca crash) e não afeta POST /api/training/sessions no mesmo processo', async () => {
      let app!: import('express').Express;
      // `jest.isolateModules` cria um registro de módulos PRÓPRIO — `../config/database`
      // exigido de dentro dele é uma instância NOVA do pool, separada da que
      // `afterAll` fecha. Sem fechar esta aqui, a conexão fica pendurada e o
      // processo do Jest não sai sozinho no fim da suíte.
      let isolatedPool: { end: () => Promise<void> } | undefined;

      // `jest.isolateModules` roda SÍNCRONO — usa `require` (o build é
      // CommonJS) em vez de `import()` dinâmico só dentro deste bloco, para
      // poder mockar o serviço ANTES da rota capturar a referência real.
      jest.isolateModules(() => {
        jest.doMock('../services/exerciseReplacementSuggestionService', () => {
          const actual = jest.requireActual('../services/exerciseReplacementSuggestionService');
          return {
            ...actual,
            getReplacementSuggestions: jest.fn().mockRejectedValue(new Error('falha simulada do motor')),
          };
        });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const express = require('express');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const catalogRoutes = require('../routes/exercises').default;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const trainingRoutes = require('../routes/training').default;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        isolatedPool = require('../config/database').default;

        app = express();
        app.use(express.json());
        app.use('/api/exercises', catalogRoutes);
        app.use('/api/training', trainingRoutes);
      });

      const request = (await import('supertest')).default;
      const { generateAccessToken } = await import('../utils/jwt');
      const userId = await createUser(c, TAG, `resiliencia-${seq}`);
      const tokenUser = generateAccessToken({
        id: userId, email: `${userId}@test.local`, role: 'user', profileCompleted: true, products: ['personal'],
      });
      const algumUuid = '11111111-1111-1111-1111-111111111111';

      try {
        const resFalha = await request(app)
          .get(`/api/exercises/${algumUuid}/replacement-suggestions`)
          .set('Authorization', `Bearer ${tokenUser}`);
        expect(resFalha.status).toBe(500);
        expect(resFalha.body).toHaveProperty('error');

        // Mesmo processo, mesma instância do app: outra rota totalmente
        // independente continua respondendo normalmente depois da falha —
        // prova que o try/catch do handler não vazou pro processo (precedente
        // do bug de middleware sem try/catch documentado no CLAUDE.md).
        const resTreino = await request(app)
          .post('/api/training/sessions')
          .set('Authorization', `Bearer ${tokenUser}`)
          .send({});
        expect(resTreino.status).toBeDefined();
        expect(resTreino.status).not.toBe(0);
        expect([400, 401, 403]).toContain(resTreino.status);
      } finally {
        jest.dontMock('../services/exerciseReplacementSuggestionService');
        await isolatedPool?.end();
      }
    });
  });
});
