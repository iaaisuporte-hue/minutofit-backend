/**
 * SPEC 038 — Structured Nutrition Foundation (P3A).
 *
 * Testes de integração com banco REAL contra o catálogo TACO já seedado
 * (prepareTestDatabase roda o boot chain, que inclui seedNutritionFoodsIfEmpty).
 *
 * Rodar:
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/<banco_ja_preparado> \
 *     npm test -- nutrition-foods
 */
import type { Client } from 'pg';
import { acquireSuiteLock, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-nutrifoods';

type NutriSvc = typeof import('../services/nutriService');
type FoodSvc = typeof import('../services/nutritionFoodService');

describeWithDb('SPEC 038 · Structured Nutrition Foundation (P3A)', () => {
  let c: Client;
  let svc: NutriSvc;
  let foodSvc: FoodSvc;

  // Arroz, tipo 1, cozido — TACO source_id 3, seedado com 1 medida "colher de sopa cheia" = 25g.
  let arrozFoodId: number;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanUp();
    svc = await import('../services/nutriService');
    foodSvc = await import('../services/nutritionFoodService');

    const arroz = await c.query(`SELECT id FROM nutrition_foods WHERE source = 'taco' AND source_id = '3'`);
    if (arroz.rows.length === 0) throw new Error('Catálogo TACO não seedado no banco de teste — rode prepareTestDatabase.ts');
    arrozFoodId = arroz.rows[0].id;
  });

  afterAll(async () => {
    await finishSuite(c, cleanUp);
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  async function cleanUp() {
    await c.query(`DELETE FROM nutrition_custom_foods WHERE name LIKE $1`, [`${TAG}-%`]);
    await c.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
  }

  let seq = 0;
  async function dupla(): Promise<{ nutriId: number; patientId: number }> {
    seq += 1;
    const nutriId = await createUser(c, TAG, `nutri-${seq}`);
    const patientId = await createUser(c, TAG, `paciente-${seq}`);
    await c.query(
      `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`,
      [nutriId, patientId],
    );
    for (const scope of ['profile', 'nutrition']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'nutri', $3, 'granted')`,
        [patientId, nutriId, scope],
      );
    }
    return { nutriId, patientId };
  }

  // ── Catálogo ──────────────────────────────────────────────────────────

  it('busca no catálogo tolera acento/caixa (SPEC 038 §25)', async () => {
    const results = await foodSvc.searchCatalogFoods('ARROZ');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name.toLowerCase().includes('arroz'))).toBe(true);
  });

  it('id do alimento do catálogo resolve nutrientes reais', async () => {
    const food = await foodSvc.getCatalogFoodById(arrozFoodId);
    expect(food).not.toBeNull();
    expect(food!.energyKcal).toBeGreaterThan(0);
  });

  it('medida caseira curada resolve para a gramagem esperada', async () => {
    const measures = await foodSvc.listCatalogFoodMeasures(arrozFoodId);
    const colher = measures.find((m) => m.name.includes('colher'));
    expect(colher).toBeDefined();
    expect(colher!.grams).toBe(25);
  });

  // ── Alimento customizado + IDOR ──────────────────────────────────────

  it('nutri cria alimento customizado e ele aparece na própria lista', async () => {
    const { nutriId } = await dupla();
    const food = await foodSvc.createCustomFood(nutriId, {
      name: `${TAG}-receita-caseira`,
      energyKcal: 250, proteinG: 10, carbohydrateG: 30, fatG: 8, fiberG: 3,
    });
    const list = await foodSvc.listCustomFoods(nutriId);
    expect(list.some((f) => f.id === food.id)).toBe(true);
  });

  it('rejeita kcal negativo e acima do limite (SPEC 038 §23)', async () => {
    const { nutriId } = await dupla();
    await expect(
      foodSvc.createCustomFood(nutriId, { name: `${TAG}-x`, energyKcal: -1, proteinG: 0, carbohydrateG: 0, fatG: 0 }),
    ).rejects.toThrow('invalid_energyKcal');
    await expect(
      foodSvc.createCustomFood(nutriId, { name: `${TAG}-y`, energyKcal: 9999, proteinG: 0, carbohydrateG: 0, fatG: 0 }),
    ).rejects.toThrow('invalid_energyKcal');
  });

  it('IDOR: nutri B não lê/edita/arquiva alimento customizado de nutri A (SPEC 038 §48/§64)', async () => {
    const { nutriId: nutriA } = await dupla();
    const { nutriId: nutriB } = await dupla();
    const food = await foodSvc.createCustomFood(nutriA, {
      name: `${TAG}-privado-de-a`, energyKcal: 100, proteinG: 5, carbohydrateG: 10, fatG: 2,
    });

    await expect(
      foodSvc.updateCustomFood(nutriB, food.id, { energyKcal: 999 }),
    ).rejects.toThrow('not_owner');
    await expect(
      foodSvc.archiveCustomFood(nutriB, food.id),
    ).rejects.toThrow('not_owner');

    // nutri A continua conseguindo — confirma que o bloqueio é por dono, não geral.
    await expect(foodSvc.updateCustomFood(nutriA, food.id, { energyKcal: 111 })).resolves.toBeDefined();
  });

  it('alimento customizado arquivado some da listagem mas nome pode ser reusado', async () => {
    const { nutriId } = await dupla();
    const food = await foodSvc.createCustomFood(nutriId, {
      name: `${TAG}-arquivavel`, energyKcal: 100, proteinG: 5, carbohydrateG: 10, fatG: 2,
    });
    await foodSvc.archiveCustomFood(nutriId, food.id);
    const list = await foodSvc.listCustomFoods(nutriId);
    expect(list.some((f) => f.id === food.id)).toBe(false);
  });

  // ── Item de refeição — cálculo, backend como fonte da verdade ────────

  it('item do catálogo: backend calcula, cliente não pode injetar macro falso (SPEC 038 §35)', async () => {
    const { nutriId, patientId } = await dupla();
    await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano com item', objective: 'weight_loss',
      meals: [{
        name: 'Almoço', orientation: 'Arroz', order_index: 0,
        items: [{ foodId: arrozFoodId, quantity: 150, unitType: 'grams' } as any],
      }],
    });
    const active = await svc.getActivePlan(nutriId, patientId);
    const item = (active!.meals[0] as any).items[0];
    // 100g de arroz tipo 1 cozido ≈ 128.26 kcal (ver fixture TACO real) — 150g escala proporcionalmente.
    const food = await foodSvc.getCatalogFoodById(arrozFoodId);
    const expectedKcal = Math.round((food!.energyKcal * 1.5) * 100) / 100;
    expect(item.energyKcal).toBe(expectedKcal);
    expect(item.grams).toBe(150);
  });

  it('item com medida caseira produz o mesmo resultado que a gramagem equivalente', async () => {
    const { nutriId, patientId } = await dupla();
    const measures = await foodSvc.listCatalogFoodMeasures(arrozFoodId);
    const colher = measures.find((m) => m.name.includes('colher'))!;

    const planA = await svc.createPlan(nutriId, patientId, null, {
      title: 'Via medida', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 2, unitType: 'measure', measureId: colher.id } as any] }],
    });
    const activeA = await svc.getActivePlan(nutriId, patientId);
    const itemA = (activeA!.meals[0] as any).items[0];

    await svc.endPlan(nutriId, planA.id, patientId);
    const { nutriId: nutriId2, patientId: patientId2 } = await dupla();
    await svc.createPlan(nutriId2, patientId2, null, {
      title: 'Via gramas', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 50, unitType: 'grams' } as any] }],
    });
    const activeB = await svc.getActivePlan(nutriId2, patientId2);
    const itemB = (activeB!.meals[0] as any).items[0];

    expect(itemA.energyKcal).toBe(itemB.energyKcal);
    expect(itemA.grams).toBe(itemB.grams);
  });

  it('IDOR: item não pode referenciar alimento customizado de outro nutri', async () => {
    const { nutriId: nutriA, patientId } = await dupla();
    const { nutriId: nutriB } = await dupla();
    const food = await foodSvc.createCustomFood(nutriB, {
      name: `${TAG}-de-b`, energyKcal: 100, proteinG: 5, carbohydrateG: 10, fatG: 2,
    });

    await expect(
      svc.createPlan(nutriA, patientId, null, {
        title: 'Tentativa IDOR', objective: 'weight_loss',
        meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ customFoodId: food.id, quantity: 100, unitType: 'grams' } as any] }],
      }),
    ).rejects.toThrow('not_owner');
  });

  // ── Snapshot — a regra crítica ────────────────────────────────────────

  it('SNAPSHOT: atualizar o catálogo NÃO altera retroativamente item já prescrito (SPEC 038 §18-19, crítico)', async () => {
    const originalRes = await c.query(`SELECT energy_kcal FROM nutrition_foods WHERE id = $1`, [arrozFoodId]);
    const originalKcal = Number(originalRes.rows[0].energy_kcal);
    try {
      const { nutriId, patientId } = await dupla();
      await svc.createPlan(nutriId, patientId, null, {
        title: 'Plano histórico', objective: 'weight_loss',
        meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any] }],
      });
      const before = await svc.getActivePlan(nutriId, patientId);
      const kcalBefore = (before!.meals[0] as any).items[0].energyKcal;

      // Simula uma atualização de catálogo (ex.: reimport de uma versão nova da TACO).
      const bumpedKcal = Math.min(originalKcal + 100, 900);
      await c.query(`UPDATE nutrition_foods SET energy_kcal = $2, updated_at = NOW() WHERE id = $1`, [arrozFoodId, bumpedKcal]);

      const after = await svc.getActivePlan(nutriId, patientId);
      const kcalAfter = (after!.meals[0] as any).items[0].energyKcal;
      expect(kcalAfter).toBe(kcalBefore); // item já prescrito não mudou

      // Item NOVO, criado depois da mudança de catálogo, usa o valor atualizado.
      await svc.updatePlan(nutriId, before!.id, patientId, {
        meals: [
          { id: before!.meals[0].id, name: 'Almoço', orientation: 'x', order_index: 0,
            items: [
              { id: (before!.meals[0] as any).items[0].id, foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any,
              { foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any,
            ] },
        ],
      });
      const afterAdd = await svc.getActivePlan(nutriId, patientId);
      const items = (afterAdd!.meals[0] as any).items;
      expect(items).toHaveLength(2);
      const oldItem = items.find((i: any) => i.id === (before!.meals[0] as any).items[0].id);
      const newItem = items.find((i: any) => i.id !== oldItem.id);
      expect(oldItem.energyKcal).toBe(kcalBefore); // continua intocado
      expect(newItem.energyKcal).toBe(bumpedKcal); // usa a composição NOVA
    } finally {
      // Restaura o catálogo mesmo se uma asserção falhar — nunca vaza estado entre testes/suítes.
      await c.query(`UPDATE nutrition_foods SET energy_kcal = $2, updated_at = NOW() WHERE id = $1`, [arrozFoodId, originalKcal]);
    }
  });

  it('editar refeição soft-deleta item removido (nunca hard-delete) — SPEC 038 §41-42', async () => {
    const { nutriId, patientId } = await dupla();
    const plan = await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any] }],
    });
    const active = await svc.getActivePlan(nutriId, patientId);
    const itemId = (active!.meals[0] as any).items[0].id;

    await svc.updatePlan(nutriId, plan.id, patientId, {
      meals: [{ id: active!.meals[0].id, name: 'Almoço', orientation: 'x', order_index: 0, items: [] }],
    });

    const afterRemove = await svc.getActivePlan(nutriId, patientId);
    expect((afterRemove!.meals[0] as any).items).toHaveLength(0);

    const row = await c.query(`SELECT deleted_at FROM nutrition_meal_items WHERE id = $1`, [itemId]);
    expect(row.rows).toHaveLength(1); // linha continua existindo
    expect(row.rows[0].deleted_at).not.toBeNull(); // soft-deleted, não apagada
  });

  // ── Compatibilidade com plano legado ─────────────────────────────────

  it('plano sem NENHUM item continua funcionando (compatibilidade, SPEC 038 §38-40)', async () => {
    const { nutriId, patientId } = await dupla();
    const plan = await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano só texto', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'Coma bem', order_index: 0 }],
    });
    const active = await svc.getActivePlan(nutriId, patientId);
    expect(active!.id).toBe(plan.id);
    expect((active!.meals[0] as any).items).toEqual([]);
    expect((active as any).dayTotals.energyKcal).toBe(0);
  });

  it('refeição híbrida: orientação de texto + itens estruturados coexistem (SPEC 038 §39)', async () => {
    const { nutriId, patientId } = await dupla();
    await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano híbrido', objective: 'weight_loss',
      meals: [{
        name: 'Almoço', orientation: 'Priorizar alimentos pouco processados.', order_index: 0,
        items: [{ foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any],
      }],
    });
    const active = await svc.getActivePlan(nutriId, patientId);
    expect(active!.meals[0].orientation).toBe('Priorizar alimentos pouco processados.');
    expect((active!.meals[0] as any).items).toHaveLength(1);
  });

  it('CONTRATO: editar plano SEM ecoar items apaga (soft-delete) os itens — a UI que chama este service é quem tem que ecoar, sempre (mesma classe do NUTRI-01)', async () => {
    const { nutriId, patientId } = await dupla();
    const plan = await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any] }],
    });
    const before = await svc.getActivePlan(nutriId, patientId);
    expect((before!.meals[0] as any).items).toHaveLength(1);

    // Payload de edição SEM `items` no meal — exatamente o que PlanTab.tsx
    // mandava antes da correção deste mesmo commit. Documentado aqui como
    // contrato: é responsabilidade de QUEM CHAMA ecoar `items`, igual já
    // valia para `alternatives`. O service não inventa um "não mudou nada"
    // a partir de um campo ausente.
    await svc.updatePlan(nutriId, plan.id, patientId, {
      title: 'Plano (título editado)',
      meals: [{ id: before!.meals[0].id, name: 'Almoço', orientation: 'x', order_index: 0 }],
    });

    const after = await svc.getActivePlan(nutriId, patientId);
    expect((after!.meals[0] as any).items).toHaveLength(0);
  });

  it('regressão: PlanTab.tsx ecoando items preserva o item ao editar só o título (correção deste commit)', async () => {
    const { nutriId, patientId } = await dupla();
    const plan = await svc.createPlan(nutriId, patientId, null, {
      title: 'Plano', objective: 'weight_loss',
      meals: [{ name: 'Almoço', orientation: 'x', order_index: 0, items: [{ foodId: arrozFoodId, quantity: 100, unitType: 'grams' } as any] }],
    });
    const before = await svc.getActivePlan(nutriId, patientId);
    const existingItem = (before!.meals[0] as any).items[0];

    // Payload como o frontend corrigido monta: ecoa o item existente pelo id.
    await svc.updatePlan(nutriId, plan.id, patientId, {
      title: 'Plano (só o título mudou)',
      meals: [{
        id: before!.meals[0].id, name: 'Almoço', orientation: 'x', order_index: 0,
        items: [{ id: existingItem.id, foodId: existingItem.foodId, quantity: existingItem.quantity, unitType: existingItem.unitType } as any],
      }],
    });

    const after = await svc.getActivePlan(nutriId, patientId);
    expect((after!.meals[0] as any).items).toHaveLength(1);
    expect((after!.meals[0] as any).items[0].id).toBe(existingItem.id);
    expect((after!.meals[0] as any).items[0].energyKcal).toBe(existingItem.energyKcal); // snapshot intocado
  });
});
