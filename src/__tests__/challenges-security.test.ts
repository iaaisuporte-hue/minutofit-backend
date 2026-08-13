/**
 * QA de segurança dos desafios — tentativas reais pela camada HTTP
 * (Spec 034, Onda C2).
 *
 * Cada teste aqui é um ATAQUE, não uma verificação de contrato: personal lendo
 * desafio alheio, aluno trocando o id na URL, aluno mandando `userId` no corpo,
 * chamada depois de sair, replay de join e de conclusão. O serviço é mockado de
 * propósito — o alvo é a PORTA: quem ela deixa entrar e o que ela devolve.
 */
import express from 'express';
import request from 'supertest';

const service = {
  listMyChallenges: jest.fn(),
  getChallengeDetailForUser: jest.fn(),
  getActiveChallengeCard: jest.fn(),
  joinChallengeAsUser: jest.fn(),
  leaveChallengeAsUser: jest.fn(),
};

class ChallengeErrorMock extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

jest.mock('../modules/community/challenges.service', () => ({
  ChallengeError: ChallengeErrorMock,
  listMyChallenges: (...a: unknown[]) => service.listMyChallenges(...a),
  getChallengeDetailForUser: (...a: unknown[]) => service.getChallengeDetailForUser(...a),
  getActiveChallengeCard: (...a: unknown[]) => service.getActiveChallengeCard(...a),
  joinChallengeAsUser: (...a: unknown[]) => service.joinChallengeAsUser(...a),
  leaveChallengeAsUser: (...a: unknown[]) => service.leaveChallengeAsUser(...a),
}));
jest.mock('../modules/community/milestones.service', () => ({
  listMilestonesForUser: jest.fn(),
  setMilestoneShared: jest.fn(),
}));

/** O usuário do token é SEMPRE 77. Qualquer outro id é tentativa de fraude. */
const EU = 77;

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 77, role: 'user' };
    next();
  },
}));
jest.mock('../middleware/productGate', () => ({
  requireProduct: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
jest.mock('../lib/rateLimiter', () => ({
  createRateLimiter: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) =>
    n(),
}));

import communityRoutes from '../modules/community/community.routes';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/community', communityRoutes);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ATAQUE · aluno trocando o challengeId na URL', () => {
  it('desafio de que ele não participa responde 404 — sem confirmar existência', async () => {
    service.getChallengeDetailForUser.mockRejectedValue(
      new ChallengeErrorMock('NOT_FOUND', 404, 'Desafio não encontrado'),
    );
    const res = await request(app()).get('/api/community/challenges/999999');

    expect(res.status).toBe(404);
    // A resposta não distingue "não existe" de "não é seu".
    expect(JSON.stringify(res.body)).not.toMatch(/exists|pertence|outro/i);
  });

  it('id malformado vira 404, nunca 500 nem erro de banco', async () => {
    for (const id of ['abc', '1;DROP TABLE challenges', '-1', '0', '1.5', '../../etc/passwd', '9'.repeat(30)]) {
      const res = await request(app()).get(`/api/community/challenges/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      expect(service.getChallengeDetailForUser).not.toHaveBeenCalled();
    }
  });
});

describe('ATAQUE · aluno alterando o userId', () => {
  it('o dono do detalhe vem do TOKEN, não da query', async () => {
    service.getChallengeDetailForUser.mockResolvedValue({ challenge: {}, bands: null });
    await request(app()).get('/api/community/challenges/10?userId=999&user_id=999');

    expect(service.getChallengeDetailForUser).toHaveBeenCalledWith(EU, '10');
  });

  it('o dono do join vem do TOKEN, não do corpo', async () => {
    service.joinChallengeAsUser.mockResolvedValue({ status: 'active' });
    await request(app())
      .post('/api/community/challenges/10/join')
      .send({ userId: 999, user_id: 999, status: 'completed', final_pct: 100 });

    // Nem o id de outra pessoa, nem o estado desejado: só a AÇÃO chega.
    expect(service.joinChallengeAsUser).toHaveBeenCalledWith(EU, '10');
    expect(service.joinChallengeAsUser).not.toHaveBeenCalledWith(999, expect.anything());
  });

  it('o dono do leave vem do TOKEN', async () => {
    service.leaveChallengeAsUser.mockResolvedValue({ status: 'left' });
    await request(app()).post('/api/community/challenges/10/leave').send({ userId: 999 });

    expect(service.leaveChallengeAsUser).toHaveBeenCalledWith(EU, '10');
  });

  it('a lista é sempre a do token', async () => {
    service.listMyChallenges.mockResolvedValue([]);
    await request(app()).get('/api/community/challenges?userId=999');
    expect(service.listMyChallenges).toHaveBeenCalledWith(EU);
  });
});

describe('ATAQUE · aluno tentando forçar estado pelo payload', () => {
  it('não existe rota que aceite `status` — só ações', async () => {
    const rotas = [
      ['patch', '/api/community/challenges/10'],
      ['put', '/api/community/challenges/10'],
      ['post', '/api/community/challenges/10/complete'],
      ['post', '/api/community/challenges/10/status'],
    ] as const;

    for (const [metodo, url] of rotas) {
      const agente = request(app()) as never as Record<string, (u: string) => request.Test>;
      const res = await agente[metodo](url).send({ status: 'completed', final_pct: 100 });
      // 404 = a rota não existe. Nada além de join/leave muda estado.
      expect(res.status).toBe(404);
    }
  });
});

describe('ATAQUE · replay', () => {
  it('join repetido devolve 409 estável, não duplica', async () => {
    service.joinChallengeAsUser.mockRejectedValue(
      new ChallengeErrorMock('ALREADY_JOINED', 409, 'Você já participa deste desafio'),
    );
    const res = await request(app()).post('/api/community/challenges/10/join');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_JOINED');
  });

  it('chamada depois de sair não encontra participação', async () => {
    service.leaveChallengeAsUser.mockRejectedValue(
      new ChallengeErrorMock('NOT_FOUND', 404, 'Participação não encontrada'),
    );
    const res = await request(app()).post('/api/community/challenges/10/leave');
    expect(res.status).toBe(404);
  });
});

describe('ATAQUE · leitura de dado alheio', () => {
  it('a resposta do detalhe não tem lugar onde caiba percentual de outro', async () => {
    // O contrato é fechado: `myProgress` (um), `bands` (contagens) e
    // `participantsCount` (um inteiro). Não existe array de pessoas.
    service.getChallengeDetailForUser.mockResolvedValue({
      challenge: { id: '10', title: 'X' },
      myStatus: 'active',
      myProgress: { pct: 50, band: 'in_progress' },
      participantsCount: 8,
      bands: [{ band: 'completed', label: 'Concluído', count: 3 }],
    });

    const res = await request(app()).get('/api/community/challenges/10');
    const corpo = JSON.stringify(res.body);

    expect(corpo).not.toMatch(/"participants"\s*:\s*\[/);
    expect(corpo).not.toMatch(/"userId"/);
    expect(corpo).not.toMatch(/"name"/);
    expect((corpo.match(/myProgress/g) ?? []).length).toBe(1);
  });

  it('erro interno não vaza detalhe do banco', async () => {
    service.getChallengeDetailForUser.mockRejectedValue(
      new Error('relation "challenge_participants" does not exist'),
    );
    const res = await request(app()).get('/api/community/challenges/10');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|challenge_participants/);
  });
});
