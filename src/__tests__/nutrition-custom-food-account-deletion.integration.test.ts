/**
 * SPEC 038 (P3A) — mesma lição do bug de 02/ago documentado em
 * `exercises`/`accountDeletionService.ts`: `nutrition_custom_foods.
 * owner_nutri_id` é ON DELETE SET NULL. Sozinho, excluir a conta do nutri
 * vazaria o alimento customizado como "sem dono" — que hoje é tratado como
 * inexistente por `requireOwnedCustomFood`, mas o estado em si (linha ativa,
 * sem dono, com nome/marca/notas privados) é exatamente o que motivou
 * arquivar ANTES do SET NULL disparar para `exercises`. Este teste prova
 * que o mesmo cuidado foi replicado.
 */
import type { Client } from 'pg';
import { acquireSuiteLock, connect, createUser, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

const TAG = 'itest-nutridel';

describeWithDb('SPEC 038 · exclusão de conta arquiva alimento customizado do nutri', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanUp();
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

  it('arquiva o alimento customizado ANTES do owner_nutri_id virar NULL', async () => {
    const { deleteUserAccount } = await import('../services/accountDeletionService');
    const { createCustomFood } = await import('../services/nutritionFoodService');

    const nutriId = await createUser(c, TAG, 'nutri-del');
    const food = await createCustomFood(nutriId, {
      name: `${TAG}-receita-privada`, energyKcal: 200, proteinG: 10, carbohydrateG: 20, fatG: 5,
    });

    await deleteUserAccount(nutriId, { requestedBy: 'self' });

    const row = await c.query(
      `SELECT status, owner_nutri_id FROM nutrition_custom_foods WHERE id = $1`,
      [food.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe('archived');
    expect(row.rows[0].owner_nutri_id).toBeNull();

    // A linha nunca deve existir como "sem dono E ativa" — exatamente o
    // estado que vazaria como global-visível se a ordem estivesse errada.
    const leaked = await c.query(
      `SELECT 1 FROM nutrition_custom_foods WHERE id = $1 AND owner_nutri_id IS NULL AND status = 'active'`,
      [food.id],
    );
    expect(leaked.rows).toHaveLength(0);
  });
});
