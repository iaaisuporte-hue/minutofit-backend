/**
 * PLAN_NUTRITION_QUICK_MACROS (P1C) — `getPatientsWithSummary` ganha o
 * campo `intake`, alimentado por UMA query agrupada de 14 dias (nunca
 * N+1) + a mesma `resolveNutritionTarget` do lado do aluno (plano vence
 * sobre estimativa própria). Testes de integração com banco real: o que só
 * o Postgres prova aqui é o JOIN de 3 tabelas (plano → refeições → itens)
 * e o agrupamento por `date_key` batendo com `deriveIntakeSignal`.
 */
import type { Client } from 'pg';
import { acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(60_000);

const TAG = 'itest-nutrip1c';

type NutriSvc = typeof import('../services/nutriService');
type AppDay = typeof import('../utils/appDay');

describeWithDb('PLAN_NUTRITION_QUICK_MACROS (P1C) · getPatientsWithSummary.intake', () => {
  let c: Client;
  let svc: NutriSvc;
  let appDay: AppDay;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    svc = await import('../services/nutriService');
    appDay = await import('../utils/appDay');
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  async function dupla(): Promise<{ nutriId: number; patientId: number }> {
    seq += 1;
    const nutriId = await createUser(c, TAG, `nutri-${seq}`);
    const patientId = await createUser(c, TAG, `paciente-${seq}`);
    await c.query(`INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`, [nutriId, patientId]);
    return { nutriId, patientId };
  }

  async function grantConsent(nutriId: number, patientId: number, scopes: string[]) {
    for (const scope of scopes) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'nutri', $3, 'granted')
         ON CONFLICT (user_id, professional_id, professional_role, scope) DO UPDATE SET status = 'granted'`,
        [patientId, nutriId, scope]
      );
    }
  }
  const ALL_SCOPES = ['profile', 'nutrition'];

  async function createStructuredPlan(nutriId: number, patientId: number, objective = 'maintenance', mealCount = 4) {
    const plan = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status, started_at)
       VALUES ($1, $2, 'Plano', $3, 'active', NOW() - INTERVAL '30 days') RETURNING id`,
      [nutriId, patientId, objective]
    );
    const planId = plan.rows[0].id;
    for (let i = 0; i < mealCount; i++) {
      const meal = await c.query<{ id: number }>(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [planId, `Refeição ${i + 1}`, i]
      );
      await c.query(
        `INSERT INTO nutrition_meal_items
           (meal_id, food_id, quantity, unit_type, grams, food_name_snapshot,
            energy_kcal_snapshot, protein_g_snapshot, carbohydrate_g_snapshot, fat_g_snapshot)
         VALUES ($1, 1, 300, 'grams', 300, 'Arroz', 375, 37.5, 52.5, 17.5)`,
        [meal.rows[0].id]
      );
    }
    return planId;
  }

  async function insertIntakeDay(patientId: number, daysAgo: number, opts: { kcal: number; protein: number; loggedMeals?: number; confidence?: number }) {
    const dateKey = appDay.shiftDayKey(appDay.dayKey(), -daysAgo);
    const loggedMeals = opts.loggedMeals ?? 4;
    const perMealKcal = opts.kcal / loggedMeals;
    const perMealProtein = opts.protein / loggedMeals;
    for (let i = 0; i < loggedMeals; i++) {
      await c.query(
        `INSERT INTO user_nutrition_intake_logs
           (user_id, date_key, label, energy_kcal, protein_g, carbohydrate_g, fat_g, items, confidence_score, source)
         VALUES ($1, $2, 'Refeição', $3, $4, 10, 5, '[]'::jsonb, $5, 'manual')`,
        [patientId, dateKey, perMealKcal, perMealProtein, opts.confidence ?? 1]
      );
    }
  }

  it('sem logs e sem meta: intake.state = none', async () => {
    const { nutriId, patientId } = await dupla();
    await grantConsent(nutriId, patientId, ALL_SCOPES);

    const [summary] = await svc.getPatientsWithSummary(nutriId);
    expect(summary.intake?.state).toBe('none');
    expect(summary.intake?.exception).toBeNull();
  });

  it('plano estruturado + 7 dias de alta cobertura ~100%: ready, meta vem do plano, sem exceção', async () => {
    const { nutriId, patientId } = await dupla();
    await grantConsent(nutriId, patientId, ALL_SCOPES);
    await createStructuredPlan(nutriId, patientId);

    for (let d = 0; d < 7; d++) {
      await insertIntakeDay(patientId, d, { kcal: 1520, protein: 148 });
    }

    const [summary] = await svc.getPatientsWithSummary(nutriId);
    expect(summary.intake?.state).toBe('ready');
    expect(summary.intake?.target?.source).toBe('plan_items');
    expect(summary.intake?.highCoverageDays7d).toBe(7);
    expect(summary.intake?.exception).toBeNull();
  });

  it('sem plano estruturado, com estimativa própria (persona H): meta vem da estimativa e sinal dispara igual', async () => {
    const { nutriId, patientId } = await dupla();
    await grantConsent(nutriId, patientId, ALL_SCOPES);
    await c.query(
      `INSERT INTO user_nutrition_targets (user_id, source, energy_kcal, protein_g, carbohydrate_g, fat_g, meals_per_day)
       VALUES ($1, 'self_estimate', 2100, 150, 210, 70, 4)`,
      [patientId]
    );

    for (let d = 0; d < 4; d++) {
      await insertIntakeDay(patientId, d, { kcal: 2050, protein: 90 }); // proteína bem abaixo de 80% de 150
    }

    const [summary] = await svc.getPatientsWithSummary(nutriId);
    expect(summary.intake?.target?.source).toBe('self_estimate');
    expect(summary.intake?.exception?.type).toBe('intake_protein_low');
  });

  it('consentimento de nutrição revogado: intake = null (nunca vaza dado nutricional)', async () => {
    const { nutriId, patientId } = await dupla();
    await grantConsent(nutriId, patientId, ['profile']); // sem 'nutrition'
    await createStructuredPlan(nutriId, patientId);
    await insertIntakeDay(patientId, 0, { kcal: 1500, protein: 150 });

    const [summary] = await svc.getPatientsWithSummary(nutriId);
    expect(summary.intake).toBeNull();
    expect(summary.consentRevoked).toBe(true);
  });

  it('getIntakeDailyBreakdown — 7 linhas diárias com selo de cobertura (drawer nível 3)', async () => {
    const { nutriId, patientId } = await dupla();
    await grantConsent(nutriId, patientId, ALL_SCOPES);
    await createStructuredPlan(nutriId, patientId);
    await insertIntakeDay(patientId, 0, { kcal: 1520, protein: 148 });
    await insertIntakeDay(patientId, 2, { kcal: 300, protein: 20, loggedMeals: 1 }); // baixa cobertura

    const { summary, days } = await svc.getIntakeDailyBreakdown(patientId);
    expect(summary.state).toBeDefined();
    expect(days.length).toBe(2);
    const highDay = days.find((d) => d.dateKey === appDay.dayKey());
    const lowDay = days.find((d) => d.loggedMeals === 1);
    expect(highDay?.level).toBe('high');
    expect(lowDay?.level).toBe('low');
    // ordenado do mais recente para o mais antigo.
    expect(days[0].dateKey >= days[1].dateKey).toBe(true);
  });

  it('isolamento: logs de um paciente nunca aparecem no intake de outro paciente do mesmo nutri', async () => {
    const nutriId = await createUser(c, TAG, `nutri-shared-${++seq}`);
    const patientA = await createUser(c, TAG, `pA-${seq}`);
    const patientB = await createUser(c, TAG, `pB-${seq}`);
    await c.query(`INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1,$2,'active'),($1,$3,'active')`, [nutriId, patientA, patientB]);
    await grantConsent(nutriId, patientA, ALL_SCOPES);
    await grantConsent(nutriId, patientB, ALL_SCOPES);

    await insertIntakeDay(patientA, 0, { kcal: 3000, protein: 200 });
    // patientB não tem log nenhum.

    const summaries = await svc.getPatientsWithSummary(nutriId);
    const bSummary = summaries.find((s) => s.id === patientB);
    expect(bSummary?.intake?.state).toBe('none');
    expect(bSummary?.intake?.daysLogged7d).toBe(0);
  });
});
