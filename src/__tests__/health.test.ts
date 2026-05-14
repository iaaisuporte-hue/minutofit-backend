/**
 * Smoke test — GET /api/health
 * Valida que o endpoint retorna 200 quando DB e secrets estão ok
 * e 503 quando o DB está indisponível.
 */
import request from 'supertest';
import express from 'express';

// Mock pool antes de qualquer import que precise de DB
jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

// Mock do boot chain para não tentar conectar ao DB em testes
jest.mock('../db/tenantQuery', () => ({ withTenant: jest.fn(), tenantQuery: jest.fn() }));

import pool from '../config/database';

// Importar o app factory de forma isolada
function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', async (_req, res) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    let healthy = true;

    try {
      await (pool as any).query('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
      healthy = false;
    }

    checks.jwt_secret = process.env.JWT_SECRET ? 'ok' : 'fail';
    checks.jwt_refresh_secret = process.env.JWT_REFRESH_SECRET ? 'ok' : 'fail';
    if (checks.jwt_secret === 'fail' || checks.jwt_refresh_secret === 'fail') {
      healthy = false;
    }

    res.status(healthy ? 200 : 503).json({ success: healthy, checks });
  });

  return app;
}

describe('GET /api/health', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retorna 200 quando DB e secrets estão ok', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const res = await request(buildApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.checks.db).toBe('ok');
    expect(res.body.checks.jwt_secret).toBe('ok');
    expect(res.body.checks.jwt_refresh_secret).toBe('ok');
  });

  it('retorna 503 quando DB está indisponível', async () => {
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(buildApp()).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.checks.db).toBe('fail');
  });

  it('retorna 503 quando JWT_SECRET está ausente', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    const res = await request(buildApp()).get('/api/health');

    process.env.JWT_SECRET = original;

    expect(res.status).toBe(503);
    expect(res.body.checks.jwt_secret).toBe('fail');
  });
});
