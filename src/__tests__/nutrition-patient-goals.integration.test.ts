/**
 * Spec 039 — Metas diárias do paciente (S2CORE NUTRI P0).
 *
 * HTTP de ponta a ponta (supertest sobre os routers reais) porque o que
 * importa aqui só o caminho completo prova: a cadeia de autorização do
 * prefixo `/patients/:patientId` (produto + papel + vínculo + consent), a
 * validação na borda e a MESMA linha chegando ao aluno e ao diário.
 */
import type { Client } from 'pg';
import { acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const TAG = 'itest-nutri-goals';

describeWithDb('Spec 039 · metas diárias do paciente', () => {
  let c: Client;
  let app: import('express').Express;
  let request: typeof import('supertest');
  let nutriToken: (id: number) => string;
  let userToken: (id: number) => string;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);

    const express = (await import('express')).default;
    const nutriRoutes = (await import('../routes/nutri')).default;
    const userRoutes = (await import('../routes/user')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    request = (await import('supertest')).default;

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

  async function createStructuredPlan(nutriId: number, patientId: number) {
    const plan = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
       VALUES ($1, $2, 'Plano', 'maintenance', 'active') RETURNING id`,
      [nutriId, patientId]
    );
    // 4 refeições × (375 kcal, 37,5 P, 52,5 C, 17,5 G) = 1500 kcal, 150 P, 210 C, 70 G
    for (let i = 0; i < 4; i++) {
      const meal = await c.query<{ id: number }>(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [plan.rows[0].id, `Refeição ${i + 1}`, i]
      );
      await c.query(
        `INSERT INTO nutrition_meal_items
           (meal_id, food_id, quantity, unit_type, grams, food_name_snapshot,
            energy_kcal_snapshot, protein_g_snapshot, carbohydrate_g_snapshot, fat_g_snapshot)
         VALUES ($1, 1, 300, 'grams', 300, 'Arroz', 375, 37.5, 52.5, 17.5)`,
        [meal.rows[0].id]
      );
    }
    return plan.rows[0].id;
  }

  const FULL = {
    energyKcal: 2300,
    proteinMinG: 150,
    proteinMaxG: 170,
    fiberMinG: 30,
    fiberMaxG: 40,
    waterMinMl: 2500,
    waterMaxMl: 3000,
    objectives: ['weight_loss', 'metabolic_health'],
    patientNote: '  Ajustaremos as porções conforme a evolução.  ',
  };

  const putGoals = (nutriId: number, patientId: number, body: unknown) =>
    request(app).put(`/api/nutri/patients/${patientId}/nutrition-goals`).set('Authorization', `Bearer ${nutriToken(nutriId)}`).send(body as object);
  const getGoalsAsNutri = (nutriId: number, patientId: number) =>
    request(app).get(`/api/nutri/patients/${patientId}/nutrition-goals`).set('Authorization', `Bearer ${nutriToken(nutriId)}`);
  const getGoalsAsUser = (userId: number) =>
    request(app).get('/api/user/nutrition-goals').set('Authorization', `Bearer ${userToken(userId)}`);

  it('paciente sem meta: nutri e aluno recebem goals = null (nunca zero)', async () => {
    const { nutriId, patientId } = await dupla();
    const asNutri = await getGoalsAsNutri(nutriId, patientId);
    expect(asNutri.status).toBe(200);
    expect(asNutri.body.data.goals).toBeNull();
    const asUser = await getGoalsAsUser(patientId);
    expect(asUser.status).toBe(200);
    expect(asUser.body.data.goals).toBeNull();
  });

  it('nutri vinculado grava; nutri e aluno leem a MESMA meta, com nota normalizada e autor', async () => {
    const { nutriId, patientId } = await dupla();
    const put = await putGoals(nutriId, patientId, FULL);
    expect(put.status).toBe(200);
    expect(put.body.data.goals).toMatchObject({
      energyKcal: 2300, proteinMinG: 150, proteinMaxG: 170, fiberMinG: 30, fiberMaxG: 40,
      waterMinMl: 2500, waterMaxMl: 3000, objectives: ['weight_loss', 'metabolic_health'],
      patientNote: 'Ajustaremos as porções conforme a evolução.',
    });
    expect(put.body.data.goals.updatedByName).toMatch(/Fixture nutri/);

    const asNutri = await getGoalsAsNutri(nutriId, patientId);
    const asUser = await getGoalsAsUser(patientId);
    expect(asUser.body.data.goals).toEqual(asNutri.body.data.goals);
    expect(asUser.body.data.goals).toEqual(put.body.data.goals);

    const audit = await c.query(
      `SELECT event_type, event_payload FROM data_access_audit WHERE subject_user_id = $1 AND event_type LIKE 'nutri.goals.%' ORDER BY id`,
      [patientId]
    );
    expect(audit.rows.map((r) => r.event_type).sort()).toEqual(['nutri.goals.read', 'nutri.goals.updated']);
    // A trilha registra QUAIS campos mudaram, nunca os valores clínicos.
    const updated = audit.rows.find((r) => r.event_type === 'nutri.goals.updated');
    expect(updated.event_payload.fields).toContain('energyKcal');
    expect(JSON.stringify(updated.event_payload)).not.toContain('2300');
  });

  it('upsert idempotente: reenviar não duplica, e a segunda gravação substitui a primeira por inteiro', async () => {
    const { nutriId, patientId } = await dupla();
    await putGoals(nutriId, patientId, FULL);
    await putGoals(nutriId, patientId, FULL);
    const second = await putGoals(nutriId, patientId, { energyKcal: 2100 });
    expect(second.status).toBe(200);
    const rows = await c.query(`SELECT * FROM nutrition_patient_goals WHERE patient_id = $1`, [patientId]);
    expect(rows.rowCount).toBe(1);
    expect(second.body.data.goals).toMatchObject({ energyKcal: 2100, proteinMinG: null, waterMinMl: null, objectives: [], patientNote: null });
  });

  it('nutri sem vínculo com o paciente: 403 na leitura e na escrita, e nada é gravado', async () => {
    const { patientId } = await dupla();
    const intruso = await createUser(c, TAG, 'nutri-intruso');
    expect((await getGoalsAsNutri(intruso, patientId)).status).toBe(403);
    expect((await putGoals(intruso, patientId, FULL)).status).toBe(403);
    const rows = await c.query(`SELECT 1 FROM nutrition_patient_goals WHERE patient_id = $1`, [patientId]);
    expect(rows.rowCount).toBe(0);
  });

  it('consent `nutrition` revogado: 403 mesmo com vínculo ativo', async () => {
    const { nutriId, patientId } = await dupla({ scopes: ['profile'] });
    const res = await putGoals(nutriId, patientId, FULL);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('consent_required');
  });

  it('aluno não consegue gravar a meta pela rota do nutri (papel errado → 403)', async () => {
    const { patientId } = await dupla();
    const res = await request(app)
      .put(`/api/nutri/patients/${patientId}/nutrition-goals`)
      .set('Authorization', `Bearer ${userToken(patientId)}`)
      .send(FULL);
    expect(res.status).toBe(403);
  });

  it.each([
    ['faixa invertida', { proteinMinG: 170, proteinMaxG: 150 }, 'proteinMaxG'],
    ['máximo sem mínimo', { waterMaxMl: 3000 }, 'waterMinMl'],
    ['negativo', { energyKcal: -100 }, 'energyKcal'],
    ['acima do limite', { fiberMinG: 500 }, 'fiberMinG'],
    ['número como string', { energyKcal: '2300' }, 'energyKcal'],
    ['meta vazia', { patientNote: 'só nota' }, 'body'],
    ['objetivo fora do enum', { energyKcal: 2000, objectives: ['ldl'] }, 'objectives'],
    ['nota longa demais', { energyKcal: 2000, patientNote: 'x'.repeat(501) }, 'patientNote'],
  ])('validação: %s → 400 nomeando o campo', async (_label, body, field) => {
    const { nutriId, patientId } = await dupla();
    const res = await putGoals(nutriId, patientId, body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
    const rows = await c.query(`SELECT 1 FROM nutrition_patient_goals WHERE patient_id = $1`, [patientId]);
    expect(rows.rowCount).toBe(0);
  });

  it('meta independe do plano: existe sem plano e sobrevive a encerrar o plano', async () => {
    const { nutriId, patientId } = await dupla();
    expect((await putGoals(nutriId, patientId, FULL)).status).toBe(200);

    const planId = await createStructuredPlan(nutriId, patientId);
    await c.query(`UPDATE nutrition_plans SET status = 'ended', ended_at = NOW() WHERE id = $1`, [planId]);

    const asUser = await getGoalsAsUser(patientId);
    expect(asUser.body.data.goals).toMatchObject({ energyKcal: 2300, proteinMinG: 150 });
  });

  it('diário do aluno usa kcal e proteína prescritas; carboidrato e gordura seguem o plano', async () => {
    const { nutriId, patientId } = await dupla();
    await createStructuredPlan(nutriId, patientId);

    const before = await request(app).get('/api/user/nutrition-intake').set('Authorization', `Bearer ${userToken(patientId)}`);
    expect(before.status).toBe(200);
    expect(before.body.data.target).toMatchObject({ energyKcal: 1500, proteinG: 150, source: 'plan_items' });

    await putGoals(nutriId, patientId, { energyKcal: 2300, proteinMinG: 160, proteinMaxG: 180 });

    const after = await request(app).get('/api/user/nutrition-intake').set('Authorization', `Bearer ${userToken(patientId)}`);
    expect(after.body.data.target).toEqual({
      energyKcal: 2300, proteinG: 160, carbohydrateG: 210, fatG: 70, mealsPerDay: 4,
      source: 'nutri_goal', proteinRange: { minG: 160, maxG: 180 },
    });
    // O "planejado" do gráfico continua sendo a composição do plano, não a meta.
    const plannedKcal = after.body.data.plannedMeals.reduce((s: number, m: { energyKcal: number }) => s + m.energyKcal, 0);
    expect(plannedKcal).toBe(1500);

    const target = await request(app).get('/api/user/nutrition-target').set('Authorization', `Bearer ${userToken(patientId)}`);
    expect(target.body.data.target).toEqual(after.body.data.target);
    expect(target.body.data.nutriName).toMatch(/Fixture nutri/);
  });

  it('resumo de ingestão do nutri enxerga a mesma meta que o diário do aluno', async () => {
    const { nutriId, patientId } = await dupla();
    await putGoals(nutriId, patientId, { energyKcal: 2000 });
    await c.query(
      `INSERT INTO user_nutrition_intake_logs (user_id, date_key, label, energy_kcal, protein_g, carbohydrate_g, fat_g, items, confidence_score, source)
       VALUES ($1, $2, 'Almoço', 600, 40, 60, 20, '[]'::jsonb, 1, 'manual')`,
      [patientId, (await import('../utils/appDay')).dayKey()]
    );
    const res = await request(app)
      .get(`/api/nutri/patients/${patientId}/intake-summary`)
      .set('Authorization', `Bearer ${nutriToken(nutriId)}`);
    expect(res.status).toBe(200);
    // Sem plano e sem estimativa: só a kcal tem fonte; P/C/G ficam null, nunca 0.
    expect(res.body.data.summary.target).toEqual({ kcal: 2000, p: null, c: null, f: null, source: 'nutri_goal' });
  });

  it('nutri excluir a conta não apaga a meta do paciente (autor vira null)', async () => {
    const { nutriId, patientId } = await dupla();
    await putGoals(nutriId, patientId, FULL);
    await c.query(`DELETE FROM data_access_audit WHERE actor_id = $1`, [nutriId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [nutriId]);
    const asUser = await getGoalsAsUser(patientId);
    expect(asUser.body.data.goals).toMatchObject({ energyKcal: 2300, updatedByName: null });
  });
});
