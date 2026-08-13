/**
 * Rotas do PERSONAL — quem pode operar desafios (Spec 034, Onda C2).
 *
 * Estes testes existem por uma razão específica: `createChallenge` não valida
 * papel por conta própria, e `getPersonalPlan` devolve o plano Free para
 * qualquer id — então `roleCheckMiddleware('personal')` é a defesa INTEIRA das
 * cinco rotas. Uma defesa que nenhum teste exercita é uma defesa que some no
 * primeiro refactor sem ninguém perceber.
 */
import express from 'express';
import request from 'supertest';

const service = {
  createChallenge: jest.fn(),
  listChallengesForPersonalUser: jest.fn(),
  inviteToChallenge: jest.fn(),
  listParticipantsForPersonal: jest.fn(),
  cancelChallengeAsPersonal: jest.fn(),
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
  createChallenge: (...a: unknown[]) => service.createChallenge(...a),
  listChallengesForPersonalUser: (...a: unknown[]) => service.listChallengesForPersonalUser(...a),
  inviteToChallenge: (...a: unknown[]) => service.inviteToChallenge(...a),
  listParticipantsForPersonal: (...a: unknown[]) => service.listParticipantsForPersonal(...a),
  cancelChallengeAsPersonal: (...a: unknown[]) => service.cancelChallengeAsPersonal(...a),
}));

/** O papel do requisitante é trocável por teste. */
let papelAtual: 'personal' | 'user' | 'admin' = 'personal';
const EU = 55;

// `requireActual` preserva os demais middlewares que o router usa: um mock
// parcial deixaria `Route.post()` recebendo undefined e a suíte nem carrega.
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 55, role: papelAtual };
    next();
  },
  roleCheckMiddleware:
    (...papeis: string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as unknown as { user: { role: string } }).user;
      if (!papeis.includes(user.role)) {
        return res.status(403).json({ success: false, error: 'Acesso negado' });
      }
      return next();
    },
}));
jest.mock('../middleware/productGate', () => ({
  requireProduct: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

import personalRoutes from '../routes/personal';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/personal', personalRoutes);
  return a;
}

const ROTAS = [
  ['post', '/api/personal/challenges'],
  ['get', '/api/personal/challenges'],
  ['post', '/api/personal/challenges/10/invite'],
  ['get', '/api/personal/challenges/10/participants'],
  ['post', '/api/personal/challenges/10/cancel'],
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  papelAtual = 'personal';
});

describe('ATAQUE · aluno tentando operar desafios do personal', () => {
  it('as cinco rotas recusam quem não é personal', async () => {
    papelAtual = 'user';
    for (const [metodo, url] of ROTAS) {
      const agente = request(app()) as never as Record<string, (u: string) => request.Test>;
      const res = await agente[metodo](url).send({ title: 'X', kind: 'consistency', rule: { requiredWeeks: 4 } });
      expect(res.status).toBe(403);
    }
    // E o serviço nem chega a ser chamado: o corte é antes.
    expect(service.createChallenge).not.toHaveBeenCalled();
    expect(service.listParticipantsForPersonal).not.toHaveBeenCalled();
  });

  it('admin também não passa — a rota é do personal, não de quem tem mais poder', async () => {
    papelAtual = 'admin';
    const res = await request(app()).get('/api/personal/challenges');
    expect(res.status).toBe(403);
  });
});

describe('Rotas do personal · o dono vem do token', () => {
  it('criar usa o id autenticado, jamais um do corpo', async () => {
    service.createChallenge.mockResolvedValue({ id: '1' });
    await request(app())
      .post('/api/personal/challenges')
      .send({ title: 'X', kind: 'consistency', rule: { requiredWeeks: 4 }, personalId: 999 });

    expect(service.createChallenge).toHaveBeenCalledWith(EU, expect.any(Object));
    // O `personalId` do corpo chega ao serviço junto do resto, mas o serviço
    // usa o primeiro argumento — o do token. Este teste trava o argumento.
    expect(service.createChallenge.mock.calls[0][0]).toBe(EU);
  });

  it('convidar e cancelar também', async () => {
    service.inviteToChallenge.mockResolvedValue({ invited: 1, rejected: 0 });
    service.cancelChallengeAsPersonal.mockResolvedValue({ status: 'cancelled' });

    await request(app())
      .post('/api/personal/challenges/10/invite')
      .send({ studentIds: [1, 2], personalId: 999 });
    await request(app()).post('/api/personal/challenges/10/cancel').send({ personalId: 999 });

    expect(service.inviteToChallenge).toHaveBeenCalledWith(EU, '10', [1, 2]);
    expect(service.cancelChallengeAsPersonal).toHaveBeenCalledWith(EU, '10');
  });

  it('id malformado é recusado antes de tocar o serviço', async () => {
    for (const id of ['abc', '0', '-5', '1;DROP TABLE challenges']) {
      const res = await request(app()).get(
        `/api/personal/challenges/${encodeURIComponent(id)}/participants`,
      );
      expect(res.status).toBe(404);
    }
    expect(service.listParticipantsForPersonal).not.toHaveBeenCalled();
  });

  it('id de desafio ACIMA da faixa do int4 continua válido — a tabela é bigint', async () => {
    // O `registerNumericParams` deste router limita `:id` ao int4. Se a rota
    // usasse esse nome, todo desafio passaria a 400 quando a sequência
    // crescesse — falha silenciosa e distante no tempo.
    service.listParticipantsForPersonal.mockResolvedValue({ challenge: {}, participants: [] });
    const grande = '9007199254740991';
    const res = await request(app()).get(`/api/personal/challenges/${grande}/participants`);

    expect(res.status).toBe(200);
    expect(service.listParticipantsForPersonal).toHaveBeenCalledWith(EU, grande);
  });

  it('erro de domínio vira o status certo, com código estável', async () => {
    service.inviteToChallenge.mockRejectedValue(
      new ChallengeErrorMock('CHALLENGE_CLOSED', 409, 'Desafio não está aberto a convites'),
    );
    const res = await request(app())
      .post('/api/personal/challenges/10/invite')
      .send({ studentIds: [1] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHALLENGE_CLOSED');
  });

  it('erro interno não vaza detalhe do banco', async () => {
    service.listChallengesForPersonalUser.mockRejectedValue(
      new Error('relation "challenges" does not exist'),
    );
    const res = await request(app()).get('/api/personal/challenges');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|challenges" does not/);
  });
});
