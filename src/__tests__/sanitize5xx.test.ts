/**
 * Guard de regressão (segurança) — respostas 500 não vazam internals.
 * ~140 handlers fazem res.status(500).json({error: error.message}); o
 * sanitize5xxResponses os normaliza num ponto só. Este teste trava isso.
 */

import request from 'supertest';
import express from 'express';
import { sanitize5xxResponses } from '../middleware/sanitize5xx';

function buildApp() {
  const app = express();
  app.use(sanitize5xxResponses);
  app.get('/boom', (_req, res) =>
    res.status(500).json({ success: false, error: 'duplicate key value violates constraint pg_xyz; SELECT * FROM users' })
  );
  app.get('/bad', (_req, res) => res.status(400).json({ success: false, error: 'validação: email obrigatório' }));
  app.get('/degraded', (_req, res) => res.status(503).json({ success: false, checks: { db: 'down' } }));
  return app;
}

describe('sanitize5xxResponses', () => {
  it('500 → mensagem genérica (não vaza SQL/constraint)', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|constraint|pg_xyz/i);
  });

  it('400 → mensagem do handler preservada (intencional ao usuário)', async () => {
    const res = await request(buildApp()).get('/bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email obrigat/i);
  });

  it('503 → corpo preservado (health/degradação)', async () => {
    const res = await request(buildApp()).get('/degraded');
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe('down');
  });
});
