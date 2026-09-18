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
import { dayKey, shiftDayKey } from '../utils/appDay';
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
    // `pool.end()` fica no ÚLTIMO describe do arquivo (contrato HTTP,
    // abaixo) — encerrar aqui quebraria as rotas montadas por supertest
    // nesse outro bloco, que reusam o MESMO pool singleton de
    // `config/database.ts` e correm depois deste no mesmo processo.
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

    // Adendo "Preparações" §10 — regressão obrigatória: "2 ovos fritos" não
    // pode virar "2 ovos" (preparo descartado) nem ficar unresolved.
    describe('regressão — "2 ovos fritos" (preparo nunca descartado)', () => {
      it.each(['2 ovos fritos', '2 ovo frito', '200g de frango grelhado', '150 gramas de arroz cozido', '1 banana prata'])(
        '"%s": alimento (com preparo/variante quando existir) identificado, kcal calculado, sem busca manual',
        async (input) => {
          const preview = await svc.parseAndResolve(input);
          expect(preview.items).toHaveLength(1);
          const item = preview.items[0];
          expect(item.resolved).toBe(true);
          expect(item.grams).toBeGreaterThan(0);
          expect(item.energyKcal).toBeGreaterThan(0);
          expect(['high', 'medium']).toContain(item.confidence);
        },
      );

      it('"2 ovos fritos" identifica especificamente o ovo FRITO, não o cru genérico', async () => {
        const preview = await svc.parseAndResolve('2 ovos fritos');
        expect(preview.items[0].name).toBe('Ovo, de galinha, inteiro, frito');
      });

      it('"200g de frango grelhado" identifica o peito grelhado (não outra parte/preparo)', async () => {
        const preview = await svc.parseAndResolve('200g de frango grelhado');
        expect(preview.items[0].name).toBe('Frango, peito, sem pele, grelhado');
        expect(preview.items[0].confidence).toBe('high');
      });

      // Gap documentado (§13): "mexido" não existe no catálogo TACO — nunca
      // fabricamos macro para ele; a diferença visível é a confiança, não a
      // ausência de item.
      it('"2 ovos mexidos": catálogo não tem "mexido" — nunca confiança high', async () => {
        const preview = await svc.parseAndResolve('2 ovos mexidos');
        const item = preview.items[0];
        if (item.resolved) expect(item.confidence).not.toBe('high');
      });
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

  // PLAN P1B corrective — "Consulta + Edição de Refeição Registrada".
  describe('updateIntakeLog — edição de conteúdo (recálculo server-side)', () => {
    it('UPDATE: "2 ovos" → "3 ovos" recalcula macros sem duplicar registro', async () => {
      const ovo = (await svc.parseAndResolve('2 ovos')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Café', items: [{ kind: 'food', foodId: ovo.foodId!, quantity: ovo.grams!, unitType: 'grams' }], source: 'manual',
      });

      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Café', items: [{ kind: 'food', foodId: ovo.foodId!, quantity: ovo.grams! * 1.5, unitType: 'grams' }], source: 'manual',
      });

      expect(updated?.id).toBe(log.id); // mesmo registro, nunca um segundo
      expect(updated!.energyKcal).toBeGreaterThan(log.energyKcal);
      expect(updated!.dateKey).toBe(log.dateKey); // data original preservada (§9)

      const logs = await svc.getDayLogs(userId, log.dateKey);
      expect(logs.filter((l) => l.label === 'Café')).toHaveLength(1); // sem duplicação
    });

    it('ADD ITEM: editar para incluir um alimento novo aumenta o total', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual',
      });

      const frango = (await svc.parseAndResolve('100g de frango grelhado')).items[0];
      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Almoço',
        items: [
          { kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' },
          { kind: 'food', foodId: frango.foodId!, quantity: 100, unitType: 'grams' },
        ],
        source: 'manual',
      });

      expect(updated!.items).toHaveLength(2);
      expect(updated!.energyKcal).toBeGreaterThan(log.energyKcal);
    });

    it('REMOVE ITEM: editar para remover um alimento reduz o total', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const frango = (await svc.parseAndResolve('100g de frango grelhado')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço',
        items: [
          { kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' },
          { kind: 'food', foodId: frango.foodId!, quantity: 100, unitType: 'grams' },
        ],
        source: 'manual',
      });

      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Almoço', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual',
      });

      expect(updated!.items).toHaveLength(1);
      expect(updated!.energyKcal).toBeLessThan(log.energyKcal);
    });

    it('OWNERSHIP: usuário A não pode editar log do usuário B', async () => {
      const other = await createUser(client, TAG, 'outro-update');
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId: other, label: 'Café', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual',
      });

      const result = await svc.updateIntakeLog(userId, log.id, {
        label: 'Hackeado', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 999, unitType: 'grams' }], source: 'manual',
      });
      expect(result).toBeNull();

      // Confirma que nada mudou no log da vítima.
      const logsOther = await svc.getDayLogs(other, log.dateKey);
      expect(logsOther[0].label).toBe('Café');

      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [other]);
      await client.query(`DELETE FROM users WHERE id = $1`, [other]);
    });

    it('editar log inexistente/já apagado devolve null (404 lógico)', async () => {
      const result = await svc.updateIntakeLog(userId, 999999999, {
        label: 'x', items: [{ kind: 'manual', name: 'x', energyKcal: 10, proteinG: 1, carbohydrateG: 1, fatG: 1 }], source: 'manual',
      });
      expect(result).toBeNull();
    });

    it('valida itens da mesma forma que a criação (label vazio rejeitado)', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz tipo 1 cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Café', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual',
      });
      await expect(
        svc.updateIntakeLog(userId, log.id, { label: '', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual' })
      ).rejects.toThrow('label_required');
    });

    describe('PLAN SAFETY — editar intake nunca modifica a prescrição do Nutri', () => {
      it('editar um log com item "plan" não altera nutrition_plan_meals/nutrition_meal_items', async () => {
        const nutriId = await createUser(client, TAG, 'nutri-safety');
        const patientId = await createUser(client, TAG, 'paciente-safety');
        const plan = await client.query(
          `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
           VALUES ($1, $2, 'Plano teste', 'maintenance', 'active') RETURNING id`,
          [nutriId, patientId]
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
        const planMealItemId = item.rows[0].id;
        const mealSnapshotBefore = await client.query(`SELECT * FROM nutrition_plan_meals WHERE id = $1`, [meal.rows[0].id]);
        const itemSnapshotBefore = await client.query(`SELECT * FROM nutrition_meal_items WHERE id = $1`, [planMealItemId]);

        const log = await svc.persistIntakeLog({
          userId: patientId, label: 'Como no plano', items: [{ kind: 'plan', planMealItemId }], source: 'plan',
        });
        const manual = { kind: 'manual' as const, name: 'Extra', energyKcal: 50, proteinG: 1, carbohydrateG: 5, fatG: 1 };
        const updated = await svc.updateIntakeLog(patientId, log.id, {
          label: 'Como no plano + extra', items: [{ kind: 'plan', planMealItemId }, manual], source: 'plan',
        });
        expect(updated!.items).toHaveLength(2);

        const mealSnapshotAfter = await client.query(`SELECT * FROM nutrition_plan_meals WHERE id = $1`, [meal.rows[0].id]);
        const itemSnapshotAfter = await client.query(`SELECT * FROM nutrition_meal_items WHERE id = $1`, [planMealItemId]);
        expect(mealSnapshotAfter.rows[0]).toEqual(mealSnapshotBefore.rows[0]);
        expect(itemSnapshotAfter.rows[0]).toEqual(itemSnapshotBefore.rows[0]);

        await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
        await client.query(`DELETE FROM nutrition_plans WHERE nutri_id = $1`, [nutriId]);
      });
    });
  });

  // PLAN P1B corrective — "Agrupamento por Refeição + Refeição Extra +
  // Janela de Edição". Personas A-I do Harness (§25).
  describe('groupLogsIntoMeals + merge-on-create + janela de edição', () => {
    let nutriId: number;
    let planMealId: number; // "Café da manhã" do plano

    beforeAll(async () => {
      nutriId = await createUser(client, TAG, 'nutri-meals');
      const plan = await client.query(
        `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
         VALUES ($1, $2, 'Plano teste', 'maintenance', 'active') RETURNING id`,
        [nutriId, userId]
      );
      const meal = await client.query(
        `INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Café da manhã', 'x') RETURNING id`,
        [plan.rows[0].id]
      );
      planMealId = meal.rows[0].id;
    });

    afterAll(async () => {
      await client.query(`DELETE FROM nutrition_plans WHERE nutri_id = $1`, [nutriId]);
    });

    it('A — CAFÉ NORMAL: "1 pão francês e 2 ovos fritos" de uma vez gera 1 card, 2 itens', async () => {
      const pao = (await svc.parseAndResolve('1 pão francês')).items[0];
      const ovos = (await svc.parseAndResolve('2 ovos fritos')).items[0];
      await svc.persistIntakeLog({
        userId, label: 'Café da manhã', mealId: planMealId,
        items: [
          { kind: 'food', foodId: pao.foodId!, quantity: pao.grams!, unitType: 'grams' },
          { kind: 'food', foodId: ovos.foodId!, quantity: ovos.grams!, unitType: 'grams' },
        ],
        source: 'manual',
      });

      const logs = await svc.getDayLogs(userId, dayKey());
      const meals = svc.groupLogsIntoMeals(logs);
      const cafe = meals.find((m) => m.mealId === planMealId)!;
      expect(cafe.items).toHaveLength(2);
      expect(cafe.isExtra).toBe(false);
      expect(cafe.sourceLogIds).toHaveLength(1);
    });

    it('B — ADICIONAR DEPOIS: 2ª chamada para a MESMA refeição do plano funde na MESMA linha (nunca 2 cards)', async () => {
      const pao = (await svc.parseAndResolve('1 pão francês')).items[0];
      const ovos = (await svc.parseAndResolve('2 ovos')).items[0];

      await svc.persistIntakeLog({
        userId, label: 'Café da manhã', mealId: planMealId,
        items: [{ kind: 'food', foodId: pao.foodId!, quantity: pao.grams!, unitType: 'grams' }],
        source: 'manual',
      });
      await svc.persistIntakeLog({
        userId, label: 'Café da manhã', mealId: planMealId,
        items: [{ kind: 'food', foodId: ovos.foodId!, quantity: ovos.grams!, unitType: 'grams' }],
        source: 'manual',
      });

      const logs = await svc.getDayLogs(userId, dayKey());
      const rowsForMeal = logs.filter((l) => l.mealId === planMealId);
      expect(rowsForMeal).toHaveLength(1); // UMA linha física — merge no create, nunca duplica (§26)

      const meals = svc.groupLogsIntoMeals(logs);
      const cafe = meals.find((m) => m.mealId === planMealId)!;
      expect(cafe.items).toHaveLength(2);
      expect(cafe.energyKcal).toBeGreaterThan(0);
    });

    it('C — REFEIÇÃO EXTRA: "30g whey" (ou manual quando o catálogo não resolve) vira card próprio, extra, conta nos totais, nunca altera o plano', async () => {
      const before = await client.query(`SELECT * FROM nutrition_plan_meals WHERE id = $1`, [planMealId]);

      const preview = await svc.parseAndResolve('30g whey');
      const wheyItem = preview.items[0];
      // Catálogo TACO não tem whey (confirmado na investigação) — o item
      // pode vir não resolvido; nesse caso o fluxo real é resolução manual
      // (custom food), reproduzido aqui como item `manual` com macros
      // explícitas do usuário — nunca inventadas pelo servidor.
      const items = wheyItem.resolved
        ? [{ kind: 'food' as const, foodId: wheyItem.foodId!, quantity: wheyItem.grams ?? 30, unitType: 'grams' as const }]
        : [{ kind: 'manual' as const, name: 'Whey protein (30g)', grams: 30, energyKcal: 120, proteinG: 24, carbohydrateG: 3, fatG: 1 }];

      const log = await svc.persistIntakeLog({
        userId, label: 'Lanche da manhã', mealId: null, items, source: 'manual',
      });
      expect(log.mealId).toBeNull();

      const logs = await svc.getDayLogs(userId, dayKey());
      const meals = svc.groupLogsIntoMeals(logs);
      const extra = meals.find((m) => m.groupKey === `log:${log.id}`)!;
      expect(extra.isExtra).toBe(true);
      expect(extra.energyKcal).toBeGreaterThan(0);

      const totalKcal = logs.reduce((s, l) => s + l.energyKcal, 0);
      expect(totalKcal).toBeGreaterThanOrEqual(extra.energyKcal); // extra soma no realizado do dia

      const after = await client.query(`SELECT * FROM nutrition_plan_meals WHERE id = $1`, [planMealId]);
      expect(after.rows[0]).toEqual(before.rows[0]); // plano do Nutri intocado
    });

    it('D — ALMOÇO: "200g carne + 100g arroz + 60g legumes" extra gera 1 card com 3 itens, card do café intacto', async () => {
      const carne = (await svc.parseAndResolve('200g de carne bovina')).items[0];
      const arroz = (await svc.parseAndResolve('100g de arroz cozido')).items[0];

      await svc.persistIntakeLog({
        userId, label: 'Almoço', mealId: null,
        items: [
          { kind: 'food', foodId: carne.foodId!, quantity: carne.grams ?? 200, unitType: 'grams' },
          { kind: 'food', foodId: arroz.foodId!, quantity: arroz.grams ?? 100, unitType: 'grams' },
          { kind: 'manual', name: 'Legumes', grams: 60, energyKcal: 40, proteinG: 2, carbohydrateG: 8, fatG: 0.3 },
        ],
        source: 'manual',
      });

      const logs = await svc.getDayLogs(userId, dayKey());
      const meals = svc.groupLogsIntoMeals(logs);
      const almoco = meals.find((m) => m.label === 'Almoço')!;
      expect(almoco.items).toHaveLength(3);
      expect(almoco.isExtra).toBe(true);
    });

    it('E — EDITAR: 100g arroz → 150g arroz na mesma refeição recalcula o total, mesma refeição', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', mealId: null,
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }],
        source: 'manual',
      });

      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Almoço', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 150, unitType: 'grams' }], source: 'manual',
      });
      expect(updated!.id).toBe(log.id);
      expect(updated!.energyKcal).toBeGreaterThan(log.energyKcal);
    });

    it('F — EXCLUIR ITEM: remover legumes mantém a refeição com os demais itens', async () => {
      const carne = (await svc.parseAndResolve('200g de carne bovina')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', mealId: null,
        items: [
          { kind: 'food', foodId: carne.foodId!, quantity: 200, unitType: 'grams' },
          { kind: 'manual', name: 'Legumes', grams: 60, energyKcal: 40, proteinG: 2, carbohydrateG: 8, fatG: 0.3 },
        ],
        source: 'manual',
      });
      expect(log.items).toHaveLength(2);

      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Almoço', items: [{ kind: 'food', foodId: carne.foodId!, quantity: 200, unitType: 'grams' }], source: 'manual',
      });
      expect(updated!.items).toHaveLength(1);
      expect(updated!.items[0].name).not.toBe('Legumes');
    });

    it('G — EXCLUIR REFEIÇÃO: soft delete some do dia e do realizado', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço', mealId: null,
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }],
        source: 'manual',
      });

      const ok = await svc.softDeleteLog(userId, log.id);
      expect(ok).toBe(true);
      const logs = await svc.getDayLogs(userId, log.dateKey);
      expect(logs.map((l) => l.id)).not.toContain(log.id);
    });

    it('H — ONTEM: log de ontem não aparece em getDayLogs(hoje), mas aparece em getDayLogs(ontem) e permanece editável', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Jantar de ontem', mealId: null,
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }],
        source: 'manual',
      });
      const yesterday = shiftDayKey(dayKey(), -1);
      await client.query(`UPDATE user_nutrition_intake_logs SET date_key = $1 WHERE id = $2`, [yesterday, log.id]);

      const todayLogs = await svc.getDayLogs(userId, dayKey());
      expect(todayLogs.map((l) => l.id)).not.toContain(log.id);

      const yesterdayLogs = await svc.getDayLogs(userId, yesterday);
      expect(yesterdayLogs.map((l) => l.id)).toContain(log.id);

      // Ontem ainda está dentro da janela de edição.
      const updated = await svc.updateIntakeLog(userId, log.id, {
        label: 'Jantar de ontem', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 120, unitType: 'grams' }], source: 'manual',
      });
      expect(updated).not.toBeNull();
    });

    it('I — ANTEONTEM: backend bloqueia PATCH e DELETE (edit window excedida)', async () => {
      const arroz = (await svc.parseAndResolve('100g de arroz cozido')).items[0];
      const log = await svc.persistIntakeLog({
        userId, label: 'Almoço de anteontem', mealId: null,
        items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }],
        source: 'manual',
      });
      const twoDaysAgo = shiftDayKey(dayKey(), -2);
      await client.query(`UPDATE user_nutrition_intake_logs SET date_key = $1 WHERE id = $2`, [twoDaysAgo, log.id]);

      await expect(
        svc.updateIntakeLog(userId, log.id, { label: 'x', items: [{ kind: 'food', foodId: arroz.foodId!, quantity: 100, unitType: 'grams' }], source: 'manual' })
      ).rejects.toThrow('edit_window_exceeded');

      await expect(svc.softDeleteLog(userId, log.id)).rejects.toThrow('edit_window_exceeded');

      // Leitura/histórico continua preservado — nunca apagado, só não editável pelo aluno.
      const logs = await svc.getDayLogs(userId, twoDaysAgo);
      expect(logs.map((l) => l.id)).toContain(log.id);
    });
  });

  // PLAN P1B.1 ("Smart Food Logging" spike, set/2026) — corpus dos 8 casos do
  // spike como harness permanente, mais os caveats explícitos do usuário.
  describe('P1B.1 — Smart Food Logging (volume, histórico, IA opcional)', () => {
    it('"200ml de leite integral" preserva quantidade/unidade e NUNCA vira "integral" silenciosamente (caveat 4) — fica não resolvido, nunca "informe em gramas" (caveat 3)', async () => {
      const preview = await svc.parseAndResolve('200ml de leite integral');
      const item = preview.items[0];
      expect(item.resolved).toBe(false);
      // A quantidade/unidade que o usuário disse continuam visíveis — nunca
      // reescritas para "g", nunca perdidas.
      expect(item.quantity).toBe(200);
      expect(item.unitLabel).toBe('ml');
    });

    it('"1 xícara de café" resolve a BEBIDA (infusão), não o pó — desambiguação por medida de volume', async () => {
      const preview = await svc.parseAndResolve('1 xícara de café');
      const item = preview.items[0];
      expect(item.resolved).toBe(true);
      expect(item.confidence).toBe('high');
      expect(item.name).toMatch(/infus/i);
    });

    it('"1 scoop de whey" e "30g de whey" seguem não resolvidos no catálogo (sem banco externo) — mas preservam a unidade dita', async () => {
      const scoop = (await svc.parseAndResolve('1 scoop de whey')).items[0];
      expect(scoop.resolved).toBe(false);
      expect(scoop.unitLabel).toBe('scoop');

      const grams = (await svc.parseAndResolve('30g de whey')).items[0];
      expect(grams.resolved).toBe(false);
      expect(grams.quantity).toBe(30);
      expect(grams.unitLabel).toBe('g');
    });

    it('caveat 6 — 2º lançamento de whey reaproveita o histórico do PRÓPRIO usuário (rápido, sem formulário de novo)', async () => {
      await svc.persistIntakeLog({
        userId, label: 'Lanche', mealId: null, source: 'manual',
        items: [{
          kind: 'manual', name: 'Whey Integralmedica', grams: 30,
          energyKcal: 120, proteinG: 24, carbohydrateG: 3, fatG: 1,
          displayQuantity: 30, displayUnitLabel: 'g',
        }],
      });

      const bareScoop = (await svc.parseAndResolve('1 scoop de whey', userId)).items[0];
      expect(bareScoop.resolved).toBe(true);
      expect(bareScoop.resolver).toBe('history');
      expect(bareScoop.confidence).toBe('high');
      expect(bareScoop.energyKcal).toBe(120);

      // Massa explícita diferente da vez anterior → escala pelo per-100g
      // derivado do histórico, nunca reaproveita o total antigo como está.
      const scaled = (await svc.parseAndResolve('60g de whey', userId)).items[0];
      expect(scaled.resolved).toBe(true);
      expect(scaled.resolver).toBe('history');
      expect(scaled.grams).toBe(60);
      expect(scaled.energyKcal).toBe(240);
    });

    it('histórico é escopado por usuário — item manual de OUTRO usuário nunca é reaproveitado', async () => {
      const otherUserId = await createUser(client, `${TAG}-other`, 'aluno');
      try {
        await svc.persistIntakeLog({
          userId: otherUserId, label: 'Lanche', mealId: null, source: 'manual',
          items: [{
            kind: 'manual', name: 'Suplemento Exclusivo Do Outro', grams: 20,
            energyKcal: 80, proteinG: 10, carbohydrateG: 2, fatG: 1,
          }],
        });
        const preview = await svc.parseAndResolve('suplemento exclusivo do outro', userId);
        expect(preview.items[0].resolved).toBe(false);
      } finally {
        await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [otherUserId]);
        await client.query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
      }
    });

    it('caveat 1/5 — IA (mock injetado) só entra quando o determinístico deixa algo não resolvido, e a confiança final vem do Resolver (nunca capada por causa da IA)', async () => {
      const { interpretIntakeTextWithAi } = await import('../services/ai/intakeInterpreterAi');
      const mockCallModel = async () =>
        JSON.stringify({ items: [{ foodQuery: 'pao frances', quantity: 1, unit: 'unidade' }] });

      const tokens = await interpretIntakeTextWithAi('um pão francês inteiro', userId, { callModel: mockCallModel });
      expect(tokens).not.toBeNull();
      expect(tokens![0].foodQuery).toBe('pao frances');

      // A IA nunca produz macro — o contrato de saída não tem esse campo.
      const raw = await mockCallModel();
      expect(JSON.parse(raw).items[0]).not.toHaveProperty('energyKcal');

      // Resolvido pelo Resolver determinístico a partir do token da IA — vira
      // 'alias'/high como qualquer texto digitado, nunca um teto artificial.
      const resolved = await svc.resolveTokenForPreview(tokens![0], userId);
      expect(resolved.resolved).toBe(true);
      expect(resolved.confidence).toBe('high');
    });

    it('IA com resposta inválida nunca quebra o fluxo — cai para `null`, chamador usa o determinístico', async () => {
      const { interpretIntakeTextWithAi } = await import('../services/ai/intakeInterpreterAi');
      const brokenModel = async () => 'isto não é json';
      const tokens = await interpretIntakeTextWithAi('qualquer coisa', userId, { callModel: brokenModel });
      expect(tokens).toBeNull();
    });

    it('parseAndResolve nunca chama a IA quando tudo já resolveu no determinístico (caminho feliz sem latência extra)', async () => {
      let called = false;
      const spyModel = async () => { called = true; return '{"items":[]}'; };
      await svc.parseAndResolve('1 pão francês', userId, { callModel: spyModel });
      expect(called).toBe(false);
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

// PLAN P1B corrective ("Agrupamento por Refeição") — achado do QA em
// navegador real: `POST /nutrition-intake` para uma refeição EXTRA
// (`mealId: null` explícito no corpo, não omitido) quebrava com 500 —
// `Number(null) === 0` e `Number.isFinite(0) === true`, então a rota
// coagia `null` para `0` e a FK de `meal_id` rejeitava (nenhuma
// `nutrition_plan_meals.id` é 0). O service (`persistIntakeLog`) nunca
// teve esse bug — só a rota, por isso só aparece num teste HTTP de verdade,
// nunca chamando o service direto (mesma lição já registrada no
// changelog do produto para outros módulos: "P0 anterior — teste HTTP
// ponta a ponta").
describeWithDb('POST /api/user/nutrition-intake — contrato HTTP', () => {
  let client: Client;
  let userId: number;
  let app: import('express').Express;
  let token: (userId: number) => string;

  beforeAll(async () => {
    client = await connect();
    await acquireSuiteLock(client);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-http-%@test.local`]);
    userId = await createUser(client, `${TAG}-http`, 'aluno');

    const express = (await import('express')).default;
    const userRoutes = (await import('../routes/user')).default;
    const { generateAccessToken } = await import('../utils/jwt');

    app = express();
    app.use(express.json());
    app.use('/api/user', userRoutes);

    token = (uid) => generateAccessToken({ id: uid, email: `${uid}@test.local`, role: 'user', profileCompleted: true, products: ['app'] });
  });

  afterAll(async () => {
    await finishSuite(client, async () => {
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-http-%@test.local`]);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
  });

  it('refeição extra com mealId:null explícito no corpo cria o log (201), nunca 500', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/user/nutrition-intake')
      .set('Authorization', `Bearer ${token(userId)}`)
      .send({
        label: 'Lanche da tarde',
        rawText: null,
        mealId: null,
        items: [{ kind: 'manual', name: 'Whey protein (30g)', grams: 30, energyKcal: 120, proteinG: 24, carbohydrateG: 3, fatG: 1 }],
        source: 'parse',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.mealId).toBeNull();
  });

  it('refeição de plano com mealId numérico continua funcionando (regressão)', async () => {
    const request = (await import('supertest')).default;
    const nutriId = await createUser(client, `${TAG}-http`, 'nutri');
    const plan = await client.query(
      `INSERT INTO nutrition_plans (nutri_id, patient_id, title, objective, status)
       VALUES ($1, $2, 'Plano teste', 'maintenance', 'active') RETURNING id`,
      [nutriId, userId]
    );
    const meal = await client.query(
      `INSERT INTO nutrition_plan_meals (plan_id, name, orientation) VALUES ($1, 'Almoço', 'x') RETURNING id`,
      [plan.rows[0].id]
    );

    const res = await request(app)
      .post('/api/user/nutrition-intake')
      .set('Authorization', `Bearer ${token(userId)}`)
      .send({
        label: 'Almoço',
        mealId: meal.rows[0].id,
        items: [{ kind: 'manual', name: 'Arroz', grams: 100, energyKcal: 128, proteinG: 2.5, carbohydrateG: 28, fatG: 0.2 }],
        source: 'manual',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.mealId).toBe(meal.rows[0].id);

    await client.query(`DELETE FROM nutrition_plans WHERE nutri_id = $1`, [nutriId]);
  });
});
