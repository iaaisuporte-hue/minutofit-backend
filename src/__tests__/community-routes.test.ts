/**
 * Camada HTTP de /api/community (Spec 034, Onda C1).
 *
 * O serviço já é testado com banco real; o que só a rota decide é: de onde vem
 * o dono (JWT, jamais o cliente), o que acontece com entrada malformada, e se a
 * resposta de "não é seu" é distinguível da de "não existe". Rodam sem banco —
 * o serviço é mockado de propósito, porque o alvo aqui é a porta.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../modules/community/milestones.service', () => ({
  listMilestonesForUser: jest.fn(),
  setMilestoneShared: jest.fn(),
}));

// O gate de produto e a autenticação têm testes próprios; aqui eles saem da
// frente para o alvo ser só o comportamento das duas rotas.
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 77, role: 'user' };
    next();
  },
}));
jest.mock('../middleware/productGate', () => ({
  requireProduct: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));
jest.mock('../lib/rateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const service = require('../modules/community/milestones.service');
import communityRoutes from '../modules/community/community.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/community', communityRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/community/milestones', () => {
  it('devolve os marcos do usuário do TOKEN', async () => {
    service.listMilestonesForUser.mockResolvedValue([{ code: 'first_workout' }]);
    const res = await request(buildApp()).get('/api/community/milestones');

    expect(res.status).toBe(200);
    expect(res.body.data.milestones).toHaveLength(1);
    expect(service.listMilestonesForUser).toHaveBeenCalledWith(77);
  });

  it('ignora qualquer tentativa de pedir os marcos de outra pessoa', async () => {
    // Não existe superfície de IDOR porque não há identificador a informar —
    // este teste trava isso: o dono é sempre o do token, aconteça o que
    // acontecer na query string.
    service.listMilestonesForUser.mockResolvedValue([]);
    await request(buildApp()).get('/api/community/milestones?userId=999&user_id=999');
    expect(service.listMilestonesForUser).toHaveBeenCalledWith(77);
    expect(service.listMilestonesForUser).not.toHaveBeenCalledWith(999);
  });

  it('falha do serviço vira 500 sem vazar detalhe interno', async () => {
    service.listMilestonesForUser.mockRejectedValue(new Error('coluna xyz não existe'));
    const res = await request(buildApp()).get('/api/community/milestones');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/coluna xyz/);
  });
});

describe('PATCH /api/community/milestones/:code', () => {
  it('salva a escolha do titular', async () => {
    service.setMilestoneShared.mockResolvedValue({ code: 'first_workout', shared: true });
    const res = await request(buildApp())
      .patch('/api/community/milestones/first_workout')
      .send({ shared: true });

    expect(res.status).toBe(200);
    expect(service.setMilestoneShared).toHaveBeenCalledWith(77, 'first_workout', true);
  });

  it('`shared` ausente ou não-booleano é 422, não 500', async () => {
    for (const body of [{}, { shared: 'sim' }, { shared: 1 }, { shared: null }]) {
      const res = await request(buildApp())
        .patch('/api/community/milestones/first_workout')
        .send(body);
      expect(res.status).toBe(422);
    }
    expect(service.setMilestoneShared).not.toHaveBeenCalled();
  });

  it('marco de outra pessoa e marco inexistente respondem IGUAL', async () => {
    // Distinguir os dois transformaria a rota num oráculo do catálogo interno
    // e confirmaria a existência de marco alheio.
    service.setMilestoneShared.mockResolvedValue(null);

    const alheio = await request(buildApp())
      .patch('/api/community/milestones/first_workout')
      .send({ shared: true });
    const inexistente = await request(buildApp())
      .patch('/api/community/milestones/marco_inventado')
      .send({ shared: true });

    expect(alheio.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(alheio.body).toEqual(inexistente.body);
  });

  it('o dono nunca vem do corpo da requisição', async () => {
    service.setMilestoneShared.mockResolvedValue({ code: 'first_workout', shared: true });
    await request(buildApp())
      .patch('/api/community/milestones/first_workout')
      .send({ shared: true, userId: 999, user_id: 999 });

    expect(service.setMilestoneShared).toHaveBeenCalledWith(77, 'first_workout', true);
  });
});
