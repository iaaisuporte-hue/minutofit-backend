/**
 * SPEC 035 — Nutri Safety, Data Integrity & Truth Layer (P1A).
 *
 * Testes de integração com banco REAL. O que só o Postgres prova aqui:
 * cascata de FK real sobre check-ins históricos, UNIQUE de check-in por dia,
 * e o comportamento de ponta a ponta das funções de serviço contra o schema
 * de verdade (não um mock).
 *
 * Rodar:
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/corefit_nutri_p1a_test \
 *     npm test -- nutri-p1a
 *
 * O banco precisa ter o schema completo (seedDatabase + prepareTestDatabase)
 * — ver README de QA do módulo. Sem `TEST_DATABASE_URL` a suíte se
 * auto-pula.
 */
import type { Client } from 'pg';

import { acquireSuiteLock, cleanFixtures, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-nutrip1a';

type NutriSvc = typeof import('../services/nutriService');
type VoiceSvc = typeof import('../services/nutritionVoiceNoteService');
type AppDay = typeof import('../utils/appDay');

describeWithDb('SPEC 035 · Nutri Safety, Data Integrity & Truth Layer (P1A)', () => {
  let c: Client;
  let svc: NutriSvc;
  let voiceSvc: VoiceSvc;
  let appDay: AppDay;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    svc = await import('../services/nutriService');
    voiceSvc = await import('../services/nutritionVoiceNoteService');
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
    await c.query(
      `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`,
      [nutriId, patientId]
    );
    return { nutriId, patientId };
  }

  async function grantConsent(nutriId: number, patientId: number, scopes: string[]) {
    for (const scope of scopes) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'nutri', $3, 'granted')
         ON CONFLICT (user_id, professional_id, professional_role, scope)
         DO UPDATE SET status = 'granted'`,
        [patientId, nutriId, scope]
      );
    }
  }

  const ALL_SCOPES = ['profile', 'nutrition', 'clinical_nutrition', 'daily_checkins', 'metabolic', 'body_metrics'];

  async function planStartedDaysAgo(
    nutriId: number,
    patientId: number,
    daysAgo: number,
    mealCount = 4
  ): Promise<{ planId: number; mealIds: number[] }> {
    const plan = await c.query<{ id: number }>(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status, started_at, created_at, updated_at)
       VALUES ($1, $2, 'Plano de teste', 'maintenance', 'active', NOW() - ($3 || ' days')::interval, NOW(), NOW())
       RETURNING id`,
      [nutriId, patientId, daysAgo]
    );
    const planId = plan.rows[0].id;
    const mealIds: number[] = [];
    for (let i = 0; i < mealCount; i++) {
      const m = await c.query<{ id: number }>(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation, order_index)
         VALUES ($1, $2, 'Orientação', $3) RETURNING id`,
        [planId, `Refeição ${i + 1}`, i]
      );
      mealIds.push(m.rows[0].id);
    }
    return { planId, mealIds };
  }

  // Referência de "hoje" sempre pelo mesmo `dayKey()` que os serviços usam —
  // nunca `CURRENT_DATE` do Postgres (que pode ser UTC), para o teste não
  // flakar perto da virada de meia-noite.
  async function insertCheckin(patientId: number, planId: number, mealId: number, daysAgo: number, status: string) {
    const checkDate = appDay.shiftDayKey(appDay.dayKey(), -daysAgo);
    await c.query(
      `INSERT INTO nutrition_meal_checkins (patient_id, plan_id, meal_id, check_date, status, recorded_at)
       VALUES ($1, $2, $3, $4::date, $5, NOW())`,
      [patientId, planId, mealId, checkDate, status]
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // P1A.2 — IDOR (NUTRI-02)
  // ─────────────────────────────────────────────────────────────────────
  describe('P1A.2 · IDOR — patientId cruzado com plano de outro paciente', () => {
    it('updatePlan recusa (null) quando o plano não pertence ao patientId informado', async () => {
      const { nutriId, patientId: patientA } = await dupla();
      seq += 1;
      const patientB = await createUser(c, TAG, `paciente-b-${seq}`);
      await c.query(
        `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`,
        [nutriId, patientB]
      );
      const { planId } = await planStartedDaysAgo(nutriId, patientB, 10);

      // Ataque: mesmo nutri, mas informando o patientId de A para um plano que é de B.
      const result = await svc.updatePlan(nutriId, planId, patientA, { title: 'Sequestrado' });
      expect(result).toBeNull();

      // Confirma que nada mudou no banco.
      const row = await c.query(`SELECT title FROM nutrition_plans WHERE id = $1`, [planId]);
      expect(row.rows[0].title).toBe('Plano de teste');

      // A chamada LEGÍTIMA (patientId correto) continua funcionando.
      const ok = await svc.updatePlan(nutriId, planId, patientB, { title: 'Ajustado corretamente' });
      expect(ok?.title).toBe('Ajustado corretamente');
    });

    it('endPlan recusa (null) pelo mesmo vetor', async () => {
      const { nutriId, patientId: patientA } = await dupla();
      seq += 1;
      const patientB = await createUser(c, TAG, `paciente-b2-${seq}`);
      await c.query(
        `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`,
        [nutriId, patientB]
      );
      const { planId } = await planStartedDaysAgo(nutriId, patientB, 10);

      const result = await svc.endPlan(nutriId, planId, patientA);
      expect(result).toBeNull();

      const row = await c.query(`SELECT status FROM nutrition_plans WHERE id = $1`, [planId]);
      expect(row.rows[0].status).toBe('active');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1A.1 — Integridade do plano (NUTRI-01) — o BLOCKER da P0
  // ─────────────────────────────────────────────────────────────────────
  describe('P1A.1 · integridade do plano — editar não apaga histórico', () => {
    it('editar SÓ o título preserva 100% dos check-ins, alternativas e campos avançados', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 40, 2);

      // Campos avançados + alternativa na primeira refeição.
      await c.query(
        `UPDATE nutrition_plan_meals
            SET tolerance_minutes = 45, reminder_minutes = 20,
                metabolic_goal = 'energy', workout_relation = 'pre',
                hydration_note = '500ml agua', supplement_note = 'creatina 5g'
          WHERE id = $1`,
        [mealIds[0]]
      );
      await c.query(
        `INSERT INTO nutrition_meal_alternatives (meal_id, description, order_index) VALUES ($1, 'Alternativa A', 0)`,
        [mealIds[0]]
      );

      // 30 check-ins históricos espalhados pelas duas refeições.
      for (let d = 0; d < 15; d++) {
        await insertCheckin(patientId, planId, mealIds[0], d, 'done');
        await insertCheckin(patientId, planId, mealIds[1], d, 'partial');
      }
      const before = await c.query(`SELECT COUNT(*)::int AS n FROM nutrition_meal_checkins WHERE plan_id = $1`, [planId]);
      expect(before.rows[0].n).toBe(30);

      // Payload EXATAMENTE como o frontend deveria enviar após hidratar o
      // rascunho com `id` — só o título muda.
      const activeBefore = await svc.getActivePlan(nutriId, patientId);
      const payloadMeals = activeBefore!.meals.map((m: any) => ({
        id: m.id,
        name: m.name,
        orientation: m.orientation,
        order_index: m.order_index,
        meal_time: m.meal_time,
        tolerance_minutes: m.tolerance_minutes,
        reminder_minutes: m.reminder_minutes,
        metabolic_goal: m.metabolic_goal,
        workout_relation: m.workout_relation,
        hydration_note: m.hydration_note,
        supplement_note: m.supplement_note,
        alternatives: m.alternatives.map((a: any) => ({ id: a.id, description: a.description, order_index: a.order_index })),
      }));

      await svc.updatePlan(nutriId, planId, patientId, {
        title: 'Plano de teste (ajustado)',
        meals: payloadMeals,
      });

      const after = await c.query(`SELECT COUNT(*)::int AS n FROM nutrition_meal_checkins WHERE plan_id = $1`, [planId]);
      expect(after.rows[0].n).toBe(30); // <- era 0 antes do fix (BLOCKER NUTRI-01)

      const mealsAfter = await c.query(
        `SELECT id, tolerance_minutes, reminder_minutes, metabolic_goal, workout_relation, hydration_note, supplement_note
           FROM nutrition_plan_meals WHERE id = $1`,
        [mealIds[0]]
      );
      expect(mealsAfter.rows[0]).toMatchObject({
        id: mealIds[0], // mesmo id — não foi recriada
        tolerance_minutes: 45,
        reminder_minutes: 20,
        metabolic_goal: 'energy',
        workout_relation: 'pre',
        hydration_note: '500ml agua',
        supplement_note: 'creatina 5g',
      });

      const altsAfter = await c.query(`SELECT COUNT(*)::int AS n FROM nutrition_meal_alternatives WHERE meal_id = $1`, [mealIds[0]]);
      expect(altsAfter.rows[0].n).toBe(1);

      const plan = await c.query(`SELECT title FROM nutrition_plans WHERE id = $1`, [planId]);
      expect(plan.rows[0].title).toBe('Plano de teste (ajustado)');
    });

    it('remover uma refeição COM histórico faz soft-delete — check-ins sobrevivem', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 20, 2);
      await insertCheckin(patientId, planId, mealIds[0], 1, 'done');
      await insertCheckin(patientId, planId, mealIds[0], 2, 'skipped');

      // Payload só com a segunda refeição — a primeira "some" da UI.
      await svc.updatePlan(nutriId, planId, patientId, {
        meals: [{ id: mealIds[1], name: 'Refeição 2', orientation: 'Orientação', order_index: 0 }],
      });

      const mealRow = await c.query(`SELECT deleted_at FROM nutrition_plan_meals WHERE id = $1`, [mealIds[0]]);
      expect(mealRow.rows[0].deleted_at).not.toBeNull(); // soft-deleted, não apagada

      const checkins = await c.query(`SELECT COUNT(*)::int AS n FROM nutrition_meal_checkins WHERE meal_id = $1`, [mealIds[0]]);
      expect(checkins.rows[0].n).toBe(2); // histórico intacto

      const active = await svc.getActivePlan(nutriId, patientId);
      expect(active!.meals.map((m: any) => m.id)).not.toContain(mealIds[0]); // não aparece mais como ativa
    });

    it('remover uma refeição SEM histórico faz hard-delete de verdade', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 5, 2);

      await svc.updatePlan(nutriId, planId, patientId, {
        meals: [{ id: mealIds[1], name: 'Refeição 2', orientation: 'Orientação', order_index: 0 }],
      });

      const mealRow = await c.query(`SELECT * FROM nutrition_plan_meals WHERE id = $1`, [mealIds[0]]);
      expect(mealRow.rows.length).toBe(0); // realmente removida — nada a preservar
    });

    it('adicionar refeição nova (sem id) insere; refeições existentes mantêm identidade', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 5, 1);

      await svc.updatePlan(nutriId, planId, patientId, {
        meals: [
          { id: mealIds[0], name: 'Refeição 1', orientation: 'Orientação', order_index: 0 },
          { name: 'Refeição Nova', orientation: 'Orientação nova', order_index: 1 },
        ],
      });

      const active = await svc.getActivePlan(nutriId, patientId);
      expect(active!.meals).toHaveLength(2);
      expect(active!.meals.map((m: any) => m.id)).toContain(mealIds[0]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1A.3 — Timezone (NUTRI-07 / NUTRI-08)
  // ─────────────────────────────────────────────────────────────────────
  describe('P1A.3 · timezone — dia do aluno, não UTC do processo', () => {
    const cases: Array<[string, string]> = [
      ['2026-09-07T23:30:00.000Z', '2026-09-07'], // 20:30 BRT
      ['2026-09-08T00:00:00.000Z', '2026-09-07'], // 21:00 BRT
      ['2026-09-08T00:30:00.000Z', '2026-09-07'], // 21:30 BRT — a hora que quebrava
      ['2026-09-08T02:59:00.000Z', '2026-09-07'], // 23:59 BRT
      ['2026-09-08T03:01:00.000Z', '2026-09-08'], // 00:01 BRT
    ];

    for (const [instant, expectedKey] of cases) {
      it(`${instant} (UTC) → dia do aluno = ${expectedKey}`, () => {
        expect(appDay.dayKey(new Date(instant))).toBe(expectedKey);
      });
    }

    it('createMealCheckin grava no dia do ALUNO, não no UTC — não sobrescreve o dia anterior', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 5, 1);
      void planId;

      // `check_date` (tipo `date`) volta do driver `pg` como Date de meia-noite
      // UTC daquele dia de calendário — não como string. `.toISOString().slice(0,10)`
      // é o mesmo caminho que a rota/JSON expõe ao frontend.
      const asKey = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);

      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        // Segunda 21h30 BRT = terça 00h30 UTC.
        jest.setSystemTime(new Date('2026-09-08T00:30:00.000Z'));
        const r1 = await svc.createMealCheckin(patientId, mealIds[0], { status: 'done', note: 'jantar de segunda' });
        expect(asKey((r1 as any).data.check_date)).toBe('2026-09-07'); // dia do ALUNO — não '2026-09-08'

        // Terça 20h00 BRT — dia real diferente, não pode colidir/sobrescrever segunda.
        jest.setSystemTime(new Date('2026-09-08T23:00:00.000Z'));
        const r2 = await svc.createMealCheckin(patientId, mealIds[0], { status: 'skipped', note: 'jantar de terca' });
        expect(asKey((r2 as any).data.check_date)).toBe('2026-09-08');
      } finally {
        jest.useRealTimers();
      }

      const rows = await c.query(
        `SELECT check_date::text, status FROM nutrition_meal_checkins WHERE meal_id = $1 ORDER BY check_date`,
        [mealIds[0]]
      );
      expect(rows.rows).toEqual([
        { check_date: '2026-09-07', status: 'done' },
        { check_date: '2026-09-08', status: 'skipped' },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1A.4 — Aderência canônica via getPatientsWithSummary (NUTRI-13/14/32)
  // ─────────────────────────────────────────────────────────────────────
  describe('P1A.4 · getPatientsWithSummary — denominador proporcional e risco coerente', () => {
    it('paciente de 2 dias com 100% de adesão real não nasce "em risco"', async () => {
      const { nutriId, patientId } = await dupla();
      await grantConsent(nutriId, patientId, ALL_SCOPES);
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 1, 4); // plano de "2 dias" (hoje + ontem)

      for (const mealId of mealIds) {
        await insertCheckin(patientId, planId, mealId, 0, 'done');
        await insertCheckin(patientId, planId, mealId, 1, 'done');
      }

      const list = await svc.getPatientsWithSummary(nutriId);
      const row = list.find((p) => p.id === patientId)!;
      expect(row.mealAdherence7dPct).toBe(100); // não 29% (NUTRI-13)
      expect(row.adherenceState).toBe('calibrating');
      expect(row.riskFlag).toBe(false); // suprimido durante calibração (NUTRI-13/14)
    });

    it('paciente que só usa a timeline granular não fica "ATENÇÃO + 100% + nenhum check-in" (NUTRI-14)', async () => {
      const { nutriId, patientId } = await dupla();
      await grantConsent(nutriId, patientId, ALL_SCOPES);
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 10, 2);
      for (let d = 0; d < 7; d++) {
        await insertCheckin(patientId, planId, mealIds[0], d, 'done');
        await insertCheckin(patientId, planId, mealIds[1], d, 'done');
      }

      const list = await svc.getPatientsWithSummary(nutriId);
      const row = list.find((p) => p.id === patientId)!;
      expect(row.mealAdherence7dPct).toBe(100);
      expect(row.lastCheckinDate).not.toBeNull(); // combinou a fonte granular (NUTRI-14)
      expect(row.riskFlag).toBe(false);
    });

    it('check-ins de um plano ENCERRADO não contaminam a aderência do plano ativo (NUTRI-32)', async () => {
      const { nutriId, patientId } = await dupla();
      await grantConsent(nutriId, patientId, ALL_SCOPES);

      // Plano antigo, encerrado, com check-ins ruins.
      const old = await planStartedDaysAgo(nutriId, patientId, 60, 3);
      await c.query(`UPDATE nutrition_plans SET status = 'ended' WHERE id = $1`, [old.planId]);
      for (let d = 0; d < 7; d++) await insertCheckin(patientId, old.planId, old.mealIds[0], d, 'skipped');

      // Plano novo, ativo, perfeito.
      const fresh = await planStartedDaysAgo(nutriId, patientId, 20, 1);
      for (let d = 0; d < 7; d++) await insertCheckin(patientId, fresh.planId, fresh.mealIds[0], d, 'done');

      const list = await svc.getPatientsWithSummary(nutriId);
      const row = list.find((p) => p.id === patientId)!;
      expect(row.mealAdherence7dPct).toBe(100); // só o plano ativo conta
    });

    it('consentimento "profile" revogado redige a linha (NUTRI-SEC-02)', async () => {
      const { nutriId, patientId } = await dupla();
      await grantConsent(nutriId, patientId, ['nutrition']); // sem 'profile'
      await planStartedDaysAgo(nutriId, patientId, 20, 2);

      const list = await svc.getPatientsWithSummary(nutriId);
      const row: any = list.find((p) => p.id === patientId)!;
      expect(row.consentRevoked).toBe(true);
      expect(row.email).toBeNull();
      expect(row.activePlan).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1A.5 — Insights não quebram mais (NUTRI-03)
  // ─────────────────────────────────────────────────────────────────────
  describe('P1A.5 · computePatientInsights não lança mais erro de coluna', () => {
    it('executa sem erro e detecta sumiço silencioso corretamente', async () => {
      const { nutriId, patientId } = await dupla();
      await planStartedDaysAgo(nutriId, patientId, 20, 1);
      // Nenhum check-in em 72h.
      const insights = await voiceSvc.computePatientInsights(nutriId, patientId);
      expect(insights.some((i) => i.type === 'silent_absence')).toBe(true);
    });

    it('paciente ativo recentemente não recebe "sumiço silencioso"', async () => {
      const { nutriId, patientId } = await dupla();
      const { planId, mealIds } = await planStartedDaysAgo(nutriId, patientId, 20, 1);
      await insertCheckin(patientId, planId, mealIds[0], 0, 'done');
      const insights = await voiceSvc.computePatientInsights(nutriId, patientId);
      expect(insights.some((i) => i.type === 'silent_absence')).toBe(false);
    });
  });
});
