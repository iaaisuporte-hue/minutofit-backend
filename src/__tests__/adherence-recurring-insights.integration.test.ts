/**
 * Aderência por exercício, recorrência de substituições, insights e revisão
 * assistida da ficha (Sprint P2B) com banco real.
 *
 * O que só o Postgres prova aqui: a classificação por exercício cruza
 * `prescribed_snapshot` (imutável) com `workout_set_logs` agregado sem N+1 e
 * sem contar substituição duas vezes; a regra de prioridade SUBSTITUIDO >
 * PARCIAL; o denominador de aderência ignora `user_added`; a recorrência "3
 * em 5" por PAR e por EXERCÍCIO ORIGINAL; o gatilho independente de
 * `DISCOMFORT_PATTERN`; o selo de alternativa já aprovada (P2A); e que a
 * revisão assistida escreve na ficha ATIVA via `updatePersonalWorkoutPlanWithDays`
 * (nenhum caminho de escrita paralelo) sem NUNCA tocar sessões já registradas
 * nem quebrar um par Bi-Set.
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

const TAG = 'itest-p2b-insights';

type ClassificationSvc = typeof import('../services/executionClassificationService');
type InsightSvc = typeof import('../services/exerciseInsightService');
type ReviewSvc = typeof import('../services/assistedPlanReviewService');
type PlanSvc = typeof import('../services/personalWorkoutPlanService');

describeWithDb('P2B · aderência por exercício, recorrência, insights e revisão assistida', () => {
  let c: Client;
  let classification: ClassificationSvc;
  let insights: InsightSvc;
  let review: ReviewSvc;
  let planSvc: PlanSvc;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    classification = await import('../services/executionClassificationService');
    insights = await import('../services/exerciseInsightService');
    review = await import('../services/assistedPlanReviewService');
    planSvc = await import('../services/personalWorkoutPlanService');
  });

  /** Personais criados nesta suíte — `createPersonalWorkoutPlanWithDays` grava
   * snapshot em `workout_protocols` (scope='personal'); o FK de
   * `owner_personal_id` é `ON DELETE SET NULL`, mas o CHECK exige dono quando
   * `scope='personal'` (mesmo defeito documentado em `personal-custom-
   * exercises.integration.test.ts`) — sem limpar antes, `cleanFixtures`
   * (que apaga os `users`) quebra a suíte inteira. */
  const personalIds: number[] = [];

  afterAll(async () => {
    await finishSuite(c, async () => {
      if (personalIds.length) {
        await c.query(
          `DELETE FROM workout_protocols WHERE owner_personal_id = ANY($1::int[]) AND scope = 'personal'`,
          [personalIds],
        );
      }
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  async function dupla(): Promise<{ personalId: number; studentId: number }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    personalIds.push(personalId);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );
    return { personalId, studentId };
  }

  async function insertExercise(opts: {
    name: string;
    ownerPersonalId?: number | null;
    status?: 'active' | 'archived';
  }): Promise<string> {
    seq += 1;
    const uniqueName = `${opts.name} ${seq}`;
    const { rows } = await c.query(
      `INSERT INTO exercises (source, name, normalized_name, body_part, target_muscle, equipment, owner_personal_id, status)
       VALUES ($1, $2, $3, 'peito', 'peitoral', 'barra', $4, $5)
       RETURNING id`,
      [TAG, uniqueName, uniqueName.toLowerCase(), opts.ownerPersonalId ?? null, opts.status ?? 'active'],
    );
    return rows[0].id as string;
  }

  function item(exerciseId: string, name: string, sets = '3', technique?: unknown) {
    return { exerciseId, name, sets, reps: '10', rest: '60', ...(technique ? { technique } : {}) };
  }

  /** Sessão executada `daysAgo` dias atrás, com o snapshot prescrito dado. */
  async function insertSession(opts: {
    userId: number;
    daysAgo: number;
    prescribed: ReturnType<typeof item>[];
    status?: 'completed' | 'partial';
  }): Promise<number> {
    const { rows } = await c.query(
      `INSERT INTO workout_sessions (user_id, source, status, prescribed_snapshot, started_at, ended_at, performed_at)
       VALUES ($1, 'personal', $2, $3::jsonb, NOW() - ($4 || ' days')::interval, NOW() - ($4 || ' days')::interval, NOW() - ($4 || ' days')::interval)
       RETURNING id`,
      [opts.userId, opts.status ?? 'completed', JSON.stringify(opts.prescribed), String(opts.daysAgo)],
    );
    return rows[0].id as number;
  }

  async function insertSetLog(opts: {
    sessionId: number;
    exerciseId: string | null;
    exerciseName: string;
    executionSource: 'prescribed' | 'replacement' | 'user_added';
    substitutedFrom?: string | null;
    reason?: string | null;
    status?: 'done' | 'skipped';
    setIndex?: number;
  }): Promise<void> {
    await c.query(
      `INSERT INTO workout_set_logs
         (session_id, exercise_id, exercise_name, order_index, set_index, execution_source,
          substituted_from_exercise_id, substitution_reason, status)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8)`,
      [
        opts.sessionId,
        opts.exerciseId,
        opts.exerciseName,
        opts.setIndex ?? 1,
        opts.executionSource,
        opts.substitutedFrom ?? null,
        opts.reason ?? null,
        opts.status ?? 'done',
      ],
    );
  }

  /** Consent 'workouts' — exigido pelo `requireActiveConsent` das rotas HTTP
   * (as chamadas diretas de serviço, no resto da suíte, não passam por rota
   * e por isso não precisam disto). */
  async function grantWorkoutsConsent(studentId: number, personalId: number): Promise<void> {
    await c.query(
      `INSERT INTO user_data_consents
         (user_id, professional_id, professional_role, scope, status, granted_at)
       VALUES ($1, $2, 'personal', 'workouts', 'granted', NOW())`,
      [studentId, personalId],
    );
  }

  async function definePersonalAlternative(originalId: string, alternativeId: string, personalId: number): Promise<void> {
    await c.query(
      `INSERT INTO exercise_replacement_alternatives (original_exercise_id, alternative_exercise_id, personal_id)
       VALUES ($1, $2, $3)`,
      [originalId, alternativeId, personalId],
    );
  }

  // ---------------------------------------------------------------------------
  // Classificação de execução — os 8 casos do harness
  // ---------------------------------------------------------------------------

  describe('classificação de execução por exercício', () => {
    it('1. todas as séries prescritas feitas → EXECUTADO_CONFORME_PRESCRITO', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '3')] });
      for (let i = 1; i <= 3; i++) {
        await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: i });
      }

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].category).toBe('EXECUTADO_CONFORME_PRESCRITO');
      expect(result.buckets.EXECUTADO_CONFORME_PRESCRITO.count).toBe(1);
      expect(result.denominator).toBe(1);
    });

    it('2. substituição registrada → SUBSTITUIDO, independente de o substituto ter sido concluído', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '4')] });
      // Substituto incompleto (1 de 4 séries) — categoria ainda é SUBSTITUIDO (prioridade sobre PARCIAL).
      await insertSetLog({
        sessionId, exerciseId: halteres, exerciseName: 'Supino Halteres', executionSource: 'replacement',
        substitutedFrom: supino, reason: 'Equipamento ocupado', setIndex: 1,
      });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.items[0].category).toBe('SUBSTITUIDO');
      expect(result.items[0].substitutedToExerciseId).toBe(halteres);
      expect(result.items[0].substitutionReason).toBe('Equipamento ocupado');
    });

    it('3. exercício extra (user_added) não entra no denominador — conta separado em `added`', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const extra = await insertExercise({ name: 'Rosca Direta' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '3')] });
      for (let i = 1; i <= 3; i++) await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: i });
      await insertSetLog({ sessionId, exerciseId: extra, exerciseName: 'Rosca Direta', executionSource: 'user_added', setIndex: 1 });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.denominator).toBe(1); // só o prescrito
      expect(result.addedCount).toBe(1);
      expect(result.added[0].exerciseId).toBe(extra);
    });

    it('4. nenhuma série registrada, nem do original nem de substituto → NAO_EXECUTADO', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '3')] });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.items[0].category).toBe('NAO_EXECUTADO');
      expect(result.items[0].doneSets).toBe(0);
    });

    it('5. pelo menos uma série feita, não todas, sem substituição → PARCIAL', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '4')] });
      await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: 1 });
      await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: 2 });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.items[0].category).toBe('PARCIAL');
      expect(result.items[0].doneSets).toBe(2);
      expect(result.items[0].prescribedSets).toBe(4);
    });

    it('6. substituição de um exercício + extra de outro na mesma sessão — contados independentemente', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      const extra = await insertExercise({ name: 'Panturrilha' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '3')] });
      await insertSetLog({ sessionId, exerciseId: halteres, exerciseName: 'Supino Halteres', executionSource: 'replacement', substitutedFrom: supino, setIndex: 1 });
      await insertSetLog({ sessionId, exerciseId: extra, exerciseName: 'Panturrilha', executionSource: 'user_added', setIndex: 1 });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.denominator).toBe(1);
      expect(result.items[0].category).toBe('SUBSTITUIDO');
      expect(result.addedCount).toBe(1);
    });

    it('7. várias sessões com extras não distorcem o denominador da janela', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const extra = await insertExercise({ name: 'Rosca Direta' });
      for (let d = 1; d <= 3; d++) {
        const sessionId = await insertSession({ userId: studentId, daysAgo: d, prescribed: [item(supino, 'Supino Reto', '1')] });
        await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: 1 });
        await insertSetLog({ sessionId, exerciseId: extra, exerciseName: 'Rosca Direta', executionSource: 'user_added', setIndex: 1 });
      }

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.denominator).toBe(3); // 1 exercício prescrito por sessão × 3 sessões
      expect(result.addedCount).toBe(3);
      expect(result.buckets.EXECUTADO_CONFORME_PRESCRITO.count).toBe(3);
      expect(result.buckets.EXECUTADO_CONFORME_PRESCRITO.pct).toBe(100);
    });

    it('8. logs "prescribed" residuais de um item substituído não geram dupla contagem (SUBSTITUIDO conta 1x)', async () => {
      const { studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(supino, 'Supino Reto', '3')] });
      // Alguma série pode ter sido registrada como 'prescribed' ANTES da troca (fluxo real do
      // cliente) — a presença de QUALQUER substituição ainda classifica o item uma única vez.
      await insertSetLog({ sessionId, exerciseId: supino, exerciseName: 'Supino Reto', executionSource: 'prescribed', setIndex: 1 });
      await insertSetLog({ sessionId, exerciseId: halteres, exerciseName: 'Supino Halteres', executionSource: 'replacement', substitutedFrom: supino, setIndex: 1 });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].category).toBe('SUBSTITUIDO');
      expect(result.denominator).toBe(1);
    });

    it('buckets sempre somam exatamente 100% (ajuste de arredondamento no maior bucket)', async () => {
      const { studentId } = await dupla();
      // 3 exercícios prescritos: 1 conforme, 1 substituído, 1 não executado → 33/33/0/33 arredonda para 33/33/0/34 (ajuste no maior, aqui empatado — cai no primeiro por ordem de construção).
      const a = await insertExercise({ name: 'Ex A' });
      const b = await insertExercise({ name: 'Ex B' });
      const bSub = await insertExercise({ name: 'Ex B Sub' });
      const cEx = await insertExercise({ name: 'Ex C' });
      const sessionId = await insertSession({
        userId: studentId, daysAgo: 1,
        prescribed: [item(a, 'Ex A', '1'), item(b, 'Ex B', '1'), item(cEx, 'Ex C', '1')],
      });
      await insertSetLog({ sessionId, exerciseId: a, exerciseName: 'Ex A', executionSource: 'prescribed', setIndex: 1 });
      await insertSetLog({ sessionId, exerciseId: bSub, exerciseName: 'Ex B Sub', executionSource: 'replacement', substitutedFrom: b, setIndex: 1 });

      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      const sum = Object.values(result.buckets).reduce((acc, b2) => acc + (b2.pct ?? 0), 0);
      expect(sum).toBe(100);
    });

    it('janela sem sessão nenhuma devolve buckets nulos, sem erro', async () => {
      const { studentId } = await dupla();
      const result = await classification.classifyExecutionForWindow(studentId, { windowDays: 30 });
      expect(result.denominator).toBe(0);
      expect(result.buckets.EXECUTADO_CONFORME_PRESCRITO.pct).toBeNull();
      expect(result.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Fachada de aderência do personal — checa vínculo
  // ---------------------------------------------------------------------------

  describe('getAdherenceSummaryForPersonal', () => {
    it('personal sem vínculo ativo com o aluno recebe ASSIGNMENT_REQUIRED', async () => {
      const outroPersonal = await createUser(c, TAG, `sem-vinculo-${seq}`);
      const { studentId } = await dupla();
      await expect(
        classification.getAdherenceSummaryForPersonal(outroPersonal, studentId),
      ).rejects.toMatchObject({ code: 'ASSIGNMENT_REQUIRED' });
    });

    it('personal com vínculo ativo lê normalmente', async () => {
      const { personalId, studentId } = await dupla();
      const data = await classification.getAdherenceSummaryForPersonal(personalId, studentId);
      expect(data.denominator).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Recorrência — os 4 casos do harness
  // ---------------------------------------------------------------------------

  describe('recorrência de substituições e insights', () => {
    /** Prescreve `exerciseId` em `n` sessões, cada uma com o substituto e motivo dados na posição correspondente (ou nenhum = conforme prescrito). */
    async function prescreverComHistorico(
      studentId: number,
      exerciseId: string,
      exerciseName: string,
      eventos: { substituteId?: string; substituteName?: string; reason?: string }[],
    ): Promise<void> {
      // Mais antigo primeiro na lista → daysAgo maior primeiro, para "última vez" ser index 0.
      for (let i = 0; i < eventos.length; i++) {
        const daysAgo = eventos.length - i; // último evento = daysAgo 1 (mais recente)
        const sessionId = await insertSession({ userId: studentId, daysAgo, prescribed: [item(exerciseId, exerciseName, '3')] });
        const ev = eventos[i];
        if (ev.substituteId) {
          await insertSetLog({
            sessionId, exerciseId: ev.substituteId, exerciseName: ev.substituteName ?? 'Substituto',
            executionSource: 'replacement', substitutedFrom: exerciseId, reason: ev.reason ?? null, setIndex: 1,
          });
        } else {
          for (let s = 1; s <= 3; s++) {
            await insertSetLog({ sessionId, exerciseId, exerciseName, executionSource: 'prescribed', setIndex: s });
          }
        }
      }
    }

    it('9. uma substituição isolada NUNCA gera insight de recorrência', async () => {
      const { personalId, studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      await prescreverComHistorico(studentId, supino, 'Supino Reto', [
        {}, {}, {}, { substituteId: halteres, substituteName: 'Supino Halteres' },
      ]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      expect(list.find((i) => i.originalExerciseId === supino)).toBeUndefined();
    });

    it('10. 3 em 5 substituições ao MESMO substituto atinge o threshold e gera RECURRING_REPLACEMENT', async () => {
      const { personalId, studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      await prescreverComHistorico(studentId, supino, 'Supino Reto', [
        {}, // conforme
        { substituteId: halteres, substituteName: 'Supino Halteres' },
        { substituteId: halteres, substituteName: 'Supino Halteres' },
        { substituteId: halteres, substituteName: 'Supino Halteres' },
      ]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === supino && i.type === 'RECURRING_REPLACEMENT');
      expect(found).toBeDefined();
      expect(found!.occurrenceCount).toBe(3);
      expect(found!.alternatives[0].exerciseId).toBe(halteres);
      expect(found!.alternatives[0].count).toBe(3);
    });

    it('11. mesmo original com substitutos DIFERENTES consolida no nível de exercício (>=3/5, sem par único vencedor)', async () => {
      const { personalId, studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      const maquina = await insertExercise({ name: 'Supino Máquina' });
      const crucifixo = await insertExercise({ name: 'Crucifixo' });
      await prescreverComHistorico(studentId, supino, 'Supino Reto', [
        { substituteId: halteres, substituteName: 'Supino Halteres' },
        { substituteId: maquina, substituteName: 'Supino Máquina' },
        { substituteId: crucifixo, substituteName: 'Crucifixo' },
      ]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === supino && i.type === 'RECURRING_REPLACEMENT');
      expect(found).toBeDefined();
      expect(found!.occurrenceCount).toBe(3);
      expect(found!.alternatives).toHaveLength(3);
      expect(found!.alternatives.every((a) => a.count === 1)).toBe(true);
    });

    it('12. mesmo par repetido identifica o substituto PRINCIPAL (maior contagem no topo da lista)', async () => {
      const { personalId, studentId } = await dupla();
      const supino = await insertExercise({ name: 'Supino Reto' });
      const halteres = await insertExercise({ name: 'Supino Halteres' });
      const maquina = await insertExercise({ name: 'Supino Máquina' });
      await prescreverComHistorico(studentId, supino, 'Supino Reto', [
        { substituteId: halteres, substituteName: 'Supino Halteres' },
        { substituteId: halteres, substituteName: 'Supino Halteres' },
        { substituteId: maquina, substituteName: 'Supino Máquina' },
      ]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === supino)!;
      expect(found.alternatives[0].exerciseId).toBe(halteres);
      expect(found.alternatives[0].count).toBe(2);
    });

    it('cap de 5 insights e priorização: DISCOMFORT_PATTERN sempre acima de RECURRING_REPLACEMENT', async () => {
      const { personalId, studentId } = await dupla();

      // 6 exercícios diferentes, todos com recorrência — só 5 devem sobreviver.
      const originals: string[] = [];
      for (let k = 0; k < 6; k++) {
        const original = await insertExercise({ name: `Original ${k}` });
        const substituto = await insertExercise({ name: `Substituto ${k}` });
        originals.push(original);
        await prescreverComHistorico(studentId, original, `Original ${k}`, [
          { substituteId: substituto, substituteName: `Substituto ${k}` },
          { substituteId: substituto, substituteName: `Substituto ${k}` },
          { substituteId: substituto, substituteName: `Substituto ${k}` },
        ]);
      }
      // Um deles ganha também desconforto — deve aparecer PRIMEIRO na lista.
      const desconfortoOriginal = await insertExercise({ name: 'Ombro Sensível' });
      const desconfortoSub = await insertExercise({ name: 'Alternativa Sem Dor' });
      await prescreverComHistorico(studentId, desconfortoOriginal, 'Ombro Sensível', [
        { substituteId: desconfortoSub, substituteName: 'Alternativa Sem Dor', reason: 'Dor ou desconforto' },
        { substituteId: desconfortoSub, substituteName: 'Alternativa Sem Dor', reason: 'Dor ou desconforto' },
      ]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      expect(list.length).toBeLessThanOrEqual(5);
      expect(list[0].type).toBe('DISCOMFORT_PATTERN');
      expect(list[0].originalExerciseId).toBe(desconfortoOriginal);
    });
  });

  // ---------------------------------------------------------------------------
  // Consolidação de motivos — os 4 casos do harness
  // ---------------------------------------------------------------------------

  describe('consolidação de motivos de substituição', () => {
    async function cenarioComMotivo(reason: string, count: number) {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Leg Press' });
      const substituto = await insertExercise({ name: 'Cadeira Extensora' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(original, 'Leg Press', '3')] });
      for (let i = 0; i < count; i++) {
        await insertSetLog({
          sessionId, exerciseId: substituto, exerciseName: 'Cadeira Extensora',
          executionSource: 'replacement', substitutedFrom: original, reason, setIndex: i + 1,
        });
      }
      return { personalId, studentId, original };
    }

    it('13. "Equipamento ocupado" é reconhecido como motivo predominante', async () => {
      const { personalId, studentId, original } = await cenarioComMotivo('Equipamento ocupado', 1);
      const detail = await insights.getExerciseInsightDetail(personalId, studentId, original);
      expect(detail?.occurrences[0].substitutionReason).toBe('Equipamento ocupado');
    });

    it('14. "Equipamento quebrado" é reconhecido como motivo predominante', async () => {
      const { personalId, studentId, original } = await cenarioComMotivo('Equipamento quebrado', 1);
      const detail = await insights.getExerciseInsightDetail(personalId, studentId, original);
      expect(detail?.occurrences[0].substitutionReason).toBe('Equipamento quebrado');
    });

    it('15. "Dor ou desconforto" repetido (>=2) dispara DISCOMFORT_PATTERN', async () => {
      const { personalId, studentId, original } = await cenarioComMotivo('Dor ou desconforto', 1);
      // cenarioComMotivo já grava 1 substituição nesta sessão; adiciona mais uma sessão com o mesmo motivo.
      const substituto = await insertExercise({ name: 'Cadeira Extensora 2' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 2, prescribed: [item(original, 'Leg Press', '3')] });
      await insertSetLog({ sessionId, exerciseId: substituto, exerciseName: 'Cadeira Extensora 2', executionSource: 'replacement', substitutedFrom: original, reason: 'Dor ou desconforto', setIndex: 1 });

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === original && i.type === 'DISCOMFORT_PATTERN');
      expect(found).toBeDefined();
      expect(found!.occurrenceCount).toBe(2);
      expect(found!.predominantReason).toEqual({ text: 'Dor ou desconforto', count: 2 });
    });

    it('16. sem motivo (texto vazio/nulo) → predominantReason null, sem quebrar', async () => {
      const { personalId, studentId, original } = await cenarioComMotivo('', 1);
      const detail = await insights.getExerciseInsightDetail(personalId, studentId, original);
      expect(detail?.occurrences[0].substitutionReason).toBe('');
      // Sem motivo consolidável — nenhum dos dois tipos deve carregar `predominantReason` para o RECURRING (não atinge threshold aqui, é só 1 ocorrência).
      expect(detail?.recurringReplacement).toBeNull();
      expect(detail?.discomfortPattern).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Drill-down, exercício personalizado, arquivado, selo de aprovação (P2A)
  // ---------------------------------------------------------------------------

  describe('drill-down e auditabilidade', () => {
    it('17. drill-down de exercício nunca prescrito na janela devolve null (não é erro)', async () => {
      const { personalId, studentId } = await dupla();
      const naoPrescrito = await insertExercise({ name: 'Nunca Prescrito' });
      const detail = await insights.getExerciseInsightDetail(personalId, studentId, naoPrescrito);
      expect(detail).toBeNull();
    });

    it('exercício personalizado do próprio personal aparece corretamente como substituto no insight', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Puxada Alta' });
      const doPersonal = await insertExercise({ name: 'Puxada Autoral', ownerPersonalId: personalId });
      await prescreverComHistoricoDireto(personalId, studentId, original, 'Puxada Alta', doPersonal, 'Puxada Autoral', 3);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === original)!;
      expect(found.alternatives[0].exerciseId).toBe(doPersonal);
    });

    it('exercício arquivado depois de ter sido substituto continua aparecendo no histórico (nome capturado no momento da execução)', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Remada Curvada' });
      const substituto = await insertExercise({ name: 'Remada Cavalinho' });
      await prescreverComHistoricoDireto(personalId, studentId, original, 'Remada Curvada', substituto, 'Remada Cavalinho', 3);
      await c.query(`UPDATE exercises SET status = 'archived' WHERE id = $1`, [substituto]);

      const { insights: list } = await insights.listExerciseInsightsForPersonal(personalId, studentId);
      const found = list.find((i) => i.originalExerciseId === original)!;
      expect(found.alternatives[0].exerciseId).toBe(substituto);
      expect(found.alternatives[0].exerciseName).toBe('Remada Cavalinho');
    });

    it('ownership preservado: personal B não vê insights de aluno de personal A', async () => {
      const { personalId, studentId } = await dupla();
      const outroPersonal = await createUser(c, TAG, `outro-${seq}`);
      const original = await insertExercise({ name: 'Agachamento Livre' });
      const substituto = await insertExercise({ name: 'Leg Press' });
      await prescreverComHistoricoDireto(personalId, studentId, original, 'Agachamento Livre', substituto, 'Leg Press', 3);

      await expect(insights.listExerciseInsightsForPersonal(outroPersonal, studentId)).rejects.toMatchObject({
        code: 'ASSIGNMENT_REQUIRED',
      });
    });

    it('alternativa já aprovada pelo Personal (P2A) recebe o selo `approvedByPersonal`', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Rosca Direta' });
      const aprovada = await insertExercise({ name: 'Rosca Scott' });
      const naoAprovada = await insertExercise({ name: 'Rosca Concentrada' });
      await definePersonalAlternative(original, aprovada, personalId);
      await prescreverComHistoricoDireto(personalId, studentId, original, 'Rosca Direta', aprovada, 'Rosca Scott', 2);
      await prescreverComHistoricoDireto2(studentId, original, 'Rosca Direta', naoAprovada, 'Rosca Concentrada', 1);

      const detail = await insights.getExerciseInsightDetail(personalId, studentId, original);
      const aprovadaEntry = detail!.recurringReplacement!.alternatives.find((a) => a.exerciseId === aprovada);
      const naoAprovadaEntry = detail!.recurringReplacement!.alternatives.find((a) => a.exerciseId === naoAprovada);
      expect(aprovadaEntry?.approvedByPersonal).toBe(true);
      expect(naoAprovadaEntry?.approvedByPersonal).toBe(false);
    });

    /** Igual a `prescreverComHistorico`, mas cada chamada é uma sessão isolada — útil quando o teste monta o histórico em partes. */
    async function prescreverComHistoricoDireto(
      _personalId: number,
      studentId: number,
      original: string,
      originalName: string,
      substituto: string,
      substitutoName: string,
      vezes: number,
    ): Promise<void> {
      for (let i = 0; i < vezes; i++) {
        const sessionId = await insertSession({ userId: studentId, daysAgo: vezes - i, prescribed: [item(original, originalName, '3')] });
        await insertSetLog({ sessionId, exerciseId: substituto, exerciseName: substitutoName, executionSource: 'replacement', substitutedFrom: original, setIndex: 1 });
      }
    }

    async function prescreverComHistoricoDireto2(
      studentId: number,
      original: string,
      originalName: string,
      substituto: string,
      substitutoName: string,
      vezes: number,
    ): Promise<void> {
      for (let i = 0; i < vezes; i++) {
        const sessionId = await insertSession({ userId: studentId, daysAgo: 10 + i, prescribed: [item(original, originalName, '3')] });
        await insertSetLog({ sessionId, exerciseId: substituto, exerciseName: substitutoName, executionSource: 'replacement', substitutedFrom: original, setIndex: 1 });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Revisão assistida — aplica, dispensa, Bi-Set, imutabilidade histórica
  // ---------------------------------------------------------------------------

  describe('revisão assistida da ficha', () => {
    it('aplica a troca na ficha ATIVA preservando os demais itens do dia e reps/séries do item trocado', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Supino Reto' });
      const alvo = await insertExercise({ name: 'Supino Halteres' });
      const outro = await insertExercise({ name: 'Tríceps Corda' });

      await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha Revisão',
        weekPreset: '3',
        days: [
          { name: 'Dia A', focus: 'peito', items: [item(original, 'Supino Reto', '4'), item(outro, 'Tríceps Corda', '3')] },
        ],
      });

      const result = await review.applyAssistedPlanReview(personalId, studentId, original, alvo);
      expect(result.applied).toBe(true);
      if (!result.applied) throw new Error('esperava applied=true');
      const day = result.plan.days[0];
      const trocado = day.items.find((i: any) => i.exerciseId === alvo);
      const intacto = day.items.find((i: any) => i.exerciseId === outro);
      expect(trocado).toBeDefined();
      expect(trocado.sets).toBe('4'); // reps/séries preservadas
      expect(intacto).toBeDefined();
      expect(intacto.name).toBe('Tríceps Corda'); // item irmão intocado
      expect(day.items.find((i: any) => i.exerciseId === original)).toBeUndefined();
    });

    it('Bi-Set: revisão de um membro do par devolve requiresManualEdit, sem tocar a ficha', async () => {
      const { personalId, studentId } = await dupla();
      const parA = await insertExercise({ name: 'Supino Reto BiSet' });
      const parB = await insertExercise({ name: 'Crucifixo BiSet' });
      const alvo = await insertExercise({ name: 'Supino Halteres' });
      const groupId = (await import('crypto')).randomUUID();

      const created = await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha Bi-Set',
        weekPreset: '3',
        days: [
          {
            name: 'Dia A', focus: 'peito',
            items: [
              item(parA, 'Supino Reto BiSet', '3', { type: 'bi_set', biSetGroupId: groupId }),
              item(parB, 'Crucifixo BiSet', '3', { type: 'bi_set', biSetGroupId: groupId }),
            ],
          },
        ],
      });

      const result = await review.applyAssistedPlanReview(personalId, studentId, parA, alvo);
      expect(result.applied).toBe(false);
      if (result.applied) throw new Error('esperava applied=false');
      expect(result.requiresManualEdit).toBe(true);
      expect(result.reason).toBe('BI_SET_MEMBER');
      expect(result.planId).toBe(created.id);

      // A ficha continua intacta — nenhuma escrita foi tentada.
      const plans = await planSvc.listPersonalWorkoutPlans(personalId, studentId, 1);
      const items = plans[0].days[0].items;
      expect(items.find((i: any) => i.exerciseId === parA)).toBeDefined();
      expect(items.find((i: any) => i.exerciseId === parB)).toBeDefined();
    });

    it('revisão assistida nunca altera o `prescribed_snapshot` de sessões já registradas (imutabilidade histórica)', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Agachamento Livre' });
      const alvo = await insertExercise({ name: 'Leg Press' });

      await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha Histórica', weekPreset: '3',
        days: [{ name: 'Dia A', items: [item(original, 'Agachamento Livre', '3')] }],
      });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 5, prescribed: [item(original, 'Agachamento Livre', '3')] });

      await review.applyAssistedPlanReview(personalId, studentId, original, alvo);

      const { rows } = await c.query(`SELECT prescribed_snapshot FROM workout_sessions WHERE id = $1`, [sessionId]);
      const snapshot = rows[0].prescribed_snapshot;
      expect(snapshot[0].exerciseId).toBe(original); // snapshot congelado, não migrou para o novo exerciseId
    });

    it('exercício alvo inválido (não é UUID) → erro 400 nomeado', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Panturrilha em Pé' });
      await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha', weekPreset: '3', days: [{ name: 'Dia A', items: [item(original, 'Panturrilha em Pé', '3')] }],
      });

      await expect(
        review.applyAssistedPlanReview(personalId, studentId, original, 'nao-e-um-uuid'),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_EXERCISE_ID' });
    });

    it('sem ficha ativa para o aluno → NO_ACTIVE_PLAN (404)', async () => {
      const { personalId, studentId } = await dupla();
      const original = await insertExercise({ name: 'Puxada Alta' });
      const alvo = await insertExercise({ name: 'Remada Baixa' });
      await expect(review.applyAssistedPlanReview(personalId, studentId, original, alvo)).rejects.toMatchObject({
        status: 404, code: 'NO_ACTIVE_PLAN',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Contrato HTTP — molde de personal-finance.integration.test.ts
  // ---------------------------------------------------------------------------

  describe('rotas HTTP /api/personal/students/:studentId/{adherence,exercise-insights}', () => {
    let app: import('express').Express;
    let token: (userId: number, role?: 'user' | 'personal' | 'nutri' | 'admin', products?: string[]) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const personalInsightsRoutes = (await import('../routes/personalInsights')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      app = express();
      app.use(express.json());
      app.use('/api/personal', personalInsightsRoutes);

      token = (userId, role = 'personal', products = ['personal']) =>
        generateAccessToken({ id: userId, email: `${userId}@test.local`, role, profileCompleted: true, products });
    });

    it('GET /adherence responde 200 com buckets somando 100%', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);
      const ex = await insertExercise({ name: 'Supino Reto HTTP' });
      const sessionId = await insertSession({ userId: studentId, daysAgo: 1, prescribed: [item(ex, 'Supino Reto HTTP', '2')] });
      await insertSetLog({ sessionId, exerciseId: ex, exerciseName: 'Supino Reto HTTP', executionSource: 'prescribed', setIndex: 1 });
      await insertSetLog({ sessionId, exerciseId: ex, exerciseName: 'Supino Reto HTTP', executionSource: 'prescribed', setIndex: 2 });

      const res = await request(app)
        .get(`/api/personal/students/${studentId}/adherence?window=30`)
        .set('Authorization', `Bearer ${token(personalId)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.buckets.EXECUTADO_CONFORME_PRESCRITO.pct).toBe(100);
    });

    it('GET /exercise-insights responde 200 com lista vazia quando não há recorrência', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);

      const res = await request(app)
        .get(`/api/personal/students/${studentId}/exercise-insights`)
        .set('Authorization', `Bearer ${token(personalId)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.insights).toEqual([]);
    });

    it('personal sem vínculo recebe 403 nas três rotas de leitura', async () => {
      const request = (await import('supertest')).default;
      const { studentId } = await dupla();
      const semVinculo = await createUser(c, TAG, `http-sem-vinculo-${seq}`);
      const t = token(semVinculo);

      const r1 = await request(app).get(`/api/personal/students/${studentId}/adherence`).set('Authorization', `Bearer ${t}`);
      const r2 = await request(app).get(`/api/personal/students/${studentId}/exercise-insights`).set('Authorization', `Bearer ${t}`);
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
    });

    it('POST .../review com action=dismiss não altera nada e responde 200', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);
      const ex = await insertExercise({ name: 'Ex Dismiss' });

      const res = await request(app)
        .post(`/api/personal/students/${studentId}/exercise-insights/${ex}/review`)
        .set('Authorization', `Bearer ${token(personalId)}`)
        .send({ action: 'dismiss' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ applied: false, dismissed: true });
    });

    it('POST .../review com action=apply troca o exercício na ficha via HTTP ponta a ponta', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);
      const original = await insertExercise({ name: 'Remada Curvada HTTP' });
      const alvo = await insertExercise({ name: 'Remada Baixa HTTP' });
      await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha HTTP', weekPreset: '3',
        days: [{ name: 'Dia A', items: [item(original, 'Remada Curvada HTTP', '3')] }],
      });

      const res = await request(app)
        .post(`/api/personal/students/${studentId}/exercise-insights/${original}/review`)
        .set('Authorization', `Bearer ${token(personalId)}`)
        .send({ action: 'apply', targetExerciseId: alvo });

      expect(res.status).toBe(200);
      expect(res.body.data.applied).toBe(true);
      expect(res.body.data.plan.days[0].items[0].exerciseId).toBe(alvo);
    });

    it('POST .../review com Bi-Set responde 200 com requiresManualEdit — nunca quebra o par pelo HTTP', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);
      const parA = await insertExercise({ name: 'Supino BiSet HTTP' });
      const parB = await insertExercise({ name: 'Crucifixo BiSet HTTP' });
      const alvo = await insertExercise({ name: 'Halteres HTTP' });
      const groupId = (await import('crypto')).randomUUID();
      await planSvc.createPersonalWorkoutPlanWithDays(personalId, studentId, null, {
        title: 'Ficha Bi-Set HTTP', weekPreset: '3',
        days: [{
          name: 'Dia A',
          items: [
            item(parA, 'Supino BiSet HTTP', '3', { type: 'bi_set', biSetGroupId: groupId }),
            item(parB, 'Crucifixo BiSet HTTP', '3', { type: 'bi_set', biSetGroupId: groupId }),
          ],
        }],
      });

      const res = await request(app)
        .post(`/api/personal/students/${studentId}/exercise-insights/${parA}/review`)
        .set('Authorization', `Bearer ${token(personalId)}`)
        .send({ action: 'apply', targetExerciseId: alvo });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: false, requiresManualEdit: true, reason: 'BI_SET_MEMBER' });
    });

    it('POST .../review com targetExerciseId ausente responde 400', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      await grantWorkoutsConsent(studentId, personalId);
      const ex = await insertExercise({ name: 'Ex Sem Alvo' });

      const res = await request(app)
        .post(`/api/personal/students/${studentId}/exercise-insights/${ex}/review`)
        .set('Authorization', `Bearer ${token(personalId)}`)
        .send({ action: 'apply' });

      expect(res.status).toBe(400);
    });
  });
});
