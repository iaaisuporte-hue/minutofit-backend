/**
 * Consentimento de IA (Spec 039) com banco REAL e rotas REAIS.
 *
 * O unitário prova o gate de `aiCall`. Este prova o que só aparece atravessando o router:
 * que o endpoint não é contornável por chamada direta, que cada papel recebe a resposta
 * certa, e que o consentimento de IA não se confunde com os consentimentos por profissional.
 *
 * Só o provedor externo é falso: o SDK da OpenAI é trocado por um `create` que conta
 * chamadas. Nenhuma requisição paga sai daqui.
 *
 * Rodar com banco local: TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/<banco_de_teste>
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const mockCreate = jest.fn();
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    responses = { create: (...a: unknown[]) => mockCreate(...a) };
  },
}));
// Só o mapa de recursos é falso: liga `nutrition_intake_ai` (ROLLOUT_ONLY, desligada por padrão).
const mockFeatures = jest.fn();
jest.mock('../services/planFeatureService', () => ({
  ...jest.requireActual('../services/planFeatureService'),
  getFeatureMapForUser: (...a: unknown[]) => mockFeatures(...a),
}));
jest.setTimeout(120_000);

const TAG = 'itest-aiconsent';
const HINT = JSON.stringify({ hint: 'Dia moderado.', intensity: 'moderada', action: 'Caminhar 20 min.' });

describeWithDb('Spec 039 · consentimento de IA ponta a ponta', () => {
  let c: Client;
  let app: import('express').Express;
  let bearer: (id: number, role: 'user' | 'personal', produto: 'app' | 'personal') => string;
  let get: (path: string, token: string) => import('supertest').Test;
  let post: (path: string, token: string, body?: object) => import('supertest').Test;
  let del: (path: string, token: string) => import('supertest').Test;

  let personal: number;
  let aluno: number;
  let alunoSemVinculo: number;

  const tokenAluno = (id = aluno) => bearer(id, 'user', 'app');
  const tokenPersonal = () => bearer(personal, 'personal', 'personal');

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'chave-de-teste';
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);

    personal = await createUser(c, TAG, 'personal');
    aluno = await createUser(c, TAG, 'aluno');
    alunoSemVinculo = await createUser(c, TAG, 'solto');

    await c.query(
      `INSERT INTO personal_platform_subscriptions (personal_id, plan, status, ai_enabled) VALUES ($1, 'pro', 'active', true)`,
      [personal],
    );
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id) VALUES ($1, $2, 'active', NULL)`,
      [personal, aluno],
    );
    // Consentimentos POR PROFISSIONAL (Spec 012): perfil + treinos + metabolismo.
    for (const scope of ['profile', 'workouts', 'metabolic']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status, granted_at)
         VALUES ($1, $2, 'personal', $3, 'granted', NOW())`,
        [aluno, personal, scope],
      );
    }

    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    const userRoutes = (await import('../routes/user')).default;
    const personalRoutes = (await import('../routes/personal')).default;
    const metabolismRoutes = (await import('../modules/metabolism/metabolic.controller')).default;

    app = express();
    app.use(express.json());
    app.use('/api/user', userRoutes);
    app.use('/api/personal', personalRoutes);
    app.use('/api', metabolismRoutes);

    bearer = (id, role, produto) =>
      generateAccessToken({ id, email: `${id}@test.local`, role, profileCompleted: true, products: [produto] } as never);
    get = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`);
    post = (path, token, body = {}) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
    del = (path, token) => request(app).delete(path).set('Authorization', `Bearer ${token}`);
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  beforeEach(async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ status: 'completed', output_text: HINT, usage: null });
    // Estado limpo de consentimento a cada caso (as rotas de metabolismo guardam cache por usuário).
    await c.query(
      `UPDATE users SET ai_processing_consent_at = NULL, ai_processing_consent_version = NULL, ai_processing_revoked_at = NULL
        WHERE id = ANY($1)`,
      [[personal, aluno, alunoSemVinculo]],
    );
  });

  const aiConsentLinhas = async (id: number, tipo: string) =>
    Number(
      (await c.query(`SELECT count(*)::int AS n FROM data_access_audit WHERE subject_user_id = $1 AND event_type = $2`, [id, tipo]))
        .rows[0].n,
    );

  describe('rotas de consentimento (/api/user/ai-consent)', () => {
    it('começa sem consentimento, e conceder exige aceite explícito', async () => {
      const antes = await get('/api/user/ai-consent', tokenAluno());
      expect(antes.status).toBe(200);
      expect(antes.body.data).toMatchObject({ granted: false, grantedAt: null });

      // Nada de default nem de inferência: sem `accepted: true` literal não grava.
      expect((await post('/api/user/ai-consent', tokenAluno(), {})).status).toBe(400);
      expect((await post('/api/user/ai-consent', tokenAluno(), { accepted: 'true' })).status).toBe(400);
      expect((await post('/api/user/ai-consent', tokenAluno(), { accepted: 1 })).status).toBe(400);
      expect((await get('/api/user/ai-consent', tokenAluno())).body.data.granted).toBe(false);
    });

    it('conceder → vale e fica auditado; revogar → deixa de valer e fica auditado; revogar de novo é idempotente', async () => {
      const antesGrant = await aiConsentLinhas(aluno, 'ai.consent.granted');
      const antesRevoke = await aiConsentLinhas(aluno, 'ai.consent.revoked');

      const grant = await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      expect(grant.status).toBe(200);
      expect(grant.body.data.granted).toBe(true);
      // A versão é carimbada pelo servidor; qualquer `version` vinda do cliente é ignorada.
      const comVersaoDoCliente = await post('/api/user/ai-consent', tokenAluno(), { accepted: true, version: '1999-01-01' });
      expect(comVersaoDoCliente.body.data.version).toBe(grant.body.data.version);

      const revoke = await del('/api/user/ai-consent', tokenAluno());
      expect(revoke.status).toBe(200);
      expect(revoke.body.data.granted).toBe(false);
      expect((await del('/api/user/ai-consent', tokenAluno())).status).toBe(200);

      expect(await aiConsentLinhas(aluno, 'ai.consent.granted')).toBeGreaterThan(antesGrant);
      expect(await aiConsentLinhas(aluno, 'ai.consent.revoked')).toBeGreaterThan(antesRevoke);
    });

    it('exige autenticação', async () => {
      const request = (await import('supertest')).default;
      expect((await request(app).get('/api/user/ai-consent')).status).toBe(401);
      expect((await request(app).post('/api/user/ai-consent').send({ accepted: true })).status).toBe(401);
    });

    it('um usuário nunca mexe no consentimento de outro (o titular vem do token, não do corpo)', async () => {
      await post('/api/user/ai-consent', tokenAluno(alunoSemVinculo), { accepted: true, userId: aluno, id: aluno });
      expect((await get('/api/user/ai-consent', tokenAluno())).body.data.granted).toBe(false);
      expect((await get('/api/user/ai-consent', tokenAluno(alunoSemVinculo))).body.data.granted).toBe(true);
    });
  });

  describe('personal pede o resumo IA de um aluno (acesso direto ao endpoint)', () => {
    const rota = () => `/api/personal/students/${aluno}/ai-summary`;

    it('12. SEM opt-in do aluno → 403 AI_CONSENT_REQUIRED (subject student) e ZERO chamada ao provedor', async () => {
      const r = await get(rota(), tokenPersonal());
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ success: false, code: 'AI_CONSENT_REQUIRED', subject: 'student' });
      expect(String(r.body.error)).toMatch(/aluno/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('6. COM opt-in do aluno → 200, uma chamada, e o prompt não leva o nome do aluno', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      mockCreate.mockResolvedValue({ status: 'completed', output_text: 'Aluno consistente.', usage: null });

      const r = await get(rota(), tokenPersonal());
      expect(r.status).toBe(200);
      expect(r.body.data.summary).toBe('Aluno consistente.');
      expect(mockCreate).toHaveBeenCalledTimes(1);

      const enviado = JSON.stringify(mockCreate.mock.calls[0][0]);
      const nome = (await c.query(`SELECT name, email FROM users WHERE id = $1`, [aluno])).rows[0];
      expect(enviado).not.toContain(nome.name);
      expect(enviado).not.toContain(nome.email);
      expect(enviado).not.toContain(`${aluno}@test.local`);

      // E a trilha registra que dado do aluno saiu, com a finalidade — nunca o conteúdo.
      const trilha = await c.query(
        `SELECT actor_id, event_payload FROM data_access_audit WHERE subject_user_id = $1 AND event_type = 'ai.processing' ORDER BY created_at DESC LIMIT 1`,
        [aluno],
      );
      expect(trilha.rows[0].actor_id).toBe(personal);
      expect(trilha.rows[0].event_payload).toEqual({ purpose: 'student_summary' });
    });

    it('11. REVOGADO depois → volta a bloquear, sem nova chamada', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      expect((await get(rota(), tokenPersonal())).status).toBe(200);
      await del('/api/user/ai-consent', tokenAluno());

      const r = await get(rota(), tokenPersonal());
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('AI_CONSENT_REQUIRED');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('10. o consentimento de IA NÃO substitui o consentimento por profissional (e vice-versa)', async () => {
      // Aluno SEM vínculo/consent com o personal autoriza a IA: não abre a rota do personal.
      await post('/api/user/ai-consent', tokenAluno(alunoSemVinculo), { accepted: true });
      const semVinculo = await get(`/api/personal/students/${alunoSemVinculo}/ai-summary`, tokenPersonal());
      expect(semVinculo.status).toBe(403);
      expect(semVinculo.body.code).not.toBe('AI_CONSENT_REQUIRED');
      expect(mockCreate).not.toHaveBeenCalled();

      // E ter os consentimentos por profissional (profile/workouts/metabolic) não basta para a IA:
      // o caso "SEM opt-in" acima já os tinha todos concedidos e foi barrado.
    });

    it('o personal NÃO precisa de consentimento próprio para disparar a IA sobre dado do aluno', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      expect((await get('/api/user/ai-consent', tokenPersonal())).body.data.granted).toBe(false);
      expect((await get(rota(), tokenPersonal())).status).toBe(200);
    });
  });

  describe('personal gera uma ficha por IA (o texto é dele)', () => {
    it('sem o consentimento do PRÓPRIO personal → 403 (subject self) e zero chamada', async () => {
      const r = await post('/api/personal/ai/generate-workout', tokenPersonal(), { prompt: 'treino ABC para hipertrofia' });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'AI_CONSENT_REQUIRED', subject: 'self' });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('com o consentimento dele a chamada é feita (não é mais 403)', async () => {
      await post('/api/user/ai-consent', tokenPersonal(), { accepted: true });
      const r = await post('/api/personal/ai/generate-workout', tokenPersonal(), { prompt: 'treino ABC para hipertrofia' });
      expect(r.status).not.toBe(403);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('insight de performance (fluxo do personal, titular aluno)', () => {
    it('sem opt-in do aluno a tela continua completa: 200, texto determinístico, e diz por que a IA não rodou', async () => {
      const r = await post(`/api/personal/students/${aluno}/performance/insight`, tokenPersonal());
      expect(r.status).toBe(200);
      expect(r.body.data.source).toBe('deterministic');
      expect(r.body.aiConsentRequired).toBe('student');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('metabolismo do próprio aluno (fluxo implícito)', () => {
    it('9. sem opt-in o score continua funcionando; só a narrativa some, e a tela é avisada', async () => {
      const r = await get('/api/me/metabolism', tokenAluno());
      expect(r.status).toBe(200);
      expect(typeof r.body.score).toBe('number');
      expect(r.body.interpretation).toBeNull();
      expect(r.body.aiConsentRequired).toBe(true);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('com opt-in a narrativa aparece; ao revogar some NA HORA, mesmo com cache de 4h', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      const com = await get('/api/me/metabolism', tokenAluno());
      expect(com.body.interpretation).toEqual({ hint: 'Dia moderado.', action: 'Caminhar 20 min.' });
      expect(com.body.aiConsentRequired).toBeUndefined();

      await del('/api/user/ai-consent', tokenAluno());
      const sem = await get('/api/me/metabolism', tokenAluno());
      expect(sem.body.interpretation).toBeNull();
      expect(sem.body.aiConsentRequired).toBe(true);
      expect(typeof sem.body.score).toBe('number');
    });
  });

  describe('metabolismo visto pelo personal', () => {
    it('abrir o cockpit do aluno NÃO envia o dado dele ao provedor (nem com opt-in: a tela não exibe a narrativa)', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      const r = await get(`/api/personal/students/${aluno}/snapshot`, tokenPersonal());
      expect(r.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('interpretação de refeição (texto livre do aluno)', () => {
    // Texto que o parser determinístico não resolve, para que a IA seja considerada.
    const TEXTO = 'zzqxw kjhgfd';
    const modelo = jest.fn(async () => JSON.stringify({ items: [] }));

    beforeEach(() => {
      modelo.mockClear();
      mockFeatures.mockResolvedValue({ features: { nutrition_intake_ai: true } });
    });

    it('sem opt-in: o provedor não é chamado, o determinístico responde e a tela é avisada UMA vez', async () => {
      const { parseAndResolve } = await import('../services/nutritionIntakeService');
      const r = await parseAndResolve(TEXTO, aluno, { callModel: modelo });
      expect(modelo).not.toHaveBeenCalled();
      expect(r.aiUsed).toBe(false);
      expect(r.aiConsentRequired).toBe(true);
      expect(r.needsConfirmation).toBe(true);
    });

    it('com opt-in: a IA é consultada', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      const { parseAndResolve } = await import('../services/nutritionIntakeService');
      const r = await parseAndResolve(TEXTO, aluno, { callModel: modelo });
      expect(modelo).toHaveBeenCalledTimes(1);
      expect(r.aiConsentRequired).toBeUndefined();
    });

    it('revogado: volta a não chamar', async () => {
      await post('/api/user/ai-consent', tokenAluno(), { accepted: true });
      await del('/api/user/ai-consent', tokenAluno());
      const { parseAndResolve } = await import('../services/nutritionIntakeService');
      await parseAndResolve(TEXTO, aluno, { callModel: modelo });
      expect(modelo).not.toHaveBeenCalled();
    });

    it('recurso desligado para o usuário: nem consulta a IA nem insiste no pedido de autorização', async () => {
      mockFeatures.mockResolvedValue({ features: { nutrition_intake_ai: false } });
      const { parseAndResolve } = await import('../services/nutritionIntakeService');
      const r = await parseAndResolve(TEXTO, aluno, { callModel: modelo });
      expect(modelo).not.toHaveBeenCalled();
      expect(r.aiConsentRequired).toBeUndefined();
    });
  });

  describe('rota removida', () => {
    it('POST /personal/ai/metabolic-hint não existe mais (sem consumidor algum)', async () => {
      await post('/api/user/ai-consent', tokenPersonal(), { accepted: true });
      const r = await post('/api/personal/ai/metabolic-hint', tokenPersonal(), { context: 'score 40, sono ruim' });
      expect(r.status).toBe(404);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
