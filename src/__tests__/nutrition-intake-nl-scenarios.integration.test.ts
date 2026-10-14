/**
 * Registro alimentar incremental — P1: cenários de linguagem natural do PO contra o catálogo REAL (banco de teste).
 * Trava o comportamento determinístico (sem IA: nenhum userId, nenhuma chamada externa) e as quatro correções da P1:
 * "200 ml de leite" (volume só entre alimentos com densidade), água pura (0 kcal, nunca "Coco, água de"),
 * "1 banana média" e fibra de item zerado. O que continua propositalmente pedindo confirmação/identificação
 * (café com leite, biscoito, iogurte em ml, azeite, "porção de comida") fica registrado aqui como contrato.
 */
import { connect, acquireSuiteLock, finishSuite, createUser, describeWithDb, hasTestDb } from './helpers/integrationDb';
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

type Svc = typeof import('../services/nutritionIntakeService');

describeWithDb('linguagem natural — cenários P1 (catálogo real, determinístico)', () => {
  let client: Client;
  let svc: Svc;
  let userId: number;

  beforeAll(async () => {
    client = await connect();
    await acquireSuiteLock(client);
    await client.query(`DELETE FROM users WHERE email LIKE $1`, [`nlp1-%@test.local`]);
    userId = await createUser(client, 'nlp1' as never, 'aluno');
    svc = await import('../services/nutritionIntakeService');
  });

  afterAll(async () => {
    await finishSuite(client, async () => {
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`nlp1-%@test.local`]);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  const one = async (text: string) => (await svc.parseAndResolve(text)).items[0] as any;

  describe('resolvem direto (alta confiança, sem pedir confirmação)', () => {
    it('2 ovos fritos → ovo frito, 2 unidades, preparo preservado', async () => {
      const i = await one('2 ovos fritos');
      expect(i).toMatchObject({ resolved: true, name: 'Ovo, de galinha, inteiro, frito', quantity: 2, unitLabel: 'unidade', grams: 100, confidence: 'high' });
      expect(i.canonicalFood?.preparation).toBe('frito');
    });
    it('200 ml de leite integral → ml preservado, densidade curada (206 g)', async () => {
      const i = await one('200 ml de leite integral');
      expect(i).toMatchObject({ resolved: true, name: 'Leite, de vaca, integral', quantity: 200, unitLabel: 'ml', grams: 206, confidence: 'high' });
    });
    it('1 scoop de whey → 28,7 g da medida curada', async () => {
      const i = await one('1 scoop de whey');
      expect(i).toMatchObject({ resolved: true, unitLabel: 'scoop', grams: 28.7, confidence: 'high' });
    });
    it('1 pão francês e 100 g de arroz cozido', async () => {
      expect(await one('1 pão francês')).toMatchObject({ resolved: true, name: 'Pão, trigo, francês', grams: 50, confidence: 'high' });
      expect(await one('100 g de arroz cozido')).toMatchObject({ resolved: true, name: 'Arroz, tipo 1, cozido', grams: 100, unitLabel: 'g', confidence: 'high' });
    });
    it('100 g de arroz branco → arroz tipo 1 cozido (antes sugeria "Arroz carreteiro" em baixa confiança)', async () => {
      expect(await one('100 g de arroz branco')).toMatchObject({ resolved: true, name: 'Arroz, tipo 1, cozido', confidence: 'high', grams: 100 });
    });
    it('1 banana média → banana prata, medida curada "unidade média" (70 g) — "média" não atrapalha o alimento', async () => {
      const i = await one('1 banana média');
      expect(i).toMatchObject({ resolved: true, name: 'Banana, prata, crua', grams: 70, confidence: 'high' });
    });
    it('"banana grande" NÃO usa a medida média por engano (cai para confirmação/identificação)', async () => {
      const i = await one('1 banana grande');
      expect(i.confidence === 'high' && i.resolved).toBe(false);
    });
  });

  describe('leite sem qualificador com volume (P1)', () => {
    it('200 ml de leite → sugere leite de vaca com densidade, em confiança MÉDIA (nunca grava sozinho) + variante alternativa', async () => {
      const i = await one('200 ml de leite');
      expect(i).toMatchObject({ resolved: true, name: 'Leite, de vaca, integral', unitLabel: 'ml', quantity: 200, grams: 206, confidence: 'medium', confirmed: false });
      expect(i.canonicalFood).toMatchObject({ baseFood: 'leite', variant: 'integral' });
      expect(i.candidates?.map((c: any) => c.canonicalFood.variant)).toEqual(['desnatado']); // chip "Leite desnatado"
      expect((await svc.parseAndResolve('200 ml de leite')).needsConfirmation).toBe(true);
    });
    it('1 pão, 2 ovos e 200 ml de leite → 3 itens, sem perder nem duplicar', async () => {
      const { items } = await svc.parseAndResolve('1 pão, 2 ovos e 200 ml de leite');
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.rawText)).toEqual(['1 pão', '2 ovos', '200 ml de leite']);
      expect(items[2].resolved).toBe(true);
    });
    it('1 copo / 1 xícara de leite → leite de vaca com respaldo (não "Leite, condensado" com 625 kcal), sempre com confirmação', async () => {
      const copo = await one('1 copo de leite');
      expect(copo).toMatchObject({ name: 'Leite, de vaca, integral', unitLabel: 'copo', confidence: 'medium', confirmed: false });
      expect(copo.energyKcal).toBeLessThan(200);
      expect(await one('1 xícara de leite')).toMatchObject({ name: 'Leite, de vaca, integral', unitLabel: 'xícara', confidence: 'medium' });
    });
    it('volume que já resolvia com respaldo não muda ("1 copo de suco", "200 ml de refrigerante", "1 copo de água de coco")', async () => {
      expect((await one('1 copo de suco')).name).toMatch(/suco/i);
      expect((await one('200 ml de refrigerante')).name).toMatch(/Refrigerante/);
      expect(await one('1 copo de água de coco')).toMatchObject({ name: 'Coco, água de', confidence: 'high' });
    });
    it('leite SEM volume (massa/contagem) não é tocado pelo fallback de volume', async () => {
      const i = await one('200 g de leite');
      expect(i.name).not.toBe('Leite, de vaca, integral'); // continua com o comportamento anterior (sem escolha silenciosa)
    });
  });

  describe('água pura (P1)', () => {
    it('30 g de whey com 200 ml de água → 2 itens; água = 0 kcal, 200 g, nunca "Coco, água de"', async () => {
      const { items } = await svc.parseAndResolve('30 g de whey com 200 ml de água');
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ name: 'Whey protein, isolado', grams: 30, confidence: 'high' });
      expect(items[1]).toMatchObject({ resolved: true, name: 'Água', grams: 200, energyKcal: 0, resolver: 'manual', confidence: 'high', confirmed: true });
    });
    it('1 copo de água → 200 g; "água de coco" continua sendo água de coco', async () => {
      expect(await one('1 copo de água')).toMatchObject({ name: 'Água', grams: 200, energyKcal: 0 });
      expect((await one('200 ml de água de coco')).name).toMatch(/Coco/);
    });
    it('item de água persiste sem marcar o dia como "fibra parcial"', async () => {
      const water = await one('300 ml de água');
      const log = await svc.persistIntakeLog({
        userId, label: 'Hidratação', rawText: '300 ml de água', mealId: null, source: 'parse',
        items: [{ kind: 'manual', name: water.name, grams: water.grams, energyKcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0, displayQuantity: water.quantity, displayUnitLabel: water.unitLabel }],
      } as any);
      expect(log.items[0]).toMatchObject({ name: 'Água', grams: 300, energyKcal: 0, fiberG: 0, unitLabel: 'ml' });
      expect(log.fiberPartial).toBe(false);
      await client.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [userId]);
    });
  });

  describe('pedem confirmação/identificação — nada é inventado', () => {
    it('1 xícara de café sem açúcar → infusão, baixa confiança (exige toque)', async () => {
      const i = await one('1 xícara de café sem açúcar');
      expect(i).toMatchObject({ resolved: true, unitLabel: 'xícara', confirmed: false });
      expect(i.name).toMatch(/infusão/i);
      expect(i.confidence).not.toBe('high');
    });
    it('1 copo de café com leite → nunca entra sem confirmação', async () => {
      const i = await one('1 copo de café com leite');
      expect(i.confirmed).toBe(false);
      expect(i.confidence).not.toBe('high');
    });
    it('2 fatias de pão integral → quantidade e medida preservadas, confirmação média', async () => {
      const i = await one('2 fatias de pão integral');
      expect(i).toMatchObject({ resolved: true, quantity: 2, unitLabel: 'fatia', confidence: 'medium', confirmed: false });
    });
    it.each([
      ['3 biscoitos recheados'], // sem peso por unidade no catálogo → não inventa porção
      ['150 ml de iogurte'], // sem densidade curada → não converte ml em g
      ['1 colher de azeite'], // azeite fora do catálogo; "colher" sem sopa/chá
      ['1 porção de comida'],
    ])('%s → não resolvido, sem macros inventados', async (text) => {
      const i = await one(text);
      expect(i.resolved).toBe(false);
      expect(i.energyKcal).toBeUndefined();
      expect((await svc.parseAndResolve(text)).needsConfirmation).toBe(true);
    });
  });
});
