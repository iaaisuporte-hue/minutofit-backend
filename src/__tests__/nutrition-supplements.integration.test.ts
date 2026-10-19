/**
 * Spec 040 — Suplementação nutricional (S2CORE NUTRI P1).
 *
 * HTTP de ponta a ponta (supertest sobre os routers reais): a cadeia de
 * autorização do nutri (produto + papel + vínculo + consent + dono do id),
 * a máquina de status, o registro de uso do aluno e — o ponto que só o
 * banco prova — que o uso NUNCA vira linha no diário alimentar.
 */
import type { Client } from 'pg';
import { acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const TAG = 'itest-nutri-supp';

describeWithDb('Spec 040 · suplementação nutricional', () => {
  let c: Client;
  let app: import('express').Express;
  let request: typeof import('supertest');
  let nutriToken: (id: number) => string;
  let userToken: (id: number) => string;
  let appDay: typeof import('../utils/appDay');

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);

    const express = (await import('express')).default;
    const nutriRoutes = (await import('../routes/nutri')).default;
    const userRoutes = (await import('../routes/user')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    request = (await import('supertest')).default;
    appDay = await import('../utils/appDay');

    app = express();
    app.use(express.json());
    app.use('/api/nutri', nutriRoutes);
    app.use('/api/user', userRoutes);

    nutriToken = (id) =>
      generateAccessToken({ id, email: `${id}@test.local`, role: 'nutri', profileCompleted: true, products: ['nutri'] });
    userToken = (id) =>
      generateAccessToken({ id, email: `${id}@test.local`, role: 'user', profileCompleted: true, products: ['app'] });
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  async function dupla(opts: { scopes?: string[] } = {}): Promise<{ nutriId: number; patientId: number }> {
    seq += 1;
    const nutriId = await createUser(c, TAG, `nutri-${seq}`);
    const patientId = await createUser(c, TAG, `paciente-${seq}`);
    await c.query(`INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`, [nutriId, patientId]);
    for (const scope of opts.scopes ?? ['profile', 'nutrition']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'nutri', $3, 'granted')
         ON CONFLICT (user_id, professional_id, professional_role, scope) DO UPDATE SET status = 'granted'`,
        [patientId, nutriId, scope]
      );
    }
    return { nutriId, patientId };
  }

  const CREATINA = {
    name: 'Creatina monohidratada',
    doseAmount: 5,
    doseUnit: 'g',
    frequency: 'daily',
    timing: 'Junto com o almoço',
    purpose: 'Suporte ao treino de força',
    notes: 'Beber água ao longo do dia.',
    startDate: '2026-10-01',
  };

  const nutri = (nutriId: number) => ({
    list: (patientId: number) =>
      request(app).get(`/api/nutri/patients/${patientId}/supplements`).set('Authorization', `Bearer ${nutriToken(nutriId)}`),
    create: (patientId: number, body: unknown) =>
      request(app).post(`/api/nutri/patients/${patientId}/supplements`).set('Authorization', `Bearer ${nutriToken(nutriId)}`).send(body as object),
    patch: (patientId: number, id: number, body: unknown) =>
      request(app).patch(`/api/nutri/patients/${patientId}/supplements/${id}`).set('Authorization', `Bearer ${nutriToken(nutriId)}`).send(body as object),
  });
  const student = (userId: number) => ({
    get: () => request(app).get('/api/user/supplements').set('Authorization', `Bearer ${userToken(userId)}`),
    use: (id: number, body: unknown = {}) =>
      request(app).post(`/api/user/supplements/${id}/usage`).set('Authorization', `Bearer ${userToken(userId)}`).send(body as object),
    undo: (logId: number) =>
      request(app).delete(`/api/user/supplements/usage/${logId}`).set('Authorization', `Bearer ${userToken(userId)}`),
  });

  async function insertUsage(supplementId: number, patientId: number, daysAgo: number) {
    const dateKey = appDay.shiftDayKey(appDay.dayKey(), -daysAgo);
    await c.query(
      `INSERT INTO nutrition_supplement_usage_logs (prescription_id, patient_id, date_key, taken_at)
       VALUES ($1, $2, $3, ($3::date + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo')`,
      [supplementId, patientId, dateKey]
    );
  }

  it('nutri cria; aluno vê a mesma orientação ativa; nenhuma dose é inventada', async () => {
    const { nutriId, patientId } = await dupla();
    const created = await nutri(nutriId).create(patientId, CREATINA);
    expect(created.status).toBe(201);
    expect(created.body.data.supplement).toMatchObject({
      name: 'Creatina monohidratada', doseAmount: 5, doseUnit: 'g', frequency: 'daily',
      timing: 'Junto com o almoço', startDate: '2026-10-01', endDate: null, status: 'active',
    });
    expect(created.body.data.supplement.updatedByName).toMatch(/Fixture nutri/);

    const asStudent = await student(patientId).get();
    expect(asStudent.status).toBe(200);
    expect(asStudent.body.data.supplements).toHaveLength(1);
    expect(asStudent.body.data.supplements[0]).toMatchObject({ id: created.body.data.supplement.id, doseAmount: 5, usedTodayCount: 0 });
    expect(asStudent.body.data.recentLogs).toEqual([]);
  });

  it('edição parcial preserva os demais campos; suspender some da lista do aluno; reativar volta', async () => {
    const { nutriId, patientId } = await dupla();
    const id = (await nutri(nutriId).create(patientId, CREATINA)).body.data.supplement.id;

    const edited = await nutri(nutriId).patch(patientId, id, { doseAmount: 3, notes: null });
    expect(edited.status).toBe(200);
    expect(edited.body.data.supplement).toMatchObject({ doseAmount: 3, notes: null, name: 'Creatina monohidratada', timing: 'Junto com o almoço' });

    const suspended = await nutri(nutriId).patch(patientId, id, { status: 'suspended' });
    expect(suspended.body.data.supplement.status).toBe('suspended');
    expect(suspended.body.data.supplement.statusChangedAt).not.toBeNull();
    expect((await student(patientId).get()).body.data.supplements).toEqual([]);

    await nutri(nutriId).patch(patientId, id, { status: 'active' });
    expect((await student(patientId).get()).body.data.supplements).toHaveLength(1);
  });

  it('encerrada é terminal: nem edição nem reativação (409); continua listada para o nutri', async () => {
    const { nutriId, patientId } = await dupla();
    const id = (await nutri(nutriId).create(patientId, CREATINA)).body.data.supplement.id;
    expect((await nutri(nutriId).patch(patientId, id, { status: 'ended' })).status).toBe(200);
    expect((await nutri(nutriId).patch(patientId, id, { status: 'active' })).status).toBe(409);
    expect((await nutri(nutriId).patch(patientId, id, { doseAmount: 10 })).status).toBe(409);
    const list = await nutri(nutriId).list(patientId);
    expect(list.body.data.supplements.map((s: { status: string }) => s.status)).toEqual(['ended']);
  });

  it.each([
    ['dose zero', { ...CREATINA, doseAmount: 0 }, 'doseAmount'],
    ['dose como string', { ...CREATINA, doseAmount: '5' }, 'doseAmount'],
    ['unidade fora do enum', { ...CREATINA, doseUnit: 'colher' }, 'doseUnit'],
    ['frequência fora do enum', { ...CREATINA, frequency: 'sempre' }, 'frequency'],
    ['sem nome', { ...CREATINA, name: '   ' }, 'name'],
    ['fim antes do início', { ...CREATINA, endDate: '2026-09-01' }, 'endDate'],
    ['data inexistente', { ...CREATINA, startDate: '2026-02-31' }, 'startDate'],
    ['observação longa', { ...CREATINA, notes: 'x'.repeat(1001) }, 'notes'],
  ])('validação na criação: %s → 400 nomeando o campo', async (_l, body, field) => {
    const { nutriId, patientId } = await dupla();
    const res = await nutri(nutriId).create(patientId, body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
  });

  it('edição que inverte as datas contra o valor salvo → 400', async () => {
    const { nutriId, patientId } = await dupla();
    const id = (await nutri(nutriId).create(patientId, CREATINA)).body.data.supplement.id;
    const res = await nutri(nutriId).patch(patientId, id, { endDate: '2026-09-15' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('endDate');
  });

  it('autorização: sem vínculo 403, sem consent 403, aluno na rota do nutri 403, id de outro paciente 404', async () => {
    const a = await dupla();
    const b = await dupla();
    const idA = (await nutri(a.nutriId).create(a.patientId, CREATINA)).body.data.supplement.id;

    expect((await nutri(b.nutriId).list(a.patientId)).status).toBe(403);
    expect((await nutri(b.nutriId).create(a.patientId, CREATINA)).status).toBe(403);

    const semConsent = await dupla({ scopes: ['profile'] });
    const r = await nutri(semConsent.nutriId).create(semConsent.patientId, CREATINA);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('consent_required');

    const alunoComoNutri = await request(app)
      .post(`/api/nutri/patients/${a.patientId}/supplements`)
      .set('Authorization', `Bearer ${userToken(a.patientId)}`)
      .send(CREATINA);
    expect(alunoComoNutri.status).toBe(403);

    // Nutri B é dono do paciente B, mas tenta alterar a orientação do paciente A pelo id.
    const cross = await nutri(b.nutriId).patch(b.patientId, idA, { status: 'ended' });
    expect(cross.status).toBe(404);
    const still = await c.query(`SELECT status FROM nutrition_supplement_prescriptions WHERE id = $1`, [idA]);
    expect(still.rows[0].status).toBe('active');
  });

  it('aluno registra uso: aparece no dia, idempotente por clientKey, e NUNCA entra no diário alimentar', async () => {
    const { nutriId, patientId } = await dupla();
    const id = (await nutri(nutriId).create(patientId, CREATINA)).body.data.supplement.id;

    const first = await student(patientId).use(id, { clientKey: 'tap-abc-12345', note: 'Depois do almoço' });
    expect(first.status).toBe(201);
    const retry = await student(patientId).use(id, { clientKey: 'tap-abc-12345' });
    expect(retry.status).toBe(200);
    expect(retry.body.data.log.id).toBe(first.body.data.log.id);

    const view = await student(patientId).get();
    expect(view.body.data.supplements[0].usedTodayCount).toBe(1);
    expect(view.body.data.recentLogs).toHaveLength(1);
    expect(view.body.data.recentLogs[0]).toMatchObject({ supplementName: 'Creatina monohidratada', note: 'Depois do almoço', dateKey: appDay.dayKey() });

    const diary = await c.query(`SELECT COUNT(*)::int AS n FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
    expect(diary.rows[0].n).toBe(0);
  });

  it('aluno não registra uso de orientação suspensa (409) nem de outro paciente (404)', async () => {
    const a = await dupla();
    const b = await dupla();
    const idA = (await nutri(a.nutriId).create(a.patientId, CREATINA)).body.data.supplement.id;
    await nutri(a.nutriId).patch(a.patientId, idA, { status: 'suspended' });
    expect((await student(a.patientId).use(idA)).status).toBe(409);
    expect((await student(b.patientId).use(idA)).status).toBe(404);
  });

  it('desfazer: só o próprio registro e só de hoje', async () => {
    const a = await dupla();
    const b = await dupla();
    const id = (await nutri(a.nutriId).create(a.patientId, CREATINA)).body.data.supplement.id;
    const logId = (await student(a.patientId).use(id)).body.data.log.id;

    expect((await student(b.patientId).undo(logId)).status).toBe(404);
    expect((await student(a.patientId).undo(logId)).status).toBe(200);
    expect((await student(a.patientId).get()).body.data.supplements[0].usedTodayCount).toBe(0);

    await insertUsage(id, a.patientId, 2);
    const old = await c.query(`SELECT id FROM nutrition_supplement_usage_logs WHERE prescription_id = $1 AND deleted_at IS NULL`, [id]);
    expect((await student(a.patientId).undo(old.rows[0].id)).status).toBe(403);
  });

  it('nutri vê último uso e contagem de 7 dias por orientação (dentro/fora da janela, múltiplos, sem registro)', async () => {
    const { nutriId, patientId } = await dupla();
    const creatina = (await nutri(nutriId).create(patientId, CREATINA)).body.data.supplement.id;
    const vitD = (await nutri(nutriId).create(patientId, { name: 'Vitamina D3', doseAmount: 2000, doseUnit: 'ui', frequency: 'daily' })).body.data.supplement.id;
    const omega = (await nutri(nutriId).create(patientId, { name: 'Ômega 3', doseAmount: 2, doseUnit: 'capsule', frequency: 'twice_daily' })).body.data.supplement.id;

    await insertUsage(creatina, patientId, 0);
    await insertUsage(creatina, patientId, 3);
    await insertUsage(creatina, patientId, 6);  // borda: ainda dentro dos 7 dias
    await insertUsage(creatina, patientId, 7);  // fora da janela
    await insertUsage(vitD, patientId, 10);     // só fora da janela

    const res = await nutri(nutriId).list(patientId);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.supplements.map((s: { id: number }) => [s.id, s]));
    expect((byId.get(creatina) as any).usage.count7d).toBe(3);
    expect((byId.get(creatina) as any).usage.lastUsedAt).not.toBeNull();
    expect((byId.get(vitD) as any).usage).toMatchObject({ count7d: 0 });
    expect((byId.get(vitD) as any).usage.lastUsedAt).not.toBeNull();
    expect((byId.get(omega) as any).usage).toEqual({ lastUsedAt: null, count7d: 0 });

    // Uso desfeito não conta.
    const todayLog = await c.query(
      `SELECT id FROM nutrition_supplement_usage_logs WHERE prescription_id = $1 AND date_key = $2`,
      [creatina, appDay.dayKey()]
    );
    await student(patientId).undo(todayLog.rows[0].id);
    const after = await nutri(nutriId).list(patientId);
    expect(after.body.data.supplements.find((s: { id: number }) => s.id === creatina).usage.count7d).toBe(2);

    const audit = await c.query(
      `SELECT event_payload FROM data_access_audit WHERE subject_user_id = $1 AND event_type LIKE 'nutri.supplements.%'`,
      [patientId]
    );
    // Trilha sem nome/dose do suplemento.
    expect(JSON.stringify(audit.rows)).not.toMatch(/Creatina|Vitamina|2000/);
  });

  it('nutri excluir a conta não apaga a orientação do paciente', async () => {
    const { nutriId, patientId } = await dupla();
    await nutri(nutriId).create(patientId, CREATINA);
    await c.query(`DELETE FROM users WHERE id = $1`, [nutriId]);
    const view = await student(patientId).get();
    expect(view.body.data.supplements).toHaveLength(1);
    expect(view.body.data.supplements[0].updatedByName).toBeNull();
  });
});
