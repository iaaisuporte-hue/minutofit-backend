/**
 * Alimentação Livre — Etapa 1 / Privacidade: o texto livre que o aluno digitou (`rawText`) NÃO vai para o nutricionista,
 * só o resultado estruturado. O aluno continua vendo o próprio `rawText`; autorização e consentimento seguem como estavam.
 *
 * Nunca roda contra o `.env` (aponta para produção): só com TEST_DATABASE_URL.
 */
import { connect, acquireSuiteLock, finishSuite, createUser, describeWithDb, hasTestDb } from './helpers/integrationDb';
import type { Client } from 'pg';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'nutripriv';

describeWithDb('payload do nutricionista não expõe rawText', () => {
  let c: Client;
  let nutriId: number;
  let otherNutriId: number;
  let patientId: number;
  let app: import('express').Express;
  let get: (path: string, uid: number, role?: 'nutri' | 'user') => import('supertest').Test;
  let logId: number;
  const today = () => new Date().toISOString().slice(0, 10);

  async function consent(scope: string, status: 'granted' | 'revoked') {
    await c.query(
      `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
       VALUES ($1, $2, 'nutri', $3, $4)
       ON CONFLICT (user_id, professional_id, professional_role, scope) DO UPDATE SET status = $4`,
      [patientId, nutriId, scope, status]
    );
  }

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await c.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    nutriId = await createUser(c, TAG, 'nutri');
    otherNutriId = await createUser(c, TAG, 'outro-nutri');
    patientId = await createUser(c, TAG, 'paciente');
    await c.query(`INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status) VALUES ($1, $2, 'active')`, [nutriId, patientId]);
    await consent('profile', 'granted');
    await consent('nutrition', 'granted');

    // dia de HOJE segundo o servidor (America/Sao_Paulo) — o mesmo critério do `dayKey()` da rota
    const { dayKey } = await import('../utils/appDay');
    const dk = dayKey();
    const ins = await c.query(
      `INSERT INTO user_nutrition_intake_logs
         (user_id, date_key, label, raw_text, energy_kcal, protein_g, carbohydrate_g, fat_g, items, confidence_score, source, is_favorite)
       VALUES ($1, $2, 'Lanche da tarde', 'comi 4 biscoitos escondido do marido', 200, 3, 30, 8,
               '[{"name":"Biscoito, doce, recheado com chocolate","grams":80,"energyKcal":200,"proteinG":3,"carbohydrateG":30,"fatG":8,"fiberG":null,"resolver":"catalog","confidence":"high","confirmed":true}]'::jsonb,
               1, 'parse', false) RETURNING id`,
      [patientId, dk]
    );
    logId = ins.rows[0].id;

    const express = (await import('express')).default;
    const nutriRoutes = (await import('../routes/nutri')).default;
    const userRoutes = (await import('../routes/user')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    const request = (await import('supertest')).default;
    app = express();
    app.use(express.json());
    app.use('/api/nutri', nutriRoutes);
    app.use('/api/user', userRoutes);
    get = (path, uid, role = 'nutri') => {
      const token = generateAccessToken({ id: uid, email: `${uid}@test.local`, role, profileCompleted: true, products: role === 'nutri' ? ['nutri'] : ['app'] } as never);
      return request(app).get(path).set('Authorization', `Bearer ${token}`);
    };
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await c.query(`DELETE FROM user_nutrition_intake_logs WHERE user_id = $1`, [patientId]);
      await c.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}-%@test.local`]);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  it('nutri autorizado recebe o registro estruturado, SEM rawText', async () => {
    const res = await get(`/api/nutri/patients/${patientId}/intake-logs`, nutriId);
    expect(res.status).toBe(200);
    const [log] = res.body.data.logs;
    expect(log).toBeDefined();
    expect(log).not.toHaveProperty('rawText');
    expect(JSON.stringify(res.body)).not.toMatch(/escondido do marido|raw_text/);
    // o que o nutri precisa para ler o dia continua lá
    expect(log).toMatchObject({ id: logId, label: 'Lanche da tarde', mealId: null, energyKcal: 200 });
    expect(log.loggedAt).toBeTruthy();
    expect(log.items[0]).toMatchObject({ name: 'Biscoito, doce, recheado com chocolate', grams: 80, energyKcal: 200 });
  });

  it('o próprio aluno continua vendo o seu rawText', async () => {
    const res = await get('/api/user/nutrition-intake', patientId, 'user');
    expect(res.status).toBe(200);
    expect(res.body.data.logs[0].rawText).toBe('comi 4 biscoitos escondido do marido');
  });

  it('a coluna segue persistida (nada foi apagado)', async () => {
    const { rows } = await c.query(`SELECT raw_text FROM user_nutrition_intake_logs WHERE id = $1`, [logId]);
    expect(rows[0].raw_text).toBe('comi 4 biscoitos escondido do marido');
  });

  it('nutri SEM vínculo com o paciente → 403', async () => {
    const res = await get(`/api/nutri/patients/${patientId}/intake-logs`, otherNutriId);
    expect(res.status).toBe(403);
  });

  it('consentimento `nutrition` revogado → 403 (nenhuma permissão ampliada)', async () => {
    await consent('nutrition', 'revoked');
    try {
      const res = await get(`/api/nutri/patients/${patientId}/intake-logs`, nutriId);
      expect(res.status).toBe(403);
      const summary = await get(`/api/nutri/patients/${patientId}/intake-summary`, nutriId);
      expect(summary.status).toBe(403);
    } finally {
      await consent('nutrition', 'granted');
    }
  });
});
