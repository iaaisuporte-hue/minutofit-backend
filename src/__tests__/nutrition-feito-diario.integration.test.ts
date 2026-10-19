/**
 * P0 "Feito → diário" (out/2026). Adesão (check-in "Segui") e consumo
 * (diário) continuam SEPARADOS; o que entra é o registro integral explícito
 * da refeição do plano, com `onlyIfMealEmpty` decidido dentro da trava do
 * dia. HTTP real (supertest) porque a garantia de concorrência e a
 * separação só aparecem no caminho completo com banco.
 */
import type { Client } from 'pg';
import { acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const TAG = 'itest-feito-diario';

describeWithDb('P0 · Feito → diário (registro integral explícito da refeição do plano)', () => {
  let c: Client;
  let app: import('express').Express;
  let request: typeof import('supertest');
  let userToken: (id: number) => string;
  let nutriToken: (id: number) => string;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    const express = (await import('express')).default;
    const userRoutes = (await import('../routes/user')).default;
    const nutriRoutes = (await import('../routes/nutri')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    request = (await import('supertest')).default;
    app = express();
    app.use(express.json());
    app.use('/api/user', userRoutes);
    app.use('/api/nutri', nutriRoutes);
    userToken = (id) => generateAccessToken({ id, email: `${id}@test.local`, role: 'user', profileCompleted: true, products: ['app'] });
    nutriToken = (id) => generateAccessToken({ id, email: `${id}@test.local`, role: 'nutri', profileCompleted: true, products: ['nutri'] });
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  /**
   * Paciente com plano ativo: "Café da manhã" ESTRUTURADO (2 itens =
   * 300 kcal, 20 P, 40 C, 8 G) e "Lanche" SÓ TEXTO (sem itens).
   */
  async function scenario() {
    seq += 1;
    const nutriId = await createUser(c, TAG, `nutri-${seq}`);
    const patientId = await createUser(c, TAG, `paciente-${seq}`);
    await c.query(`INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`, [nutriId, patientId]);
    for (const scope of ['profile', 'nutrition']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'nutri', $3, 'granted')
         ON CONFLICT (user_id, professional_id, professional_role, scope) DO UPDATE SET status = 'granted'`,
        [patientId, nutriId, scope]
      );
    }
    const plan = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status) VALUES ($1, $2, 'Plano', 'maintenance', 'active') RETURNING id`,
      [nutriId, patientId]
    );
    const cafe = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index) VALUES ($1, 'Café da manhã', 'x', 0) RETURNING id`,
      [plan.rows[0].id]
    );
    const lanche = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index) VALUES ($1, 'Lanche', 'Uma fruta', 1) RETURNING id`,
      [plan.rows[0].id]
    );
    const itemIds: number[] = [];
    for (const [name, kcal, p, carb, f] of [['Pão', 200, 8, 36, 3], ['Ovo', 100, 12, 4, 5]] as const) {
      const r = await c.query<{ id: number }>(
        `INSERT INTO nutrition_meal_items
           (meal_id, food_id, quantity, unit_type, grams, food_name_snapshot,
            energy_kcal_snapshot, protein_g_snapshot, carbohydrate_g_snapshot, fat_g_snapshot)
         VALUES ($1, 1, 50, 'grams', 50, $2, $3, $4, $5, $6) RETURNING id`,
        [cafe.rows[0].id, name, kcal, p, carb, f]
      );
      itemIds.push(r.rows[0].id);
    }
    return { nutriId, patientId, cafeId: cafe.rows[0].id, lancheId: lanche.rows[0].id, itemIds };
  }

  const auth = (id: number) => ({ Authorization: `Bearer ${userToken(id)}` });
  const checkin = (userId: number, mealId: number, status: string) =>
    request(app).post(`/api/user/meals/${mealId}/checkins`).set(auth(userId)).send({ status });
  /** Exatamente o que o cliente envia em "Sim, registrar conforme o plano". */
  const confirmPlan = (userId: number, mealId: number, itemIds: number[]) =>
    request(app).post('/api/user/nutrition-intake').set(auth(userId)).send({
      label: 'Café da manhã',
      mealId,
      source: 'plan',
      onlyIfMealEmpty: true,
      items: itemIds.map((id) => ({ kind: 'plan', planMealItemId: id, clientKey: `plan-item:${id}` })),
    });
  const day = (userId: number) => request(app).get('/api/user/nutrition-intake').set(auth(userId));
  const timeline = (userId: number) => request(app).get('/api/user/meals/today').set(auth(userId));
  const countLogs = async (userId: number) =>
    Number((await c.query(`SELECT count(*) FROM user_nutrition_intake_logs WHERE user_id = $1 AND deleted_at IS NULL`, [userId])).rows[0].count);
  const countCheckins = async (userId: number) =>
    Number((await c.query(`SELECT count(*) FROM nutrition_meal_checkins WHERE patient_id = $1`, [userId])).rows[0].count);

  it('"Segui" registra só adesão: diário continua zerado e a timeline não marca consumo', async () => {
    const s = await scenario();
    expect((await checkin(s.patientId, s.cafeId, 'done')).status).toBe(201);
    const d = await day(s.patientId);
    expect(d.body.data.totals.energyKcal).toBe(0);
    expect(d.body.data.logs).toHaveLength(0);
    const t = await timeline(s.patientId);
    const cafe = t.body.data.meals.find((m: { id: number }) => m.id === s.cafeId);
    expect(cafe.status).toBe('done');
    expect(cafe.intakeToday).toBeNull();
  });

  it('"Sim, registrar conforme o plano": totais = itens prescritos; adesão intocada; timeline marca o consumo', async () => {
    const s = await scenario();
    await checkin(s.patientId, s.cafeId, 'done');
    const res = await confirmPlan(s.patientId, s.cafeId, s.itemIds);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ mealId: s.cafeId, energyKcal: 300, proteinG: 20, carbohydrateG: 40, fatG: 8 });

    const d = await day(s.patientId);
    expect(d.body.data.totals).toMatchObject({ energyKcal: 300, proteinG: 20, carbohydrateG: 40, fatG: 8 });
    expect(d.body.data.meals).toHaveLength(1);
    expect(await countCheckins(s.patientId)).toBe(1);

    const cafe = (await timeline(s.patientId)).body.data.meals.find((m: { id: number }) => m.id === s.cafeId);
    expect(cafe.intakeToday).toMatchObject({ energyKcal: 300 });
    expect(cafe.status).toBe('done');
  });

  it('repetir o registro integral é idempotente (mesmas chaves): uma linha, totais uma vez', async () => {
    const s = await scenario();
    expect((await confirmPlan(s.patientId, s.cafeId, s.itemIds)).status).toBe(201);
    const again = await confirmPlan(s.patientId, s.cafeId, s.itemIds);
    expect(again.status).toBe(201);
    expect(again.body.data.energyKcal).toBe(300);
    expect(await countLogs(s.patientId)).toBe(1);
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(300);
  });

  it('dois toques SIMULTÂNEOS no registro integral: uma linha, sem somar duas vezes', async () => {
    const s = await scenario();
    const results = await Promise.all([1, 2, 3].map(() => confirmPlan(s.patientId, s.cafeId, s.itemIds)));
    for (const r of results) expect(r.status).toBe(201);
    expect(await countLogs(s.patientId)).toBe(1);
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(300);
  });

  it('refeição já registrada à mão: registro integral recusado (409) devolvendo a linha; nada é somado', async () => {
    const s = await scenario();
    const manual = await request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
      label: 'Café da manhã', mealId: s.cafeId, source: 'manual',
      items: [{ kind: 'manual', name: 'Iogurte', grams: 170, energyKcal: 120, proteinG: 6, carbohydrateG: 15, fatG: 4, clientKey: 'manual-iogurte-1' }],
    });
    expect(manual.status).toBe(201);
    const res = await confirmPlan(s.patientId, s.cafeId, s.itemIds);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('meal_already_logged');
    expect(res.body.data).toMatchObject({ mealId: s.cafeId, energyKcal: 120 });
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(120);
  });

  it('registro integral + registro manual concorrentes: nunca soma o plano por cima do manual', async () => {
    const s = await scenario();
    const [a, b] = await Promise.all([
      confirmPlan(s.patientId, s.cafeId, s.itemIds),
      request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
        label: 'Café da manhã', mealId: s.cafeId, source: 'manual',
        items: [{ kind: 'manual', name: 'Iogurte', grams: 170, energyKcal: 120, proteinG: 6, carbohydrateG: 15, fatG: 4, clientKey: 'manual-iogurte-2' }],
      }),
    ]);
    expect(b.status).toBe(201);
    const total = (await day(s.patientId)).body.data.totals.energyKcal;
    if (a.status === 201) {
      // Plano entrou primeiro; o manual é acréscimo legítimo à MESMA refeição.
      expect(total).toBe(420);
    } else {
      expect(a.status).toBe(409);
      expect(total).toBe(120);
    }
    expect(await countLogs(s.patientId)).toBe(1);
  });

  it('acréscimo legítimo depois do registro integral continua permitido (não bloqueia registros adicionais)', async () => {
    const s = await scenario();
    await confirmPlan(s.patientId, s.cafeId, s.itemIds);
    const extra = await request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
      label: 'Café da manhã', mealId: s.cafeId, source: 'manual',
      items: [{ kind: 'manual', name: 'Café com leite', grams: 200, energyKcal: 80, proteinG: 4, carbohydrateG: 8, fatG: 3, clientKey: 'manual-cafe-1' }],
    });
    expect(extra.status).toBe(201);
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(380);
  });

  it('trocar o check-in (Segui → Pulei) não apaga consumo; apagar consumo não desfaz adesão', async () => {
    const s = await scenario();
    await checkin(s.patientId, s.cafeId, 'done');
    const log = (await confirmPlan(s.patientId, s.cafeId, s.itemIds)).body.data;

    expect((await checkin(s.patientId, s.cafeId, 'skipped')).status).toBe(200);
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(300);

    expect((await request(app).delete(`/api/user/nutrition-intake/${log.id}`).set(auth(s.patientId))).status).toBe(200);
    expect((await day(s.patientId)).body.data.totals.energyKcal).toBe(0);
    const st = await c.query(`SELECT status FROM nutrition_meal_checkins WHERE patient_id = $1 AND meal_id = $2`, [s.patientId, s.cafeId]);
    expect(st.rows[0].status).toBe('skipped');
  });

  it('registrar alimento não cria check-in', async () => {
    const s = await scenario();
    await confirmPlan(s.patientId, s.cafeId, s.itemIds);
    expect(await countCheckins(s.patientId)).toBe(0);
  });

  it('validação: onlyIfMealEmpty exige mealId e booleano; refeição/itens de outro paciente são recusados', async () => {
    const s = await scenario();
    const other = await scenario();
    const semMeal = await request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
      label: 'x', source: 'plan', onlyIfMealEmpty: true,
      items: [{ kind: 'plan', planMealItemId: s.itemIds[0], clientKey: 'k-1' }],
    });
    expect(semMeal.status).toBe(400);
    expect(semMeal.body.error).toBe('meal_required');

    const naoBool = await request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
      label: 'x', mealId: s.cafeId, source: 'plan', onlyIfMealEmpty: 'true',
      items: [{ kind: 'plan', planMealItemId: s.itemIds[0], clientKey: 'k-2' }],
    });
    expect(naoBool.status).toBe(400);

    // Refeição e itens do plano de OUTRO paciente.
    const alheio = await confirmPlan(s.patientId, other.cafeId, other.itemIds);
    expect(alheio.status).toBe(400);
    expect(await countLogs(s.patientId)).toBe(0);
  });

  it('refeição só texto: sem itens não há o que registrar (o cliente abre o registro manual)', async () => {
    const s = await scenario();
    const lanche = (await timeline(s.patientId)).body.data.meals.find((m: { id: number }) => m.id === s.lancheId);
    expect(lanche.items).toEqual([]);
    const res = await request(app).post('/api/user/nutrition-intake').set(auth(s.patientId)).send({
      label: 'Lanche', mealId: s.lancheId, source: 'plan', onlyIfMealEmpty: true, items: [],
    });
    expect(res.status).toBe(400);
  });

  it('nutri: vê o consumo de hoje no detalhe do dia e, fechado o dia, no resumo de 7 dias (regra existente)', async () => {
    const s = await scenario();
    const log = (await confirmPlan(s.patientId, s.cafeId, s.itemIds)).body.data;
    const nutriAuth = { Authorization: `Bearer ${nutriToken(s.nutriId)}` };

    const today = await request(app).get(`/api/nutri/patients/${s.patientId}/intake-logs`).set(nutriAuth);
    expect(today.status).toBe(200);
    expect(today.body.data.logs).toHaveLength(1);
    expect(today.body.data.logs[0]).toMatchObject({ mealId: s.cafeId, energyKcal: 300, source: 'plan' });

    // O resumo usa só dias FECHADOS (ontem..7d) — hoje está em andamento. Simula o fim do dia.
    await c.query(`UPDATE user_nutrition_intake_logs SET date_key = date_key - 1 WHERE id = $1`, [log.id]);
    const summary = await request(app).get(`/api/nutri/patients/${s.patientId}/intake-summary`).set(nutriAuth);
    expect(summary.status).toBe(200);
    expect(summary.body.data.summary.daysLogged7d).toBe(1);
    expect(summary.body.data.days[0]).toMatchObject({ totalKcal: 300, proteinG: 20 });
  });
});
