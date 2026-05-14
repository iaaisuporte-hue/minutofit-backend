/**
 * Smoke tests — /api/personal/dashboard
 *
 * Valida os guards da rota sem atingir DB:
 *   1. Sem token → 401
 *   2. Token de user (role≠personal) → 403
 *   3. Token de personal → chega ao service (DB mockado retorna dados)
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../services/personalDashboardService', () => ({
  getPersonalDashboard: jest.fn().mockResolvedValue({
    students: [],
    recentWorkoutPlans: [],
    pendingReviews: [],
    todayCheckins: 0,
  }),
}));
jest.mock('../middleware/tenantContext', () => ({
  requireAcademyContext: (_req: any, _res: any, next: any) => next(),
  tenantContextMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../middleware/productGate', () => ({
  requireProduct: () => (_req: any, _res: any, next: any) => next(),
}));

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { getPersonalDashboard } from '../services/personalDashboardService';
import { JWTPayload } from '../utils/jwt';

const JWT_SECRET = process.env.JWT_SECRET!;

function makeToken(payload: JWTPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' } as any);
}

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get(
    '/api/personal/dashboard',
    authMiddleware,
    roleCheckMiddleware('personal'),
    async (req, res) => {
      try {
        const data = await getPersonalDashboard(req.user!.id, req.user?.activeAcademyId ?? null);
        res.json({ success: true, data });
      } catch {
        res.status(500).json({ success: false, error: 'Internal error' });
      }
    }
  );

  return app;
}

const personalPayload: JWTPayload = {
  id: 10,
  email: 'personal@test.com',
  role: 'personal',
  profileCompleted: true,
};

describe('GET /api/personal/dashboard', () => {
  const app = buildApp();

  beforeEach(() => jest.clearAllMocks());

  it('401 sem Authorization header', async () => {
    const res = await request(app).get('/api/personal/dashboard');
    expect(res.status).toBe(401);
  });

  it('403 quando role=user tenta acessar dashboard do personal', async () => {
    const token = makeToken({ ...personalPayload, role: 'user' });
    const res = await request(app)
      .get('/api/personal/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('200 quando personal válido acessa o dashboard', async () => {
    const token = makeToken(personalPayload);
    const res = await request(app)
      .get('/api/personal/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(getPersonalDashboard).toHaveBeenCalledWith(10, null);
  });

  it('personal com academia chama service com academyId correto', async () => {
    const token = makeToken({ ...personalPayload, activeAcademyId: 7 });
    const res = await request(app)
      .get('/api/personal/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(getPersonalDashboard).toHaveBeenCalledWith(10, 7);
  });

  it('personal de academia A não recebe dados de academia B', async () => {
    const tokenAcA = makeToken({ ...personalPayload, activeAcademyId: 1 });
    const tokenAcB = makeToken({ ...personalPayload, activeAcademyId: 2 });

    await request(app)
      .get('/api/personal/dashboard')
      .set('Authorization', `Bearer ${tokenAcA}`);
    await request(app)
      .get('/api/personal/dashboard')
      .set('Authorization', `Bearer ${tokenAcB}`);

    const calls = (getPersonalDashboard as jest.Mock).mock.calls;
    expect(calls[0][1]).toBe(1);
    expect(calls[1][1]).toBe(2);
    expect(calls[0][1]).not.toBe(calls[1][1]);
  });
});
