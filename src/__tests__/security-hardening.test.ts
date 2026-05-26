/**
 * Suite mínima de segurança/disciplina pós-diagnóstico 2026-05-25.
 *
 * Cobre três invariantes que o backend NUNCA pode violar:
 *
 *   1. Webhook Mercado Pago: rejeita request sem assinatura HMAC válida em produção.
 *   2. Consent revogado: requireActiveConsent retorna 403 quando aluno não concedeu.
 *   3. Signup público: findOrCreateUserForPublicSignup força matchBy=['email'] —
 *      NUNCA mescla identidade por CPF/telefone de terceiros.
 */
import crypto from 'crypto';
import request from 'supertest';
import express from 'express';

// Mock pool antes de qualquer import que precise de DB
jest.mock('../config/database', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

// Evita acionar grantMembership / handlePaymentNotification reais
jest.mock('../services/personalBillingService', () => ({
  handleMpPreapprovalWebhook: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/subscriptionService', () => ({
  __esModule: true,
}));
jest.mock('../services/membershipService', () => ({
  grantMembership: jest.fn().mockResolvedValue({ id: 1 }),
  cancelMembership: jest.fn().mockResolvedValue(undefined),
}));

import pool from '../config/database';
import webhookRoutes from '../routes/webhooks';
import { requireActiveConsent } from '../middleware/requireActiveConsent';
import { findOrCreateUserForPublicSignup } from '../services/userIdentityService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => {
  mockedQuery.mockReset();
});

// ============================================================================
// 1. Webhook Mercado Pago — HMAC obrigatório em produção
// ============================================================================

describe('webhook MP — assinatura HMAC', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalSecret === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    else process.env.MERCADOPAGO_WEBHOOK_SECRET = originalSecret;
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhookRoutes);
    return app;
  }

  it('rejeita request sem header x-signature em produção (401)', async () => {
    const res = await request(buildApp())
      .post('/api/webhooks/mercadopago')
      .send({ type: 'payment', data: { id: '123' } });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('rejeita request com HMAC inválido (401)', async () => {
    const res = await request(buildApp())
      .post('/api/webhooks/mercadopago?data.id=999')
      .set('x-signature', 'ts=1234567890,v1=' + 'a'.repeat(64))
      .set('x-request-id', 'fake-uuid')
      .send({ type: 'payment', data: { id: '999' } });

    expect(res.status).toBe(401);
  });

  it('aceita request com HMAC válido (não 401)', async () => {
    const ts = '1700000000';
    const dataId = '777';
    const reqId = 'corr-uuid';
    const template = `id:${dataId};request-id:${reqId};ts:${ts}`;
    const v1 = crypto.createHmac('sha256', 'test-secret').update(template).digest('hex');

    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(buildApp())
      .post(`/api/webhooks/mercadopago?data.id=${dataId}`)
      .set('x-signature', `ts=${ts},v1=${v1}`)
      .set('x-request-id', reqId)
      .send({ type: 'payment', data: { id: dataId } });

    expect(res.status).not.toBe(401);
  });
});

// ============================================================================
// 2. requireActiveConsent — bloqueia quando aluno revogou
// ============================================================================

describe('requireActiveConsent middleware', () => {
  function makeApp(scope: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 99, role: 'personal', email: 'p@x', profileCompleted: true };
      next();
    });
    app.get('/students/:studentId/protected', requireActiveConsent(scope as any), (_req, res) => {
      res.json({ success: true });
    });
    return app;
  }

  it('403 quando aluno não concedeu o escopo solicitado', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp('workouts')).get('/students/42/protected');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('consent_required');
    expect(res.body.scope).toBe('workouts');
  });

  it('200 quando aluno concedeu o escopo (consent ativo)', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const res = await request(makeApp('workouts')).get('/students/42/protected');

    expect(res.status).toBe(200);
  });

  it('400 quando :studentId não é numérico', async () => {
    const res = await request(makeApp('profile')).get('/students/abc/protected');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_student_id');
  });
});

// ============================================================================
// 3. Signup público — findOrCreateUserForPublicSignup força matchBy=['email']
// ============================================================================

describe('findOrCreateUserForPublicSignup', () => {
  it('NÃO mescla quando email é novo mas CPF de terceiro existe', async () => {
    // Cenário malicioso: atacante registra-se com CPF de outra pessoa.
    // O matchBy=['email'] força olhar APENAS email — cria novo usuário em vez
    // de mesclar com a conta da vítima.

    // 1ª query (lookup por email): nenhum resultado
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 2ª query (INSERT do novo usuário)
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1001,
          email: 'novo@x.com',
          role: 'user',
          name: 'Atacante',
          cpf: '12345678901',
          phone: null,
          profile_completed: false,
          has_password: true,
        },
      ],
      rowCount: 1,
    });

    const result = await findOrCreateUserForPublicSignup({
      email: 'novo@x.com',
      name: 'Atacante',
      cpf: '529.982.247-25',
      password: 'Senha-forte-1234!',
    });

    expect(result.isNew).toBe(true);
    expect(result.matchedBy).toBe('none');
    expect(result.user.email).toBe('novo@x.com');

    // Crítico: a primeira query deve ter sido por EMAIL (não por CPF).
    const firstCall = mockedQuery.mock.calls[0];
    expect(firstCall[0]).toMatch(/WHERE email = \$1/);
    expect(firstCall[1]).toEqual(['novo@x.com']);

    // Não pode ter rodado lookup por CPF
    const cpfLookups = mockedQuery.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('WHERE cpf = $1')
    );
    expect(cpfLookups.length).toBe(0);
  });

  it('reutiliza conta existente quando email bate (caso normal)', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 50,
          email: 'existente@x.com',
          role: 'user',
          name: 'Dono Original',
          cpf: null,
          phone: null,
          profile_completed: true,
          has_password: true,
        },
      ],
      rowCount: 1,
    });

    const result = await findOrCreateUserForPublicSignup({
      email: 'existente@x.com',
      name: 'Dono Original',
      password: 'qualquer-senha',
    });

    expect(result.isNew).toBe(false);
    expect(result.matchedBy).toBe('email');
    expect(result.user.id).toBe(50);
  });
});
