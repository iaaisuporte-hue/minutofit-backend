/**
 * Suite de isolamento multi-tenant.
 *
 * Invariantes críticos que o backend NUNCA pode violar:
 *
 *   1. tenantContextMiddleware: token sem activeAcademyId → 403
 *   2. tenantContextMiddleware: vínculo revogado no DB → 403
 *   3. tenantContextMiddleware: academia suspensa → 403
 *   4. tenantContextMiddleware: host-vs-token mismatch (academyA token em academyB) → 403
 *   5. tenantContextMiddleware: token válido + academia ativa → req.tenant populado corretamente
 *   6. requireTenantPermission: sem permissão → 403
 *   7. requireTenantPermission: com permissão → passa
 *   8. Cross-tenant read: membro da academia A não lê students da academia B
 *      (garante que req.tenant.academyId isolado do activeAcademyId de outra academia)
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('../services/academyStudentService', () => ({
  listStudents: jest.fn().mockResolvedValue({ students: [], total: 0 }),
  searchReceptionStudents: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/personalBillingService', () => ({
  handleMpPreapprovalWebhook: jest.fn(),
}));

import pool from '../config/database';
import { tenantContextMiddleware, requireTenantPermission } from '../middleware/tenantContext';
import { JWTPayload } from '../utils/jwt';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;

const JWT_SECRET = process.env.JWT_SECRET!;

function makeToken(payload: Partial<JWTPayload> & { id: number; email: string; role: string; profileCompleted: boolean }) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' } as any);
}

/** Monta uma mini-app que aplica tenantContextMiddleware + um handler de teste */
function buildTenantApp(extraSetup?: (req: Request, _res: Response, next: NextFunction) => void) {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth) return next();
    try {
      req.user = jwt.verify(auth, JWT_SECRET) as JWTPayload;
    } catch {
      /* deixa req.user undefined */
    }
    next();
  });

  if (extraSetup) app.use(extraSetup);

  app.get(
    '/academy/students',
    tenantContextMiddleware,
    requireTenantPermission('academy.students.read'),
    (req: Request, res: Response) => {
      res.json({ success: true, academyId: req.tenant!.academyId });
    }
  );

  return app;
}

/** Mock de DB que simula acesso válido a uma academia específica */
function mockValidAcademyAccess(academyId: number) {
  mockedQuery.mockResolvedValueOnce({
    rows: [
      {
        academy_unit_id: null,
        role_slug: 'owner',
        permissions: JSON.stringify(['academy.students.read', 'academy.students.write']),
        academy_status: 'active',
      },
    ],
    rowCount: 1,
  });
}

beforeEach(() => {
  mockedQuery.mockReset();
});

// ============================================================================
// 1. Token sem activeAcademyId → 403
// ============================================================================

describe('tenantContextMiddleware — token sem academia', () => {
  it('403 quando activeAcademyId está ausente do token', async () => {
    const app = buildTenantApp();
    const token = makeToken({ id: 1, email: 'u@x.com', role: 'user', profileCompleted: true });

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/academy context/i);
  });
});

// ============================================================================
// 2. Vínculo revogado no DB → 403
// ============================================================================

describe('tenantContextMiddleware — vínculo revogado', () => {
  it('403 quando academy_users não retorna linha ativa para o usuário', async () => {
    const app = buildTenantApp();
    const token = makeToken({ id: 99, email: 'ex@x.com', role: 'user', profileCompleted: true, activeAcademyId: 5 });

    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/revoked/i);
  });
});

// ============================================================================
// 3. Academia suspensa → 403
// ============================================================================

describe('tenantContextMiddleware — academia suspensa', () => {
  it('403 quando academy.status !== active', async () => {
    const app = buildTenantApp();
    const token = makeToken({ id: 7, email: 'staff@x.com', role: 'user', profileCompleted: true, activeAcademyId: 10 });

    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          academy_unit_id: null,
          role_slug: 'staff',
          permissions: JSON.stringify(['academy.students.read']),
          academy_status: 'suspended',
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/i);
  });
});

// ============================================================================
// 4. Host-vs-token mismatch — token da academy A numa request de academy B
// ============================================================================

describe('tenantContextMiddleware — host-vs-token mismatch', () => {
  it('403 quando tenantHost.academyId difere do activeAcademyId do token', async () => {
    const app = buildTenantApp((req: Request, _res: Response, next: NextFunction) => {
      // Simula que o host resolve para a academia B (id=2)
      (req as any).tenantHost = { academyId: 2, slug: 'academia-b' };
      next();
    });

    // Token emitido para academia A (id=1)
    const token = makeToken({ id: 5, email: 'dono@a.com', role: 'user', profileCompleted: true, activeAcademyId: 1 });

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('200 quando tenantHost.academyId coincide com o activeAcademyId do token', async () => {
    const app = buildTenantApp((req: Request, _res: Response, next: NextFunction) => {
      (req as any).tenantHost = { academyId: 3, slug: 'academia-c' };
      next();
    });

    const token = makeToken({ id: 6, email: 'dono@c.com', role: 'user', profileCompleted: true, activeAcademyId: 3 });

    mockValidAcademyAccess(3);

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.academyId).toBe(3);
  });
});

// ============================================================================
// 5. Token válido + academia ativa → req.tenant populado
// ============================================================================

describe('tenantContextMiddleware — caminho feliz', () => {
  it('popula req.tenant com academyId e permissions corretos', async () => {
    const app = buildTenantApp();
    const token = makeToken({ id: 10, email: 'dono@x.com', role: 'user', profileCompleted: true, activeAcademyId: 7 });

    mockValidAcademyAccess(7);

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.academyId).toBe(7);
  });
});

// ============================================================================
// 6 & 7. requireTenantPermission
// ============================================================================

describe('requireTenantPermission', () => {
  it('403 sem permissão necessária', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).tenant = { academyId: 1, roleSlug: 'staff', permissions: ['academy.branding'] };
      next();
    });
    app.get('/endpoint', requireTenantPermission('academy.students.write'), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/endpoint');
    expect(res.status).toBe(403);
  });

  it('200 com permissão presente', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).tenant = { academyId: 1, roleSlug: 'owner', permissions: ['academy.students.write'] };
      next();
    });
    app.get('/endpoint', requireTenantPermission('academy.students.write'), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/endpoint');
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 8. Cross-tenant read — membro da academia A não obtém dados da academia B
// ============================================================================

describe('cross-tenant isolation — leitura de students', () => {
  it('garante que academyId do req.tenant é o do token, não de outra academia', async () => {
    const app = buildTenantApp();

    // Usuário pertence legítimamente à academia 1
    const tokenAcademia1 = makeToken({
      id: 20, email: 'staff@a1.com', role: 'user', profileCompleted: true, activeAcademyId: 1,
    });

    mockValidAcademyAccess(1);

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${tokenAcademia1}`);

    expect(res.status).toBe(200);
    // O academyId que chegou ao handler é 1 — não pode ser 2 (outra academia)
    expect(res.body.academyId).toBe(1);
    expect(res.body.academyId).not.toBe(2);
  });

  it('token da academia 2 não pode usar academy_id=1 via cabeçalho injetado', async () => {
    const app = buildTenantApp();

    // Atacante tem token legítimo da academia 2,
    // mas tenta adicionar um header X-Academy-Id para forçar academy 1.
    // O sistema deve ignorar qualquer hint externo — usa apenas o JWT.
    const tokenAcademia2 = makeToken({
      id: 21, email: 'atacante@a2.com', role: 'user', profileCompleted: true, activeAcademyId: 2,
    });

    // DB confirma acesso à academia 2 (não à 1)
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          academy_unit_id: null,
          role_slug: 'staff',
          permissions: JSON.stringify(['academy.students.read']),
          academy_status: 'active',
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/academy/students')
      .set('Authorization', `Bearer ${tokenAcademia2}`)
      .set('X-Academy-Id', '1'); // tentativa de override

    // Deve retornar 200 com academyId=2 (o do token), nunca 1
    expect(res.status).toBe(200);
    expect(res.body.academyId).toBe(2);
    expect(res.body.academyId).not.toBe(1);

    // Confirma que a query ao DB usou academyId=2 (do token), não 1
    const dbCall = mockedQuery.mock.calls[0];
    expect(dbCall[1]).toEqual([21, 2]);
  });
});
