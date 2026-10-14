/**
 * Registro alimentar INCREMENTAL (alimentar P0) — contrato HTTP + banco real:
 * cada alimento confirmado é gravado na hora, então POST/PATCH precisam ser seguros para reenvio e concorrência.
 * Cobre: idempotência por `clientKey`, POSTs simultâneos, continuar refeição extra por `logId`, itens `existing`
 * (snapshot preservado, inclusive item de plano sem foodId), `baseUpdatedAt` → 409, IDOR de `mealId`/`logId`,
 * janela de edição (ontem anexa, anteontem 403) e o teto de kcal (400, não 500).
 *
 * Nunca roda contra o `.env` (aponta para produção): só com TEST_DATABASE_URL.
 */
import {
  connect,
  acquireSuiteLock,
  finishSuite,
  createUser,
  describeWithDb,
  hasTestDb,
} from './helpers/integrationDb';
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'nutriincr';

describeWithDb('registro alimentar incremental — contrato HTTP', () => {
  let client: Client;
  let userId: number;
  let otherUserId: number;
  let nutriId: number;
  let planMealId: number;
  let planItemId: number;
  let otherMealId: number;
  let app: import('express').Express;
  let token: (id: number) => string;
  let req: (method: 'post' | 'patch' | 'delete' | 'get', path: string, uid?: number) => import('supertest').Test;

  const manual = (name: string, kcal: number, clientKey?: string) => ({
    kind: 'manual' as const, name, grams: 50, energyKcal: kcal, proteinG: 3, carbohydrateG: 20, fatG: 1, ...(clientKey ? { clientKey } : {}),
  });
  const post = (body: Record<string, unknown>, uid?: number) => req('post', '/api/user/nutrition-intake', uid).send(body);
  const patch = (id: number, body: Record<string, unknown>, uid?: number) => req('patch', `/api/user/nutrition-intake/${id}`, uid).send(body);

  beforeAll(async () => {
    client = await connect();
    await acquireSuiteLock(client);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    userId = await createUser(client, TAG, 'aluno');
    otherUserId = await createUser(client, TAG, 'outro');
    nutriId = await createUser(client, TAG, 'nutri');

    const plan = await client.query(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
       VALUES ($1, $2, 'Plano', 'maintenance', 'active') RETURNING id`,
      [nutriId, userId]
    );
    planMealId = (await client.query(
      `INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Café da manhã', 'x') RETURNING id`,
      [plan.rows[0].id]
    )).rows[0].id;
    // item prescrito (para "Como no plano")
    const food = await client.query(`SELECT id, name FROM nutrition_foods ORDER BY id LIMIT 1`);
    planItemId = (await client.query(
      `INSERT INTO nutrition_meal_items (meal_id, food_id, unit_type, grams, quantity, food_name_snapshot,
         energy_kcal_snapshot, protein_g_snapshot, carbohydrate_g_snapshot, fat_g_snapshot, fiber_g_snapshot)
       VALUES ($1, $2, 'grams', 100, 100, $3, 130, 3, 28, 0.5, 1) RETURNING id`,
      [planMealId, food.rows[0].id, food.rows[0].name]
    )).rows[0].id;

    // refeição de OUTRO paciente (IDOR)
    const otherPlan = await client.query(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
       VALUES ($1, $2, 'Plano do outro', 'maintenance', 'active') RETURNING id`,
      [nutriId, otherUserId]
    );
    otherMealId = (await client.query(
      `INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Almoço do outro', 'x') RETURNING id`,
      [otherPlan.rows[0].id]
    )).rows[0].id;

    const express = (await import('express')).default;
    const userRoutes = (await import('../routes/user')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    const request = (await import('supertest')).default;
    app = express();
    app.use(express.json());
    app.use('/api/user', userRoutes);
    token = (id) => generateAccessToken({ id, email: `${id}@test.local`, role: 'user', profileCompleted: true, products: ['app'] });
    req = (method, path, uid) => request(app)[method](path).set('Authorization', `Bearer ${token(uid ?? userId)}`);
  });

  afterAll(async () => {
    await finishSuite(client, async () => {
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = ANY($1)`, [[userId, otherUserId]]);
      await client.query(`DELETE FROM nutrition_plans WHERE nutri_id = $1`, [nutriId]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = ANY($1)`, [[userId, otherUserId]]);
  });

  describe('idempotência e concorrência', () => {
    it('o MESMO clientKey enviado duas vezes (retry) não duplica o item na refeição do plano', async () => {
      const body = { label: 'Café', mealId: planMealId, items: [manual('Pão', 135, 'k-pao')], source: 'manual' };
      const a = await post(body);
      const b = await post(body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.data.id).toBe(a.body.data.id);
      expect(b.body.data.items).toHaveLength(1);
      expect(b.body.data.energyKcal).toBe(135);
    });

    it('refeição EXTRA reenviada com a mesma chave → 1 linha só (antes cada retry criava linha nova)', async () => {
      const body = { label: 'Whey 10h30', mealId: null, items: [manual('Whey', 120, 'k-whey')], source: 'manual' };
      const a = await post(body);
      const b = await post(body);
      expect(b.body.data.id).toBe(a.body.data.id);
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM user_nutrition_intake_logs WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
      expect(rows[0].n).toBe(1);
    });

    it('dois POSTs SIMULTÂNEOS na mesma refeição → 1 linha com os 2 itens (nenhum perdido)', async () => {
      const [a, b] = await Promise.all([
        post({ label: 'Café', mealId: planMealId, items: [manual('Pão', 135, 'c1')], source: 'manual' }),
        post({ label: 'Café', mealId: planMealId, items: [manual('Ovo', 90, 'c2')], source: 'manual' }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const { rows } = await client.query(
        `SELECT id, items FROM user_nutrition_intake_logs WHERE user_id = $1 AND meal_id = $2 AND deleted_at IS NULL`,
        [userId, planMealId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].items.map((i: { name: string }) => i.name).sort()).toEqual(['Ovo', 'Pão']);
    });

    it('dois POSTs simultâneos com a MESMA chave de extra → 1 linha, 1 item', async () => {
      const body = { label: 'Lanche', mealId: null, items: [manual('Banana', 90, 'dup')], source: 'manual' };
      await Promise.all([post(body), post(body), post(body)]);
      const { rows } = await client.query(`SELECT items FROM user_nutrition_intake_logs WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].items).toHaveLength(1);
    });

    it('chave já gravada em OUTRA linha do dia (resposta perdida + add seguinte) não duplica ao reenviar com logId', async () => {
      // A (k1) gravou mas o cliente não viu a resposta; B (k2) sem logId criou outra linha; o retry de A chega com logId de B.
      const a = await post({ label: 'Lanche', mealId: null, items: [manual('Banana', 90, 'k1')], source: 'manual' });
      const b = await post({ label: 'Lanche 2', mealId: null, items: [manual('Aveia', 60, 'k2')], source: 'manual' });
      const retry = await post({ label: 'Lanche', mealId: null, logId: b.body.data.id, items: [manual('Banana', 90, 'k1')], source: 'manual' });
      expect(retry.status).toBe(201);
      const { rows } = await client.query(`SELECT id, items FROM user_nutrition_intake_logs WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`, [userId]);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === a.body.data.id).items).toHaveLength(1);
      expect(rows.find((r) => r.id === b.body.data.id).items).toHaveLength(1); // Banana NÃO foi para a linha B
    });
  });

  describe('continuar a mesma refeição extra por logId', () => {
    it('logId anexa à linha existente em vez de criar outra refeição extra', async () => {
      const first = await post({ label: 'Lanche', mealId: null, items: [manual('Banana', 90, 'e1')], source: 'manual' });
      const second = await post({ label: 'Lanche', mealId: null, logId: first.body.data.id, items: [manual('Aveia', 60, 'e2')], source: 'manual' });
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.items).toHaveLength(2);
      expect(second.body.data.energyKcal).toBe(150);
      expect(second.body.data.updatedAt).not.toBeNull();
    });

    it('logId de OUTRO usuário → 404 (não revela que existe)', async () => {
      const mine = await post({ label: 'Meu', mealId: null, items: [manual('X', 10, 'm1')], source: 'manual' });
      const res = await post({ label: 'Roubo', mealId: null, logId: mine.body.data.id, items: [manual('Y', 10, 'm2')], source: 'manual' }, otherUserId);
      expect(res.status).toBe(404);
    });
  });

  describe('segurança e limites', () => {
    it('mealId de refeição de OUTRO paciente → 400 meal_not_found (antes só a FK era conferida)', async () => {
      const res = await post({ label: 'Almoço', mealId: otherMealId, items: [manual('Arroz', 100, 'x1')], source: 'manual' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('meal_not_found');
    });

    it('refeição que passa do teto de kcal vira 400 (não 500)', async () => {
      const first = await post({ label: 'Banquete', mealId: null, items: [manual('A', 3000, 'b1')], source: 'manual' });
      const res = await post({ label: 'Banquete', mealId: null, logId: first.body.data.id, items: [manual('B', 3000, 'b2')], source: 'manual' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('intake_log_out_of_range');
    });

    it('ontem ainda aceita anexar; anteontem → 403 edit_window_exceeded', async () => {
      const base = await post({ label: 'Jantar', mealId: null, items: [manual('Sopa', 200, 'y1')], source: 'manual' });
      await client.query(`UPDATE user_nutrition_intake_logs SET date_key = date_key - 1 WHERE id = $1`, [base.body.data.id]);
      const ontem = await post({ label: 'Jantar', mealId: null, logId: base.body.data.id, items: [manual('Pão', 100, 'y2')], source: 'manual' });
      expect(ontem.status).toBe(201);
      await client.query(`UPDATE user_nutrition_intake_logs SET date_key = date_key - 1 WHERE id = $1`, [base.body.data.id]);
      const anteontem = await post({ label: 'Jantar', mealId: null, logId: base.body.data.id, items: [manual('Chá', 5, 'y3')], source: 'manual' });
      expect(anteontem.status).toBe(403);
    });

    it('POST não aceita item `existing` (só o PATCH mantém item já salvo)', async () => {
      const res = await post({ label: 'X', mealId: null, items: [{ kind: 'existing', index: 0 }], source: 'manual' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH com itens existing (snapshot preservado) e baseUpdatedAt', () => {
    it('item do PLANO (sem foodId) sobrevive à edição: manter o plano e acrescentar uma bebida não dá 400', async () => {
      const created = await post({ label: 'Café', mealId: planMealId, items: [{ kind: 'plan', planMealItemId: planItemId, clientKey: 'p1' }], source: 'plan' });
      expect(created.status).toBe(201);
      const before = created.body.data.items[0];
      const res = await patch(created.body.data.id, {
        label: 'Café', source: 'manual', baseUpdatedAt: created.body.data.updatedAt,
        items: [{ kind: 'existing', index: 0 }, manual('Leite', 100, 'p2')],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      // snapshot idêntico: resolver 'plan', confiança e macros do Nutri intactos (nada re-derivado)
      expect(res.body.data.items[0]).toEqual(before);
      expect(res.body.data.items[0].resolver).toBe('plan');
    });

    it('remover um item (existing só dos que ficam) recalcula o total; o outro item não muda', async () => {
      const a = await post({ label: 'Lanche', mealId: null, items: [manual('A', 100, 'r1')], source: 'manual' });
      const b = await post({ label: 'Lanche', mealId: null, logId: a.body.data.id, items: [manual('B', 50, 'r2')], source: 'manual' });
      const res = await patch(a.body.data.id, {
        label: 'Lanche', source: 'manual', baseUpdatedAt: b.body.data.updatedAt, items: [{ kind: 'existing', index: 1 }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { name: string }) => i.name)).toEqual(['B']);
      expect(res.body.data.energyKcal).toBe(50);
    });

    it('baseUpdatedAt desatualizado (outro aparelho editou) → 409; sem a chave (cliente antigo) segue funcionando', async () => {
      const a = await post({ label: 'Lanche', mealId: null, items: [manual('A', 100, 'c1')], source: 'manual' });
      const stale = a.body.data.updatedAt; // null: nunca editada
      const edit1 = await patch(a.body.data.id, { label: 'Lanche', source: 'manual', baseUpdatedAt: stale, items: [{ kind: 'existing', index: 0 }, manual('B', 20, 'c2')] });
      expect(edit1.status).toBe(200);
      const edit2 = await patch(a.body.data.id, { label: 'Lanche', source: 'manual', baseUpdatedAt: stale, items: [{ kind: 'existing', index: 0 }] });
      expect(edit2.status).toBe(409);
      expect(edit2.body.error).toBe('intake_conflict');
      const legacy = await patch(a.body.data.id, { label: 'Lanche', source: 'manual', items: [manual('Só este', 10)] });
      expect(legacy.status).toBe(200);
    });

    it('existing apontando para índice inexistente → 400', async () => {
      const a = await post({ label: 'L', mealId: null, items: [manual('A', 10, 'z1')], source: 'manual' });
      const res = await patch(a.body.data.id, { label: 'L', source: 'manual', items: [{ kind: 'existing', index: 7 }] });
      expect(res.status).toBe(400);
    });

    it('refeição legada em 2 linhas: a edição consolida na linha editada e apaga a irmã na MESMA transação', async () => {
      const a = await post({ label: 'Café', mealId: planMealId, items: [manual('Pão', 135, 'l1')], source: 'manual' });
      // simula legado: 2ª linha física da mesma refeição
      await client.query(
        `INSERT INTO user_nutrition_intake_logs (user_id, date_key, meal_id, label, energy_kcal, protein_g, carbohydrate_g, fat_g, items, confidence_score, source)
         SELECT user_id, date_key, meal_id, label, 90, 6, 1, 6, $2::jsonb, 0.8, 'manual' FROM user_nutrition_intake_logs WHERE id = $1`,
        [a.body.data.id, JSON.stringify([{ name: 'Ovo', grams: 50, energyKcal: 90, proteinG: 6, carbohydrateG: 1, fatG: 6, fiberG: null, resolver: 'manual', confidence: 'high', confirmed: true }])]
      );
      const res = await patch(a.body.data.id, { label: 'Café', source: 'manual', items: [{ kind: 'existing', index: 0 }, { kind: 'existing', index: 1 }, manual('Leite', 100, 'l2')] });
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Pão', 'Ovo', 'Leite']);
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM user_nutrition_intake_logs WHERE user_id = $1 AND meal_id = $2 AND deleted_at IS NULL`, [userId, planMealId]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('adesão e cobertura', () => {
    it('registrar alimentos NUNCA cria check-in de refeição (adesão do Nutri inalterada)', async () => {
      await post({ label: 'Café', mealId: planMealId, items: [manual('Pão', 135, 'a1')], source: 'manual' });
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM nutrition_meal_checkins WHERE patient_id = $1`, [userId]);
      expect(rows[0].n).toBe(0);
    });

    it('GET do dia: uma refeição com 3 alimentos conta UMA refeição na cobertura (não 3)', async () => {
      const a = await post({ label: 'Café', mealId: planMealId, items: [manual('A', 100, 'g1')], source: 'manual' });
      await post({ label: 'Café', mealId: planMealId, items: [manual('B', 50, 'g2')], source: 'manual' });
      await post({ label: 'Café', mealId: planMealId, items: [manual('C', 40, 'g3')], source: 'manual' });
      const res = await req('get', '/api/user/nutrition-intake');
      expect(res.status).toBe(200);
      expect(res.body.data.meals).toHaveLength(1);
      expect(res.body.data.meals[0].items).toHaveLength(3);
      expect(res.body.data.meals[0].sourceLogIds).toEqual([a.body.data.id]);
      expect(res.body.data.coverage.loggedMeals).toBe(1);
    });
  });
});
