/**
 * `GET /api/admin/billing/failures` com banco real (Onda F4).
 *
 * A rota respondia 500 desde que nasceu — lia `payments.provider_ref` e juntava
 * `personal_billing_events` por `pbe.personal_id`, colunas que não existem. O
 * cliente trata resposta não-ok como "sem dados", então o admin lia "nenhuma
 * falha de pagamento registrada" com pagamento reprovado no banco: um falso
 * negativo silencioso. Só o Postgres pega esse defeito; com pool mockado a
 * query nunca é compilada.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-f4-admin';

describeWithDb('Admin · falhas de pagamento', () => {
  let c: Client;
  let app: import('express').Express;
  let adminToken: string;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);

    const express = (await import('express')).default;
    const rotas = (await import('../routes/admin')).default;
    const { generateAccessToken } = await import('../utils/jwt');

    app = express();
    app.use(express.json());
    app.use('/api/admin', rotas);

    const adminId = await createUser(c, TAG, 'admin');
    await c.query(
      `UPDATE users SET role = 'admin', is_corefit_admin = TRUE, admin_sub_role = 'super_admin'
        WHERE id = $1`,
      [adminId],
    );
    adminToken = generateAccessToken({
      id: adminId,
      email: `${TAG}-admin@test.local`,
      role: 'admin',
      profileCompleted: true,
      products: [],
    });
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  it('lista o pagamento reprovado em vez de responder 500', async () => {
    const request = (await import('supertest')).default;
    const userId = await createUser(c, TAG, 'pagador');
    await c.query(
      `INSERT INTO payments (user_id, amount_brl, status, mercado_pago_payment_id)
       VALUES ($1, 49.90, 'failed', 'mp-f4-test')`,
      [userId],
    );

    const res = await request(app)
      .get('/api/admin/billing/failures')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const linha = res.body.data.paymentFailures.find((p: any) => p.user_id === userId);
    expect(linha).toMatchObject({ status: 'failed', mercado_pago_payment_id: 'mp-f4-test' });
    // O domínio congelado saiu do payload: não existe evento de billing MP.
    expect(res.body.data.billingFailures).toBeUndefined();
  });

  it('limite malformado não vira 500 nem LIMIT NaN', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .get("/api/admin/billing/failures?limit=' OR '1'='1")
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
