/**
 * Smoke tests — authMiddleware + roleCheckMiddleware
 *
 * Valida os contratos básicos de autenticação sem atingir o DB:
 *   1. Ausência de token → 401
 *   2. Token inválido  → 401
 *   3. Token expirado  → 401
 *   4. Token válido de user → passa; role=personal bloqueado por roleCheck
 *   5. Token válido de personal → passa roleCheck('personal')
 *   6. Multi-tenant: token com activeAcademyId≠null exposto via req.user
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// Pool nunca é usado nos testes de middleware, mas o import é top-level
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { JWTPayload } from '../utils/jwt';

const JWT_SECRET = process.env.JWT_SECRET!;

function makeToken(payload: JWTPayload, expiresIn = '1h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as any);
}

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/protected', authMiddleware, (req, res) => {
    res.json({ success: true, user: req.user });
  });

  app.get('/personal-only', authMiddleware, roleCheckMiddleware('personal'), (req, res) => {
    res.json({ success: true });
  });

  return app;
}

const basePayload: JWTPayload = {
  id: 1,
  email: 'user@test.com',
  role: 'user',
  profileCompleted: true,
};

describe('authMiddleware', () => {
  const app = buildApp();

  it('401 sem header Authorization', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('401 com token mal-formado', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('401 com token expirado', async () => {
    const token = makeToken(basePayload, '-1s');
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('200 com token válido; req.user contém o payload', async () => {
    const token = makeToken(basePayload);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@test.com');
    expect(res.body.user.role).toBe('user');
  });

  it('expõe activeAcademyId no req.user quando presente no token', async () => {
    const token = makeToken({ ...basePayload, activeAcademyId: 42 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.activeAcademyId).toBe(42);
  });
});

describe('roleCheckMiddleware', () => {
  const app = buildApp();

  it('403 quando role=user tenta acessar rota personal-only', async () => {
    const token = makeToken(basePayload);
    const res = await request(app).get('/personal-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('200 quando role=personal acessa rota personal-only', async () => {
    const token = makeToken({ ...basePayload, role: 'personal' });
    const res = await request(app).get('/personal-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('isolamento multi-tenant — token com activeAcademyId diferente', () => {
  it('dois tokens com academyId distintos não compartilham contexto', async () => {
    const app = buildApp();

    const tokenA = makeToken({ ...basePayload, activeAcademyId: 1 });
    const tokenB = makeToken({ ...basePayload, activeAcademyId: 2 });

    const [resA, resB] = await Promise.all([
      request(app).get('/protected').set('Authorization', `Bearer ${tokenA}`),
      request(app).get('/protected').set('Authorization', `Bearer ${tokenB}`),
    ]);

    expect(resA.body.user.activeAcademyId).toBe(1);
    expect(resB.body.user.activeAcademyId).toBe(2);
    expect(resA.body.user.activeAcademyId).not.toBe(resB.body.user.activeAcademyId);
  });
});
