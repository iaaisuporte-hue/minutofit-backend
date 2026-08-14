/**
 * Rotas institucionais — quem pode operar (Spec 034, Onda C3).
 *
 * O isolamento de tenant tem duas metades. A do BANCO (o `academy_id` na
 * cláusula) está coberta pela suíte de integração; a da PORTA está aqui: o
 * tenant vem de `req.tenant`, a permissão é verificada antes do handler, e
 * nada no corpo da requisição muda ownership.
 *
 * `requireTenantPermission` é a autorização real — papel sozinho não basta —, e
 * uma defesa que nenhum teste exercita é uma defesa que some no primeiro
 * refactor.
 */
import express from 'express';
import request from 'supertest';

const service = {
  createAcademyChallenge: jest.fn(),
  listChallengesForAcademyPanel: jest.fn(),
  getAcademyChallengePanel: jest.fn(),
  inviteToAcademyChallenge: jest.fn(),
  cancelAcademyChallengeAsTenant: jest.fn(),
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
  ...jest.requireActual('../modules/community/challenges.service'),
  ChallengeError: ChallengeErrorMock,
  createAcademyChallenge: (...a: unknown[]) => service.createAcademyChallenge(...a),
  listChallengesForAcademyPanel: (...a: unknown[]) => service.listChallengesForAcademyPanel(...a),
  getAcademyChallengePanel: (...a: unknown[]) => service.getAcademyChallengePanel(...a),
  inviteToAcademyChallenge: (...a: unknown[]) => service.inviteToAcademyChallenge(...a),
  cancelAcademyChallengeAsTenant: (...a: unknown[]) => service.cancelAcademyChallengeAsTenant(...a),
}));

/** Tenant e permissões trocáveis por teste. */
const ACADEMIA = 7;
/**
 * Escrita exige DUAS permissões: `academy.dashboard` (ler o painel) e
 * `academy.students.write` (operar sobre alunos). Nenhuma sozinha basta —
 * `academy_finance` tem só a primeira, `academy_reception` só a segunda.
 */
let permissoes: string[] = ['academy.dashboard', 'academy.students.write'];
let tenantResolvido = true;

jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 42, role: 'user', activeAcademyId: 7 };
    next();
  },
}));
jest.mock('../middleware/productGate', () => ({
  requireProduct: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
jest.mock('../middleware/tenantContext', () => ({
  tenantContextMiddleware: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!tenantResolvido) {
      return res.status(403).json({ success: false, error: 'tenant_required' });
    }
    (req as unknown as { tenant: unknown }).tenant = {
      academyId: ACADEMIA,
      roleSlug: 'academy_owner',
      permissions: permissoes,
    };
    return next();
  },
  requireTenantPermission:
    (permission: string) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const t = (req as unknown as { tenant?: { permissions: string[] } }).tenant;
      if (!t || !t.permissions.includes(permission)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      return next();
    },
}));

import academyRoutes from '../routes/academy';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/academy', academyRoutes);
  return a;
}

const ROTAS = [
  ['post', '/api/academy/challenges', 'academy.students.write'],
  ['get', '/api/academy/challenges', 'academy.dashboard'],
  ['get', '/api/academy/challenges/10', 'academy.dashboard'],
  ['post', '/api/academy/challenges/10/invite', 'academy.students.write'],
  ['post', '/api/academy/challenges/10/cancel', 'academy.students.write'],
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  permissoes = ['academy.dashboard', 'academy.students.write'];
  tenantResolvido = true;
});

describe('ATAQUE · operar desafios sem permissão de tenant', () => {
  it('quem só LÊ o painel não cria, não convida e não cancela', async () => {
    // É o perfil `academy_finance`: tem `academy.dashboard` e nada de escrita.
    // Com a escrita gateada só pelo dashboard, ele convidaria a base inteira.
    permissoes = ['academy.dashboard'];
    for (const [metodo, url] of [
      ['post', '/api/academy/challenges'],
      ['post', '/api/academy/challenges/10/invite'],
      ['post', '/api/academy/challenges/10/cancel'],
    ] as const) {
      const agente = request(app()) as never as Record<string, (u: string) => request.Test>;
      const res = await agente[metodo](url).send({ title: 'X' });
      expect(res.status).toBe(403);
    }
    // Mas LÊ normalmente.
    service.listChallengesForAcademyPanel.mockResolvedValue([]);
    expect((await request(app()).get('/api/academy/challenges')).status).toBe(200);
  });

  it('quem só ESCREVE sobre alunos não opera desafio que não consegue ver', async () => {
    // É a `academy_reception`: tem `students.write` e não tem `dashboard`.
    permissoes = ['academy.students.write'];
    const res = await request(app())
      .post('/api/academy/challenges/10/invite')
      .send({});
    expect(res.status).toBe(403);
  });

  it('sem NENHUMA permissão, as cinco rotas recusam', async () => {
    permissoes = [];
    for (const [metodo, url] of ROTAS) {
      const agente = request(app()) as never as Record<string, (u: string) => request.Test>;
      const res = await agente[metodo](url).send({ title: 'X' });
      expect(res.status).toBe(403);
    }
    expect(service.createAcademyChallenge).not.toHaveBeenCalled();
    expect(service.getAcademyChallengePanel).not.toHaveBeenCalled();
  });

  it('cada rota exige a SUA permissão — não uma genérica', async () => {
    for (const [metodo, url, exigida] of ROTAS) {
      // Concede todas MENOS a exigida por esta rota.
      permissoes = ['academy.dashboard', 'academy.students.write'].filter(
        (p) => p !== exigida,
      );
      const agente = request(app()) as never as Record<string, (u: string) => request.Test>;
      const res = await agente[metodo](url).send({ title: 'X' });
      expect(res.status).toBe(403);
    }
  });

  it('sem tenant resolvido, nada passa', async () => {
    tenantResolvido = false;
    const res = await request(app()).get('/api/academy/challenges');
    expect(res.status).toBe(403);
    expect(service.listChallengesForAcademyPanel).not.toHaveBeenCalled();
  });
});

describe('Ownership · o tenant vem do CONTEXTO, nunca do corpo', () => {
  it('criar usa o academyId resolvido, ignorando o do payload', async () => {
    service.createAcademyChallenge.mockResolvedValue({ id: '1' });
    await request(app())
      .post('/api/academy/challenges')
      .send({ title: 'X', kind: 'consistency', academyId: 999, academy_id: 999, scope: 'personal' });

    expect(service.createAcademyChallenge).toHaveBeenCalledWith(
      ACADEMIA,
      42,
      expect.any(Object),
    );
    expect(service.createAcademyChallenge.mock.calls[0][0]).toBe(ACADEMIA);
  });

  it('ler, convidar e cancelar também', async () => {
    service.getAcademyChallengePanel.mockResolvedValue({ engagement: {} });
    service.inviteToAcademyChallenge.mockResolvedValue({ invited: 0, rejected: 0 });
    service.cancelAcademyChallengeAsTenant.mockResolvedValue({ status: 'cancelled' });

    await request(app()).get('/api/academy/challenges/10?academyId=999');
    await request(app()).post('/api/academy/challenges/10/invite').send({ academyId: 999 });
    await request(app()).post('/api/academy/challenges/10/cancel').send({ academyId: 999 });

    expect(service.getAcademyChallengePanel).toHaveBeenCalledWith(ACADEMIA, '10');
    expect(service.inviteToAcademyChallenge).toHaveBeenCalledWith(ACADEMIA, '10', undefined);
    expect(service.cancelAcademyChallengeAsTenant).toHaveBeenCalledWith(ACADEMIA, '10');
  });

  it('convite sem `studentIds` significa "todos os elegíveis" — resolvidos no servidor', async () => {
    service.inviteToAcademyChallenge.mockResolvedValue({ invited: 12, rejected: 0 });
    await request(app()).post('/api/academy/challenges/10/invite').send({});

    // `undefined` é o sinal de "todos": a rota não fabrica lista nenhuma.
    expect(service.inviteToAcademyChallenge).toHaveBeenCalledWith(ACADEMIA, '10', undefined);
  });
});

describe('Entrada malformada', () => {
  it('id inválido vira 404 antes de tocar o serviço', async () => {
    for (const id of ['abc', '0', '-1', '1;DROP TABLE challenges']) {
      const res = await request(app()).get(
        `/api/academy/challenges/${encodeURIComponent(id)}`,
      );
      expect(res.status).toBe(404);
    }
    expect(service.getAcademyChallengePanel).not.toHaveBeenCalled();
  });

  it('id acima da faixa do int4 continua válido — a tabela é bigint', async () => {
    service.getAcademyChallengePanel.mockResolvedValue({ engagement: {} });
    const grande = '9007199254740991';
    const res = await request(app()).get(`/api/academy/challenges/${grande}`);

    expect(res.status).toBe(200);
    expect(service.getAcademyChallengePanel).toHaveBeenCalledWith(ACADEMIA, grande);
  });

  it('desafio de outro tenant responde 404, sem revelar existência', async () => {
    service.getAcademyChallengePanel.mockRejectedValue(
      new ChallengeErrorMock('NOT_FOUND', 404, 'Desafio não encontrado'),
    );
    const res = await request(app()).get('/api/academy/challenges/10');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/tenant|outra|academia \d/i);
  });

  it('erro interno não vaza detalhe do banco', async () => {
    service.listChallengesForAcademyPanel.mockRejectedValue(
      new Error('relation "challenges" does not exist'),
    );
    const res = await request(app()).get('/api/academy/challenges');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|does not exist/);
  });
});
