/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B) — integração com banco real: resolução
 * contra o catálogo TACO (SPEC 038), rejeição de item não resolvido/baixa
 * confiança sem confirmação, IDOR na cópia de item de plano, e
 * `confidence_score` derivado no servidor.
 */
import {
  connect,
  acquireSuiteLock,
  finishSuite,
  createUser,
  describeWithDb,
  hasTestDb,
  type FixtureTag,
} from './helpers/integrationDb';
import type { Client } from 'pg';

// Defesa em profundidade (mesmo padrão de nutri-p1a.integration.test.ts): o
// pool de `config/database.ts` lê `DATABASE_URL` do `.env` no import, que
// aponta para PRODUÇÃO. Isso só funciona porque o serviço é importado
// DINAMICAMENTE dentro do `beforeAll` — um `import` estático no topo deste
// arquivo seria hoisted pelo compilador e rodaria ANTES desta linha,
// instanciando o pool contra produção mesmo assim.
if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

type IntakeSvc = typeof import('../services/nutritionIntakeService');

// Sem isto, o `beforeAll` pode exceder os 5s padrão do Jest quando várias
// suítes de integração disputam o MESMO advisory lock em paralelo — não é
// flakiness real, é fila (ver `acquireSuiteLock` em `integrationDb.ts`).
jest.setTimeout(120_000);

const TAG: FixtureTag = 'nutriintake';

describeWithDb('nutritionIntakeService (integration)', () => {
  let client: Client;
  let userId: number;
  let svc: IntakeSvc;

  beforeAll(async () => {
    client = await connect();
    await acquireSuiteLock(client);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    userId = await createUser(client, TAG, 'aluno');
    svc = await import('../services/nutritionIntakeService');
  });

  afterAll(async () => {
    await finishSuite(client, async () => {
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
  });

  describe('parseAndResolve — resolução contra o catálogo real', () => {
    it('resolve "200g de arroz" com match forte (confiança high)', async () => {
      const preview = await svc.parseAndResolve('200g de arroz tipo 1 cozido');
      expect(preview.items).toHaveLength(1);
      expect(preview.items[0].resolved).toBe(true);
      expect(preview.items[0].grams).toBe(200);
      expect(preview.items[0].confidence).toBe('high');
      expect(preview.needsConfirmation).toBe(false);
    });

    it('resolve "2 ovos" via medida caseira cadastrada no catálogo (colher/unidade)', async () => {
      const preview = await svc.parseAndResolve('2 ovos');
      expect(preview.items[0].resolved).toBe(true);
      expect(preview.items[0].grams).toBeGreaterThan(0);
    });

    it('alimento inexistente fica não resolvido, nunca "meta 0"', async () => {
      const preview = await svc.parseAndResolve('200g de xyzalimentoinexistente123');
      expect(preview.items[0].resolved).toBe(false);
      expect(preview.needsConfirmation).toBe(true);
    });

    it('totais somam só os itens resolvidos', async () => {
      const preview = await svc.parseAndResolve('200g de arroz tipo 1 cozido + 200g de xyznada123');
      expect(preview.items).toHaveLength(2);
      expect(preview.totals.energyKcal).toBeGreaterThan(0);
      expect(preview.items[1].resolved).toBe(false);
    });

    // PLAN P1B corrective §21 — regressão obrigatória do bug relatado no QA:
    // "1 pão francês" virava unresolved (ILIKE substring não contíguo falha
    // contra "Pão, TRIGO, francês") e o total mostrava "≈0 kcal".
    describe('regressão — "1 pão francês" (bug relatado no QA)', () => {
      it.each(['1 pão francês', '1 pao frances', '1 pão françes', '1 pao francez'])(
        '"%s": alimento correto, medida resolvida, kcal calculado, sem busca manual',
        async (input) => {
          const preview = await svc.parseAndResolve(input);
          expect(preview.items).toHaveLength(1);
          const item = preview.items[0];
          expect(item.resolved).toBe(true);
          expect(item.name).toBe('Pão, trigo, francês');
          expect(item.grams).toBeGreaterThan(0);
          expect(item.energyKcal).toBeGreaterThan(0);
          expect(item.confidence).not.toBeUndefined();
          // High ou medium — em qualquer caso o usuário chega a "Confirmar"
          // sem precisar abrir busca manual (medium exige toque em "Usar
          // este", não digitar/buscar de novo).
          expect(['high', 'medium']).toContain(item.confidence);
        },
      );
    });
  });

  describe('persistIntakeLog — nunca persiste item não resolvido', () => {
    it('rejeita foodId inexistente', async () => {
      await expect(
        svc.persistIntakeLog({
          userId, label: 'Teste', items: [{ kind: 'food', foodId: 999999999, quantity: 100, unitType: 'grams' }], source: 'manual',
        })
      ).rejects.toThrow(svc.ValidationError);
    });

    it('persiste item de catálogo em grams e recalcula os nutrientes no servidor (ignora kcal que o cliente mandaria)', async () => {
      const found = await svc.parseAndResolve('100g de arroz tipo 1 cozido');
      const foodId = found.items[0].foodId!;
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', items: [{ kind: 'food', foodId, quantity: 100, unitType: 'grams' }], source: 'manual',
      });
      expect(log.energyKcal).toBeCloseTo(found.items[0].energyKcal!, 1);
      expect(log.items[0].resolver).toBe('catalog');
      expect(log.confidenceScore).toBeCloseTo(1, 2);
    });

    it('PLAN §11 — fibra do catálogo é persistida (não descartada) e fiberPartial fica false quando todo item tem fibra conhecida', async () => {
      const found = await svc.parseAndResolve('100g de arroz tipo 1 cozido');
      const foodId = found.items[0].foodId!;
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', items: [{ kind: 'food', foodId, quantity: 100, unitType: 'grams' }], source: 'manual',
      });
      expect(log.items[0].fiberG).not.toBeNull();
      expect(log.fiberG).not.toBeNull();
      expect(log.fiberPartial).toBe(false);
    });

    it('PLAN §11 — item manual não tem fibra conhecida (null, nunca 0) e marca o log como fiberPartial', async () => {
      const found = await svc.parseAndResolve('100g de arroz tipo 1 cozido');
      const foodId = found.items[0].foodId!;
      const log = await svc.persistIntakeLog({
        userId, label: 'Mix',
        items: [
          { kind: 'food', foodId, quantity: 100, unitType: 'grams' },
          { kind: 'manual', name: 'Suplemento', energyKcal: 100, proteinG: 20, carbohydrateG: 0, fatG: 0 },
        ],
        source: 'manual',
      });
      expect(log.items[1].fiberG).toBeNull();
      expect(log.fiberPartial).toBe(true);
      // A soma de fibra é PARCIAL (só o item de catálogo), nunca vira null nem 0 fabricado.
      expect(log.fiberG).not.toBeNull();
      expect(log.fiberG).toBeGreaterThan(0);
    });

    it('rejeita item de catálogo com medida ausente (measureId e fallbackMeasureKey ausentes)', async () => {
      const found = await svc.parseAndResolve('100g de arroz tipo 1 cozido');
      const foodId = found.items[0]?.foodId;
      if (!foodId) throw new Error('fixture: catálogo sem arroz');
      await expect(
        svc.persistIntakeLog({
          userId, label: 'Teste', items: [{ kind: 'food', foodId, quantity: 1, unitType: 'measure' }], source: 'manual',
        })
      ).rejects.toThrow('measure_required');
    });

    it('IDOR: measureId de OUTRO alimento é rejeitado', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const feijao = (await svc.parseAndResolve('1 concha de feijao carioca cozido')).items[0];
      // measureId encontrado na resolução do feijão, usado contra o foodId do arroz.
      await expect(
        svc.persistIntakeLog({
          userId, label: 'Teste',
          items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 1, unitType: 'measure', measureId: feijao.measureId ?? -1 }],
          source: 'manual',
        })
      ).rejects.toThrow('measure_not_found_for_food');
    });

    it('item de baixa confiança sem confirmação é rejeitado (400 lógico)', async () => {
      // "pao" tende a casar com um item cujo primeiro segmento não é exatamente "pao"
      // dependendo do catálogo — simulamos low confidence diretamente via rawText
      // ambíguo que não bate com o nome do alimento escolhido.
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      await expect(
        svc.persistIntakeLog({
          userId, label: 'Teste',
          items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams', rawText: 'um pouco de comida qualquer', confirmed: false }],
          source: 'parse',
        })
      ).rejects.toThrow('low_confidence_item_needs_confirmation');
    });

    it('item de baixa confiança COM confirmação é aceito', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Teste',
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams', rawText: 'um pouco de comida qualquer', confirmed: true }],
        source: 'parse',
      });
      expect(log.items[0].confidence).toBe('low');
      expect(log.items[0].confirmed).toBe(true);
    });

    it('item de confiança MEDIUM (fuzzy "você quis dizer") também exige confirmação', async () => {
      const preview = await svc.parseAndResolve('100g de leite integral');
      const item = preview.items[0];
      expect(item.confidence).toBe('medium');
      await expect(
        svc.persistIntakeLog({
          userId, label: 'Teste',
          items: [{ kind: 'food', foodId: item.foodId!, quantity: 100, unitType: 'grams', rawText: '100g de leite integral', confirmed: false }],
          source: 'parse',
        })
      ).rejects.toThrow('low_confidence_item_needs_confirmation');

      const log = await svc.persistIntakeLog({
        userId, label: 'Teste',
        items: [{ kind: 'food', foodId: item.foodId!, quantity: 100, unitType: 'grams', rawText: '100g de leite integral', confirmed: true }],
        source: 'parse',
      });
      expect(log.items[0].confidence).toBe('medium');
      expect(log.items[0].confirmed).toBe(true);
    });

    it('item escolhido por busca explícita (sem rawText) é sempre high, mesmo com nome ambíguo', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Teste',
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 50, unitType: 'grams' }],
        source: 'manual',
      });
      expect(log.items[0].confidence).toBe('high');
    });

    it('item manual aceita macros diretos e valida faixa de kcal', async () => {
      const log = await svc.persistIntakeLog({
        userId, label: 'Barra proteica',
        items: [{ kind: 'manual', name: 'Barra proteica', energyKcal: 200, proteinG: 20, carbohydrateG: 15, fatG: 5 }],
        source: 'manual',
      });
      expect(log.items[0].resolver).toBe('manual');
      expect(log.confidenceScore).toBeCloseTo(0.8, 2);

      await expect(
        svc.persistIntakeLog({
          userId, label: 'Exagero',
          items: [{ kind: 'manual', name: 'X', energyKcal: 5000, proteinG: 0, carbohydrateG: 0, fatG: 0 }],
          source: 'manual',
        })
      ).rejects.toThrow('manual_kcal_too_high');
    });

    it('confidence_score do log é a média ponderada por kcal dos itens (nunca aceito do cliente)', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Mix',
        items: [
          { kind: 'food', foodId: arroz.foodId!, quantity: 200, unitType: 'grams' }, // resolver catalog, peso 1.0
          { kind: 'manual', name: 'Suplemento', energyKcal: 100, proteinG: 20, carbohydrateG: 0, fatG: 0 }, // resolver manual, peso 0.8
        ],
        source: 'manual',
      });
      const catalogKcal = log.items[0].energyKcal;
      const manualKcal = log.items[1].energyKcal;
      const expected = (catalogKcal * 1 + manualKcal * 0.8) / (catalogKcal + manualKcal);
      expect(log.confidenceScore).toBeCloseTo(expected, 2);
    });
  });

  describe('resolvePlanItem — IDOR e imutabilidade do snapshot', () => {
    let nutriId: number;
    let otherPatientId: number;
    let planMealItemId: number;

    beforeAll(async () => {
      nutriId = await createUser(client, TAG, 'nutri');
      otherPatientId = await createUser(client, TAG, 'outro-paciente');

      const plan = await client.query(
        `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
         VALUES ($1, $2, 'Plano teste', 'maintenance', 'active') RETURNING id`,
        [nutriId, otherPatientId]
      );
      const meal = await client.query(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Almoço', 'x') RETURNING id`,
        [plan.rows[0].id]
      );
      const item = await client.query(
        `INSERT INTO nutrition_meal_items
           (meal_id, food_id, quantity, unit_type, grams, food_name_snapshot,
            energy_kcal_snapshot, protein_g_snapshot, carbohydrate_g_snapshot, fat_g_snapshot)
         VALUES ($1, 1, 100, 'grams', 100, 'Arroz snapshot', 128, 2.5, 28, 0.2)
         RETURNING id`,
        [meal.rows[0].id]
      );
      planMealItemId = item.rows[0].id;
    });

    afterAll(async () => {
      await client.query(`DELETE FROM nutrition_plans WHERE nutri_id = $1`, [nutriId]);
    });

    it('rejeita cópia de item de plano de OUTRO usuário (IDOR)', async () => {
      await expect(
        svc.persistIntakeLog({ userId, label: 'Como no plano', items: [{ kind: 'plan', planMealItemId }], source: 'plan' })
      ).rejects.toThrow('plan_meal_item_not_found');
    });

    it('copia o snapshot corretamente para o dono do plano', async () => {
      const log = await svc.persistIntakeLog({
        userId: otherPatientId, label: 'Como no plano', items: [{ kind: 'plan', planMealItemId }], source: 'plan',
      });
      expect(log.items[0].name).toBe('Arroz snapshot');
      expect(log.items[0].energyKcal).toBe(128);
      expect(log.items[0].resolver).toBe('plan');
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [otherPatientId]);
    });
  });

  describe('CRUD do dia + favorito + soft delete', () => {
    it('getDayLogs devolve só logs não apagados do dia', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Café', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 50, unitType: 'grams' }], source: 'manual',
      });
      const today = log.dateKey;
      const logsBefore = await svc.getDayLogs(userId, today);
      expect(logsBefore.map((l) => l.id)).toContain(log.id);

      const deleted = await svc.softDeleteLog(userId, log.id);
      expect(deleted).toBe(true);
      const logsAfter = await svc.getDayLogs(userId, today);
      expect(logsAfter.map((l) => l.id)).not.toContain(log.id);
    });

    it('soft delete de log de OUTRO usuário não faz nada (IDOR)', async () => {
      const other = await createUser(client, TAG, 'outro-delete');
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId: other, label: 'Café', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 50, unitType: 'grams' }], source: 'manual',
      });
      const deleted = await svc.softDeleteLog(userId, log.id);
      expect(deleted).toBe(false);
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [other]);
      await client.query(`DELETE FROM users WHERE id = $1`, [other]);
    });

    it('favoritar marca is_favorite', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Omelete', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 50, unitType: 'grams' }], source: 'manual',
      });
      const ok = await svc.setFavorite(userId, log.id, true);
      expect(ok).toBe(true);
      const logs = await svc.getDayLogs(userId, log.dateKey);
      expect(logs.find((l) => l.id === log.id)?.isFavorite).toBe(true);
    });
  });

  describe('classifyDayCoverage', () => {
    const mkLog = (kcal: number, confidence: number) => ({ energyKcal: kcal, confidenceScore: confidence } as any);

    it('high requer cobertura >= 0.75 E confiança >= 0.80', () => {
      const logs = [mkLog(500, 1), mkLog(500, 1), mkLog(500, 1)];
      expect(svc.classifyDayCoverage(logs, 4).level).toBe('high');
    });

    it('cobertura alta mas confiança baixa cai para partial/low, nunca high', () => {
      const logs = [mkLog(500, 0.5), mkLog(500, 0.5), mkLog(500, 0.5), mkLog(500, 0.5)];
      expect(svc.classifyDayCoverage(logs, 4).level).not.toBe('high');
    });

    it('um único lanche de baixa cobertura fica low, não puxa média nenhuma', () => {
      const logs = [mkLog(200, 1)];
      const c = svc.classifyDayCoverage(logs, 4);
      expect(c.level).toBe('low');
      expect(c.coverageRatio).toBe(0.25);
    });

    it('sem logs no dia é low com coverageRatio 0', () => {
      const c = svc.classifyDayCoverage([], 4);
      expect(c.level).toBe('low');
      expect(c.coverageRatio).toBe(0);
    });
  });
});
