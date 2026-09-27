/**
 * PLAN CANONICAL_FOOD_MODEL_SPIKE.md — regressão do bug relatado no QA:
 * "50g de whey" não resolvia num banco JÁ seedado antes do import USDA, mesmo
 * depois do deploy do código, porque `seedNutritionFoodsIfEmpty` só rodava o
 * seed quando `nutrition_foods` estava vazia — um banco com os 582 alimentos
 * TACO antigos nunca recebia as 3 linhas novas (leite integral/desnatado,
 * whey) no boot normal, só via script manual.
 *
 * Correção: o seed passa a rodar SEMPRE no boot (idempotente, mesmo padrão
 * do seed de exercícios) — este teste reproduz o cenário exato (catálogo já
 * populado, sem as linhas USDA) e confirma que rodar a função de boot de
 * novo, sem reiniciar o processo nem "esvaziar" a tabela, basta para
 * recuperá-las.
 */
import { acquireSuiteLock, connect, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(60_000);

type BootSeed = typeof import('../db/seedNutritionFoodsIfEmpty');

describeWithDb('seedNutritionFoodsIfEmpty — regressão "catálogo já seedado nunca recebe fonte nova"', () => {
  let client: Client;
  let boot: BootSeed;

  beforeAll(async () => {
    client = await connect();
    await acquireSuiteLock(client);
    boot = await import('../db/seedNutritionFoodsIfEmpty');
  });

  afterAll(async () => {
    await finishSuite(client, async () => {});
  });

  it('remove as linhas USDA (simula um banco seedado ANTES do import) e confirma que rodar o boot de novo as recupera — sem esvaziar a tabela', async () => {
    // Catálogo já tem centenas de linhas TACO — nunca fica vazio; é
    // exatamente esse estado que fazia o gate antigo pular o seed.
    const before = await client.query(`SELECT COUNT(*) FROM nutrition_foods WHERE source = 'taco'`);
    expect(Number(before.rows[0].count)).toBeGreaterThan(0);

    await client.query(`DELETE FROM nutrition_food_measures WHERE food_id IN (SELECT id FROM nutrition_foods WHERE source = 'usda_fdc')`);
    await client.query(`DELETE FROM nutrition_foods WHERE source = 'usda_fdc'`);

    const missing = await client.query(`SELECT COUNT(*) FROM nutrition_foods WHERE source = 'usda_fdc'`);
    expect(Number(missing.rows[0].count)).toBe(0);

    // O bug: no comportamento antigo, chamar a função de boot aqui não
    // faria nada (tabela não está vazia — `SELECT COUNT(*) > 0`). A
    // correção roda o seed de qualquer forma.
    await boot.seedNutritionFoodsIfEmpty();

    const after = await client.query(
      `SELECT source_id, name FROM nutrition_foods WHERE source = 'usda_fdc' ORDER BY source_id`,
    );
    expect(after.rows.map((r) => r.source_id).sort()).toEqual(['171265', '173177', '173432']);

    const measures = await client.query(
      `SELECT m.name, m.grams FROM nutrition_food_measures m
         JOIN nutrition_foods f ON f.id = m.food_id
        WHERE f.source = 'usda_fdc'
        ORDER BY f.source_id, m.name`,
    );
    expect(measures.rows.length).toBe(3); // 2x "ml" (leite) + 1x "scoop" (whey)

    // Rodar de novo (idempotente) não duplica nada.
    await boot.seedNutritionFoodsIfEmpty();
    const afterTwice = await client.query(`SELECT COUNT(*) FROM nutrition_foods WHERE source = 'usda_fdc'`);
    expect(Number(afterTwice.rows[0].count)).toBe(3);
  });

  it('o catálogo TACO original nunca é duplicado por rodar o seed repetidamente', async () => {
    const before = await client.query(`SELECT COUNT(*) FROM nutrition_foods WHERE source = 'taco'`);
    await boot.seedNutritionFoodsIfEmpty();
    const after = await client.query(`SELECT COUNT(*) FROM nutrition_foods WHERE source = 'taco'`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
