/**
 * Autorização da visão do personal sobre a performance do aluno
 * (Spec 033, Onda P5) com banco real.
 *
 * A P5 abre para o personal um dado que até aqui era só do aluno. As duas
 * barreiras que autorizam essa leitura moram em lugares diferentes — o VÍNCULO
 * no serviço, o CONSENTIMENTO no middleware da rota — e por isso são exercitadas
 * separadamente aqui: o vínculo por `getStudentPerformanceSnapshot`, o consent
 * por `hasActiveConsent`. Testar as duas com mock seria testar o mock; o que
 * decide quem enxerga quem é uma linha no Postgres.
 *
 * Como rodar:
 *   TEST_DATABASE_URL=postgresql://... npm test
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

const TAG = 'itest-p5';

describeWithDb('Performance P5 · Autorização da visão do personal', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
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

  /**
   * Vínculo personal↔aluno.
   *
   * `academy_id` NULL é o caso do personal autônomo, que é o cenário-alvo da
   * V1 — e é justamente onde o isolamento não pode se apoiar em tenant algum:
   * quem separa uma carteira da outra é só o `personal_id`.
   */
  async function assign(
    personalId: number,
    studentId: number,
    status: 'active' | 'inactive' = 'active',
  ): Promise<void> {
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id)
       VALUES ($1, $2, $3, NULL)`,
      [personalId, studentId, status],
    );
  }

  async function grantWorkoutsConsent(studentId: number, personalId: number): Promise<void> {
    await c.query(
      `INSERT INTO user_data_consents
         (user_id, professional_id, professional_role, scope, status, granted_at)
       VALUES ($1, $2, 'personal', 'workouts', 'granted', NOW())`,
      [studentId, personalId],
    );
  }

  /** Recorde de carga no ledger — mesma fonte que a aba Recordes do aluno lê. */
  async function recordPr(userId: number, exerciseId: string, name: string, value: number): Promise<void> {
    await c.query(
      `INSERT INTO user_pr_events
         (user_id, exercise_id, exercise_name, kind, value, reps, load_kg, is_first, achieved_at, formula_version)
       VALUES ($1, $2::uuid, $3, 'max_load', $4, 5, $4, false, NOW(), 1)`,
      [userId, exerciseId, name, value],
    );
  }

  // Carteiras: A com dois alunos, B com um. É o mínimo para provar que o corte
  // é por personal e não "por ter algum aluno".
  let personalA: number;
  let personalB: number;
  let aluno1: number;
  let aluno2: number;
  let aluno3: number;

  beforeAll(async () => {
    personalA = await createUser(c, TAG, 'personal-a');
    personalB = await createUser(c, TAG, 'personal-b');
    aluno1 = await createUser(c, TAG, 'aluno1');
    aluno2 = await createUser(c, TAG, 'aluno2');
    aluno3 = await createUser(c, TAG, 'aluno3');

    await assign(personalA, aluno1);
    await assign(personalA, aluno2);
    await assign(personalB, aluno3);
    await grantWorkoutsConsent(aluno1, personalA);
    await grantWorkoutsConsent(aluno2, personalA);
    await grantWorkoutsConsent(aluno3, personalB);
  });

  // ── Vínculo ───────────────────────────────────────────────────────────────

  it('personal com vínculo ativo recebe fatos, sinais e hash do aluno', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    const snap = await getStudentPerformanceSnapshot(personalA, aluno1);

    expect(snap.studentId).toBe(aluno1);
    expect(snap.facts).toBeDefined();
    expect(Array.isArray(snap.signals)).toBe(true);
    expect(typeof snap.snapshotHash).toBe('string');
    expect(snap.snapshotHash.length).toBeGreaterThan(0);
    // Fato, sinal e síntese são blocos separados: o texto só é preenchido pelo
    // endpoint de IA, nunca aqui.
    expect(snap.aiSummary).toBeNull();
  });

  it('personal sem vínculo algum com o aluno recebe 403 ASSIGNMENT_REQUIRED', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    const semCarteira = await createUser(c, TAG, 'personal-sem-vinculo');

    await expect(getStudentPerformanceSnapshot(semCarteira, aluno1)).rejects.toMatchObject({
      status: 403,
      code: 'ASSIGNMENT_REQUIRED',
    });
  });

  it('personal B não lê aluno de A', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    await expect(getStudentPerformanceSnapshot(personalB, aluno1)).rejects.toMatchObject({
      status: 403,
      code: 'ASSIGNMENT_REQUIRED',
    });
  });

  it('personal A não lê aluno de B', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    await expect(getStudentPerformanceSnapshot(personalA, aluno3)).rejects.toMatchObject({
      status: 403,
      code: 'ASSIGNMENT_REQUIRED',
    });
  });

  it('desvínculo corta o acesso: vínculo inativo já não autoriza', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    const exAluno = await createUser(c, TAG, 'ex-aluno');
    await assign(personalA, exAluno, 'inactive');
    // O consent continua concedido de propósito: é o vínculo, sozinho, que tem
    // de fechar a porta — senão um ex-aluno que nunca revogou seguiria visível.
    await grantWorkoutsConsent(exAluno, personalA);

    await expect(getStudentPerformanceSnapshot(personalA, exAluno)).rejects.toMatchObject({
      status: 403,
      code: 'ASSIGNMENT_REQUIRED',
    });
  });

  // ── Consentimento ─────────────────────────────────────────────────────────

  it('revogar o escopo workouts derruba o consent na chamada seguinte', async () => {
    const { hasActiveConsent, revokeConsent } = await import('../services/consentService');

    const aluno = await createUser(c, TAG, 'consent');
    await assign(personalA, aluno);
    await grantWorkoutsConsent(aluno, personalA);

    expect(await hasActiveConsent(aluno, personalA, 'personal', 'workouts')).toBe(true);

    // Revogação pelo caminho de produção: marcar só `revoked_at` não bastaria —
    // quem decide a leitura é `status`, e as duas colunas precisam andar juntas.
    await revokeConsent(aluno, personalA, 'personal', 'workouts');

    expect(await hasActiveConsent(aluno, personalA, 'personal', 'workouts')).toBe(false);
    const { rows } = await c.query(
      `SELECT status, revoked_at FROM user_data_consents
        WHERE user_id = $1 AND professional_id = $2 AND scope = 'workouts'`,
      [aluno, personalA],
    );
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].revoked_at).not.toBeNull();

    // O vínculo sobrevive à revogação: são autorizações independentes, e é o
    // middleware da rota que barra a leitura a partir daqui.
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');
    await expect(getStudentPerformanceSnapshot(personalA, aluno)).resolves.toBeDefined();
  });

  // ── Cardinalidade ─────────────────────────────────────────────────────────

  it('snapshot de um aluno não traz dado do outro aluno da mesma carteira', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    const exDoUm = await createExercise(c, TAG, 'Supino do aluno 1');
    const exDoDois = await createExercise(c, TAG, 'Levantamento do aluno 2');
    await recordPr(aluno1, exDoUm, 'Supino do aluno 1', 80);
    await recordPr(aluno2, exDoDois, 'Levantamento do aluno 2', 120);

    const snap = await getStudentPerformanceSnapshot(personalA, aluno1);

    // Com o recorde próprio presente, a ausência do outro é informação — e não
    // apenas uma lista vazia que passaria de qualquer jeito.
    expect(snap.facts.recentPrs.some((p) => p.exerciseId === exDoUm)).toBe(true);
    expect(snap.facts.recentPrs.some((p) => p.exerciseId === exDoDois)).toBe(false);
    expect(snap.facts.recentPrs.some((p) => p.exerciseName === 'Levantamento do aluno 2')).toBe(false);
  });

  // ── Ausência de dado ──────────────────────────────────────────────────────

  it('aluno sem histórico devolve nulo, não zero', async () => {
    const { getStudentPerformanceSnapshot } =
      await import('../modules/performance/personalPerformance.service');

    const novato = await createUser(c, TAG, 'novato');
    await assign(personalA, novato);

    const snap = await getStudentPerformanceSnapshot(personalA, novato);

    // Conta nova está calibrando: afirmar "score 0" seria dizer ao personal que
    // o aluno está mal, quando o que existe é falta de história.
    expect(snap.facts.score).toBeNull();
    expect(snap.facts.scoreStatus).toBe('onboarding');
    expect(snap.facts.recentPrs).toEqual([]);
    expect(snap.facts.goals).toEqual([]);
  });
});
