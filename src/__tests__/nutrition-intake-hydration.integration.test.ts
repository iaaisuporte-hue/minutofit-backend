/**
 * Alimentação Livre — Etapa 1 / cobertura: um registro composto SÓ por água (hidratação) não é refeição registrada e não
 * infla a cobertura. A classificação é por IDENTIDADE do item (manual + nome "água…" + zero energia/macros), nunca só por
 * "0 kcal". Mesma regra no lado do aluno (TS) e do nutri (SQL).
 */
import { connect, acquireSuiteLock, finishSuite, createUser, describeWithDb, hasTestDb } from './helpers/integrationDb';
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const WATER = { name: 'Água', grams: 200, energyKcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0, fiberG: 0, resolver: 'manual', confidence: 'high', confirmed: true, quantity: 200, unitLabel: 'ml' };
const BANANA = { name: 'Banana, prata, crua', grams: 70, energyKcal: 69, proteinG: 0.9, carbohydrateG: 18, fatG: 0.1, fiberG: 1, resolver: 'catalog', confidence: 'high', confirmed: true, foodId: 1 };
const CAFE = { name: 'Café, infusão 10%', grams: 120, energyKcal: 11, proteinG: 0.9, carbohydrateG: 1.8, fatG: 0.1, fiberG: null, resolver: 'catalog', confidence: 'high', confirmed: true, foodId: 2 };

// Import DINÂMICO (nunca estático): o pool de `config/database.ts` lê DATABASE_URL no import, e o override acima só vale
// antes dele — um `import` no topo seria hoisted e abriria conexão com o banco errado.
let isHydrationItem: typeof import('../services/nutritionIntakeService').isHydrationItem;
let isHydrationOnlyLog: typeof import('../services/nutritionIntakeService').isHydrationOnlyLog;
let summarizeDayLogs: typeof import('../services/nutritionIntakeService').summarizeDayLogs;
beforeAll(async () => {
  ({ isHydrationItem, isHydrationOnlyLog, summarizeDayLogs } = await import('../services/nutritionIntakeService'));
});

describe('isHydrationItem / isHydrationOnlyLog (unidade)', () => {
  it('água manual zerada é hidratação (com/sem acento, variantes da lista fechada)', () => {
    for (const name of ['Água', 'agua', 'ÁGUA', 'Água mineral', 'agua filtrada', 'Água gelada', 'Água natural']) {
      expect(isHydrationItem({ ...WATER, name })).toBe(true);
    }
  });
  it('NÃO é hidratação: água com calorias/macros, item de catálogo, outras bebidas de baixa energia, água de coco', () => {
    expect(isHydrationItem({ ...WATER, energyKcal: 5 })).toBe(false);
    expect(isHydrationItem({ ...WATER, carbohydrateG: 1 })).toBe(false);
    expect(isHydrationItem({ ...WATER, resolver: 'catalog' })).toBe(false);
    expect(isHydrationItem({ ...WATER, name: 'Chá' })).toBe(false); // 0 kcal sozinho NÃO basta
    expect(isHydrationItem({ ...WATER, name: 'Café sem açúcar' })).toBe(false);
    expect(isHydrationItem({ ...WATER, name: 'Coco, água de' })).toBe(false);
    expect(isHydrationItem(CAFE)).toBe(false);
  });
  it('log só de água = hidratação; água + alimento, vazio ou ausente = não', () => {
    expect(isHydrationOnlyLog([WATER, WATER])).toBe(true);
    expect(isHydrationOnlyLog([WATER, BANANA])).toBe(false);
    expect(isHydrationOnlyLog([])).toBe(false);
    expect(isHydrationOnlyLog(undefined)).toBe(false);
  });
  it('summarizeDayLogs: água isolada não conta; alimento de baixa energia conta; duplicata de linha da mesma refeição do plano conta 1', () => {
    const base = { confidenceScore: 1 };
    expect(summarizeDayLogs([{ ...base, id: 1, mealId: null, energyKcal: 0, items: [WATER] }]).loggedMeals).toBe(0);
    expect(summarizeDayLogs([{ ...base, id: 1, mealId: null, energyKcal: 0, items: [WATER] }, { ...base, id: 2, mealId: null, energyKcal: 11, items: [CAFE] }]).loggedMeals).toBe(1);
    expect(summarizeDayLogs([{ ...base, id: 1, mealId: 9, energyKcal: 69, items: [BANANA] }, { ...base, id: 2, mealId: 9, energyKcal: 11, items: [CAFE] }]).loggedMeals).toBe(1);
    // chamador sem `items` (só kcal/confiança): comportamento de sempre
    expect(summarizeDayLogs([{ ...base, energyKcal: 100 }, { ...base, energyKcal: 50 }]).loggedMeals).toBe(2);
  });
});

describeWithDb('cobertura sem hidratação isolada (banco real: aluno e nutri)', () => {
  let c: Client;
  let patientId: number;
  let app: import('express').Express;
  let nutriSvc: typeof import('../services/nutriService');
  let yesterday: string;

  const insert = async (items: unknown[], opts: { label?: string; mealId?: number | null; kcal?: number } = {}) => {
    const kcal = opts.kcal ?? (items as Array<{ energyKcal: number }>).reduce((s, i) => s + i.energyKcal, 0);
    const r = await c.query(
      `INSERT INTO user_nutrition_intake_logs
         (user_id, date_key, label, energy_kcal, protein_g, carbohydrate_g, fat_g, items, confidence_score, source, meal_id)
       VALUES ($1, $2, $3, $4, 1, 1, 1, $5::jsonb, 1, 'manual', $6) RETURNING id`,
      [patientId, yesterday, opts.label ?? 'Registro', kcal, JSON.stringify(items), opts.mealId ?? null]
    );
    return r.rows[0].id as number;
  };
  const sqlMeals = async () => (await nutriSvc.getIntakeDailyBreakdown(patientId)).days.find((d) => d.dateKey === yesterday)?.loggedMeals;
  const studentMeals = async () => {
    const request = (await import('supertest')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    const token = generateAccessToken({ id: patientId, email: `${patientId}@test.local`, role: 'user', profileCompleted: true, products: ['app'] } as never);
    const res = await request(app).get(`/api/user/nutrition-intake?date=${yesterday}`).set('Authorization', `Bearer ${token}`);
    return { coverage: res.body.data.coverage, totals: res.body.data.totals, meals: res.body.data.meals };
  };

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await c.query(`DELETE FROM users WHERE email LIKE $1`, ['nutrihyd-%@test.local']);
    patientId = await createUser(c, 'nutrihyd', 'aluno');
    const { dayKey, shiftDayKey } = await import('../utils/appDay');
    yesterday = shiftDayKey(dayKey(), -1);
    nutriSvc = await import('../services/nutriService');
    const express = (await import('express')).default;
    const userRoutes = (await import('../routes/user')).default;
    app = express();
    app.use(express.json());
    app.use('/api/user', userRoutes);
  });
  afterAll(async () => {
    await finishSuite(c, async () => {
      await c.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
      await c.query(`DELETE FROM users WHERE email LIKE $1`, ['nutrihyd-%@test.local']);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });
  afterEach(async () => {
    await c.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
  });

  it('água isolada: 0 refeições (aluno e nutri); o registro segue visível e nos totais (0 kcal)', async () => {
    await insert([WATER], { label: 'Hidratação' });
    expect(await sqlMeals()).toBe(0);
    const s = await studentMeals();
    expect(s.coverage.loggedMeals).toBe(0);
    expect(s.meals).toHaveLength(1); // continua listado
    expect(s.totals.energyKcal).toBe(0);
  });

  it('alimento energético livre conta; água ao lado NÃO elimina nem duplica o alimento', async () => {
    await insert([BANANA], { label: 'Lanche da tarde' });
    await insert([WATER], { label: 'Hidratação' });
    expect(await sqlMeals()).toBe(1);
    expect((await studentMeals()).coverage.loggedMeals).toBe(1);
  });

  it('água + alimento NO MESMO registro: 1 refeição (o registro alimentar válido é preservado)', async () => {
    await insert([WATER, BANANA], { label: 'Lanche' });
    expect(await sqlMeals()).toBe(1);
    expect((await studentMeals()).coverage.loggedMeals).toBe(1);
  });

  it('alimento de baixa energia (café 11 kcal) NÃO é descartado por ter poucas calorias', async () => {
    await insert([CAFE], { label: 'Café' });
    expect(await sqlMeals()).toBe(1);
    expect((await studentMeals()).coverage.loggedMeals).toBe(1);
  });

  it('item manual chamado "Água" mas COM calorias, ou "Chá" a 0 kcal: contam (0 kcal sozinho não é critério)', async () => {
    await insert([{ ...WATER, energyKcal: 12, carbohydrateG: 3 }], { label: 'Água saborizada' });
    await insert([{ ...WATER, name: 'Chá' }], { label: 'Chá' });
    expect(await sqlMeals()).toBe(2);
    expect((await studentMeals()).coverage.loggedMeals).toBe(2);
  });

  it('duas águas e uma refeição do plano em 2 linhas legadas: conta 1 (sem inflar)', async () => {
    const plan = await c.query(`INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status) VALUES ($1, $1, 'p', 'maintenance', 'active') RETURNING id`, [patientId]);
    const meal = await c.query(`INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Café', 'x') RETURNING id`, [plan.rows[0].id]);
    try {
      await insert([WATER], { label: 'a' });
      await insert([WATER], { label: 'b' });
      await insert([BANANA], { label: 'Café', mealId: meal.rows[0].id });
      await insert([CAFE], { label: 'Café', mealId: meal.rows[0].id });
      expect(await sqlMeals()).toBe(1);
      expect((await studentMeals()).coverage.loggedMeals).toBe(1);
    } finally {
      await c.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
      await c.query(`DELETE FROM nutrition_plans WHERE id = $1`, [plan.rows[0].id]);
    }
  });

  it('TS (aluno) e SQL (nutri) concordam no mesmo dia misto', async () => {
    await insert([WATER], { label: 'x' });
    await insert([BANANA], { label: 'y' });
    await insert([WATER, CAFE], { label: 'z' });
    await insert([{ ...WATER, name: 'Água mineral' }], { label: 'w' });
    expect(await sqlMeals()).toBe(2);
    expect((await studentMeals()).coverage.loggedMeals).toBe(2);
  });
});
