/**
 * Consentimento e minimização de dados enviados à IA (Spec 039) — unitários.
 *
 * Sem banco e sem rede: o `pool` é um mock programável e o SDK da OpenAI é substituído
 * por um `create` que só conta chamadas. Isso permite afirmar o que mais importa — "ZERO
 * chamada externa quando não há consentimento" — como `expect(create).not.toHaveBeenCalled()`,
 * em vez de torcer para que nenhuma requisição saia.
 */
const mockQuery = jest.fn();
const mockCreate = jest.fn();

jest.mock('../config/database', () => ({ __esModule: true, default: { query: (...a: unknown[]) => mockQuery(...a) } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    responses = { create: (...a: unknown[]) => mockCreate(...a) };
  },
}));

import { CURRENT_AI_POLICY_VERSION } from '../config/legal';
import { aiCall } from '../lib/ai/openai';
import {
  AiConsentRequiredError,
  evaluateConsent,
  grantAiConsent,
  hasValidAiConsent,
  revokeAiConsent,
} from '../services/aiConsentService';
import { generateStudentSummary } from '../services/ai/studentSummaryAi';
import { getMetabolismInterpretation } from '../modules/metabolism/metabolic.interpretation';
import { interpretIntakeTextWithAi } from '../services/ai/intakeInterpreterAi';

const AGORA = '2026-10-18T12:00:00.000Z';
const ANTES = '2026-10-17T12:00:00.000Z';

/** Linha de `users` com consentimento vigente. */
const consentimentoVigente = {
  ai_processing_consent_at: ANTES,
  ai_processing_consent_version: CURRENT_AI_POLICY_VERSION,
  ai_processing_revoked_at: null,
};

/** Programa o que o banco devolve para a consulta de consentimento de cada titular. */
function bancoComConsentimento(porUsuario: Record<number, Record<string, unknown> | undefined>) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM users WHERE id = \$1/.test(sql)) {
      const row = porUsuario[Number(params[0])];
      return { rows: row ? [row] : [] };
    }
    return { rows: [] }; // trilha de auditoria etc.
  });
}

/** Resposta mínima válida do provedor. */
const respostaDoProvedor = (text: string) => ({ status: 'completed', output_text: text, usage: null });

const PII = { nome: 'Maria Souza', email: 'maria.souza@exemplo.com', cpf: '123.456.789-09', telefone: '11987654321' };

beforeEach(() => {
  mockQuery.mockReset();
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = 'chave-de-teste';
  mockCreate.mockResolvedValue(respostaDoProvedor('ok'));
});

describe('evaluateConsent — regra pura', () => {
  it('nunca concedido → não vale', () => {
    expect(evaluateConsent(undefined).granted).toBe(false);
    expect(evaluateConsent({ ai_processing_consent_at: null, ai_processing_consent_version: null, ai_processing_revoked_at: null }).granted).toBe(false);
  });

  it('concedido na versão vigente → vale', () => {
    expect(evaluateConsent(consentimentoVigente)).toMatchObject({ granted: true, needsReconsent: false });
  });

  it('revogado depois do aceite → não vale', () => {
    expect(evaluateConsent({ ...consentimentoVigente, ai_processing_revoked_at: AGORA }).granted).toBe(false);
  });

  it('aceite de versão antiga da política → não vale e pede novo aceite', () => {
    expect(
      evaluateConsent({ ...consentimentoVigente, ai_processing_consent_version: '2020-01-01' }),
    ).toMatchObject({ granted: false, needsReconsent: true });
  });
});

describe('gate central em aiCall (defesa em profundidade)', () => {
  const chamada = (subjectUserId: number, extra: object = {}) =>
    aiCall({
      subjectUserId,
      purpose: 'student_summary',
      instructions: 'x',
      input: 'dados',
      maxOutputTokens: 100,
      ...extra,
    });

  it('1. sem consentimento → ZERO chamada externa', async () => {
    bancoComConsentimento({ 10: undefined });
    await expect(chamada(10)).rejects.toBeInstanceOf(AiConsentRequiredError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('2. consentimento válido → chamada permitida, e auditada sem o conteúdo do prompt', async () => {
    bancoComConsentimento({ 10: consentimentoVigente });
    await expect(chamada(10, { input: 'SEGREDO-DO-PROMPT' })).resolves.toMatchObject({ text: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const auditoria = mockQuery.mock.calls.filter(([sql]) => /INSERT INTO data_access_audit/.test(String(sql)));
    expect(auditoria).toHaveLength(1);
    const [, params] = auditoria[0] as [string, unknown[]];
    expect(params[2]).toBe('ai.processing');
    expect(JSON.parse(String(params[3]))).toEqual({ purpose: 'student_summary' });
    expect(JSON.stringify(params)).not.toContain('SEGREDO-DO-PROMPT');
  });

  it('3. consentimento revogado → chamada bloqueada', async () => {
    bancoComConsentimento({ 10: { ...consentimentoVigente, ai_processing_revoked_at: AGORA } });
    await expect(chamada(10)).rejects.toBeInstanceOf(AiConsentRequiredError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('4. falha ao ler o consentimento → bloqueia (fail-closed), não envia', async () => {
    mockQuery.mockRejectedValue(new Error('conexão perdida'));
    await expect(chamada(10)).rejects.toBeInstanceOf(AiConsentRequiredError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('titular inválido (NaN, 0, negativo) → bloqueia sem nem consultar o banco', async () => {
    for (const id of [Number.NaN, 0, -3, 1.5]) {
      await expect(chamada(id)).rejects.toBeInstanceOf(AiConsentRequiredError);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('5. profissional pede IA sobre aluno SEM opt-in → bloqueada, e o erro aponta o aluno', async () => {
    // O personal (20) tem consentimento; o aluno (10) não. O dele não substitui o do aluno.
    bancoComConsentimento({ 20: consentimentoVigente, 10: undefined });
    const erro = await chamada(10, { actorUserId: 20 }).catch((e) => e);
    expect(erro).toBeInstanceOf(AiConsentRequiredError);
    expect(erro.subject).toBe('student');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('6. profissional pede IA sobre aluno autorizado → permitida, sem exigir consentimento do profissional', async () => {
    bancoComConsentimento({ 10: consentimentoVigente, 20: undefined });
    await expect(chamada(10, { actorUserId: 20 })).resolves.toMatchObject({ text: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('11. revogar vale para as chamadas seguintes', async () => {
    let revogado = false;
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM users WHERE id = \$1/.test(sql)) {
        return { rows: [{ ...consentimentoVigente, ai_processing_revoked_at: revogado ? AGORA : null }] };
      }
      return { rows: [] };
    });
    await chamada(10);
    revogado = true;
    await expect(chamada(10)).rejects.toBeInstanceOf(AiConsentRequiredError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('não gasta cota de rate limit quando o consentimento barra', async () => {
    bancoComConsentimento({ 10: undefined });
    await chamada(10, { userId: 'rl-user' }).catch(() => undefined);
    bancoComConsentimento({ 10: consentimentoVigente });
    // 10 chamadas/hora: se a barrada tivesse contado, a 10ª passaria do limite.
    for (let i = 0; i < 10; i++) await chamada(10, { userId: 'rl-user' });
    expect(mockCreate).toHaveBeenCalledTimes(10);
  });
});

describe('hasValidAiConsent — nunca lança', () => {
  it('erro de banco vira false', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));
    await expect(hasValidAiConsent(1)).resolves.toBe(false);
  });
});

describe('conceder e revogar', () => {
  it('conceder carimba a versão vigente NO SERVIDOR e limpa a revogação anterior', async () => {
    mockQuery.mockResolvedValue({ rows: [consentimentoVigente] });
    const estado = await grantAiConsent(10, '203.0.113.9');
    expect(estado.granted).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ai_processing_revoked_at = NULL/);
    expect(params).toEqual([10, CURRENT_AI_POLICY_VERSION]);
  });

  it('4b. falha ao gravar o aceite → lança, e nada passa a valer', async () => {
    mockQuery.mockRejectedValue(new Error('disco cheio'));
    await expect(grantAiConsent(10)).rejects.toThrow('disco cheio');
  });

  it('revogar é idempotente quando nunca houve aceite', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      /^\s*UPDATE users/.test(sql) ? { rows: [] } : { rows: [{ ai_processing_consent_at: null, ai_processing_consent_version: null, ai_processing_revoked_at: null }] },
    );
    await expect(revokeAiConsent(10)).resolves.toMatchObject({ granted: false });
  });
});

describe('7/8. minimização — o que realmente sai no prompt', () => {
  beforeEach(() => bancoComConsentimento({ 10: consentimentoVigente }));

  const promptEnviado = (): string => String((mockCreate.mock.calls[0]?.[0] as { input: string }).input);

  it('o resumo do aluno NÃO leva nome, e-mail, CPF, telefone nem id', async () => {
    mockCreate.mockResolvedValue(respostaDoProvedor('Resumo.'));
    await generateStudentSummary(20, 10, {
      // Mesmo que um chamador antigo ainda passe PII no objeto, ela não pode vazar para o prompt.
      ...({ name: PII.nome, email: PII.email, cpf: PII.cpf, phone: PII.telefone } as object),
      streakDays: 3,
      adherencePct: 80,
      workouts7d: 2,
      workouts30d: 9,
      metabolismScore: 61,
      metabolismTrend: 'up',
      metabolismDelta7d: 4,
      latestSleptWell: false,
      engagementStatus: 'ativo',
      riskScore: 30,
      engagementScore: 70,
      assignedWeeks: 5,
    });
    const enviado = promptEnviado();
    for (const dado of Object.values(PII)) expect(enviado).not.toContain(dado);
    expect(enviado).not.toMatch(/\b10\b.*aluno|id[:=]\s*10/i);
    // O necessário continua: a síntese depende dos números, não de quem é a pessoa.
    expect(enviado).toContain('Aderência mensal: 80%');
  });

  it('a interpretação metabólica não leva identificador algum', async () => {
    mockCreate.mockResolvedValue(
      respostaDoProvedor(JSON.stringify({ hint: 'Dia moderado.', intensity: 'moderada', action: 'Caminhar.' })),
    );
    const r = await getMetabolismInterpretation(10, {
      score: 55,
      status: 'attention',
      trend: 'stable',
      factors: [{ key: 'sleep', label: 'Sono curto', delta: -6 }],
      recommendations: [],
      trend7d: { delta: 0, direction: 'stable' },
      trend30d: { delta: 0, direction: 'stable' },
    } as never);
    expect(r.interpretation).toEqual({ hint: 'Dia moderado.', action: 'Caminhar.' });
    const enviado = promptEnviado();
    expect(enviado).not.toMatch(/@|\bcpf\b|nome|telefone/i);
    expect(enviado).not.toMatch(/\b10\b/);
  });
});

describe('fluxos implícitos degradam sem erro quando não há consentimento', () => {
  it('metabolismo: sem consentimento → interpretation null + aiConsentRequired, zero chamada, cache não sobrevive à revogação', async () => {
    // Titular próprio (11): o cache de 4h é de módulo e o caso anterior já populou o do 10.
    bancoComConsentimento({ 11: consentimentoVigente });
    mockCreate.mockResolvedValue(
      respostaDoProvedor(JSON.stringify({ hint: 'Primeira.', intensity: 'leve', action: 'Descansar.' })),
    );
    const saida = { score: 70, status: 'good', trend: 'up', factors: [], recommendations: [], trend7d: { delta: 1, direction: 'stable' }, trend30d: { delta: 1, direction: 'stable' } } as never;

    const comConsentimento = await getMetabolismInterpretation(11, saida);
    expect(comConsentimento.interpretation).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Revoga: o cache de 4h NÃO pode mais ser servido.
    bancoComConsentimento({ 11: { ...consentimentoVigente, ai_processing_revoked_at: AGORA } });
    const depoisDeRevogar = await getMetabolismInterpretation(11, saida);
    expect(depoisDeRevogar).toEqual({ interpretation: null, aiConsentRequired: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('interpretação de refeição: sem consentimento devolve null (cai no determinístico), sem poluir a métrica de falha', async () => {
    bancoComConsentimento({ 10: undefined });
    await expect(interpretIntakeTextWithAi('uma banana', 10)).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
