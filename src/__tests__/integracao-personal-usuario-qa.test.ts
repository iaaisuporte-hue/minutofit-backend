/**
 * Regressões do QA de integração Personal × Aluno (02/ago/2026).
 *
 * Cada bloco trava um defeito encontrado no teste ponta a ponta das duas mãos
 * (personal → aluno e aluno → personal). Ver
 * plans/qa_integracao_personal_usuario_2026-08-02_1.md.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import { parseId, parseLimit, PG_INT4_MAX } from '../utils/parseId';
import { resolveMonthlyTarget } from '../services/personalDashboardService';
import { ACTION_TYPES } from '../services/personalRetentionService';

describe('P0-1 · id fora da faixa do int4 nunca chega ao banco', () => {
  // A causa da queda do processo: `9007199254740991` passava por
  // Number.isFinite/parseInt, estourava o int4 no Postgres e a rejeição —
  // em middleware async sem try/catch — derrubava o Node inteiro.
  it('rejeita inteiro maior que o int4 do Postgres', () => {
    expect(parseId('9007199254740991')).toBeNull();
    expect(parseId(String(PG_INT4_MAX + 1))).toBeNull();
    expect(parseId(PG_INT4_MAX)).toBe(PG_INT4_MAX);
  });

  it('rejeita negativos, zero e o negativo gigante que derrubava o servidor', () => {
    expect(parseId('-1')).toBeNull();
    expect(parseId('0')).toBeNull();
    expect(parseId('-99999999999')).toBeNull();
  });

  it('rejeita formatos que o Number() aceitaria por coerção', () => {
    expect(parseId('12e5')).toBeNull();
    expect(parseId('0x10')).toBeNull();
    expect(parseId('1.5')).toBeNull();
    expect(parseId(' 1 OR 1=1')).toBeNull();
    expect(parseId("1' OR '1'='1")).toBeNull();
    expect(parseId('')).toBeNull();
    expect(parseId(null)).toBeNull();
    expect(parseId(undefined)).toBeNull();
    expect(parseId({})).toBeNull();
  });

  it('aceita id legítimo, inclusive com zeros à esquerda', () => {
    expect(parseId('42')).toBe(42);
    expect(parseId('00000000000000000012')).toBe(12);
    expect(parseId(7)).toBe(7);
  });
});

describe('P2-7 · limite de paginação inválido não vira 500', () => {
  it('entrada não numérica cai no default em vez de chegar como NaN ao LIMIT', () => {
    expect(parseLimit("' OR '1'='1", 50)).toBe(50);
    expect(parseLimit('NaN', 50)).toBe(50);
    expect(parseLimit(undefined, 50)).toBe(50);
    expect(parseLimit(['1', '2'] as unknown, 50)).toBe(50);
  });

  it('clampa para a faixa utilizável', () => {
    expect(parseLimit('-1', 50)).toBe(1);
    expect(parseLimit('99999999999', 50)).toBe(100);
    expect(parseLimit('10', 50)).toBe(10);
    expect(parseLimit('10', 50, 5)).toBe(5);
  });
});

describe('P1-2 · aderência proporcional ao tempo de vínculo', () => {
  // Aluno de 1 dia media contra o mês inteiro: 1 treino = 8% → `adherencePct < 15`
  // → "crítico" no dia em que ele fez tudo certo.
  it('mede a janela que o aluno realmente teve, não o mês fechado', () => {
    const cheio = resolveMonthlyTarget('basic', '3');
    expect(resolveMonthlyTarget('basic', '3', 1)).toBeLessThan(cheio);
    expect(resolveMonthlyTarget('basic', '3', 7)).toBeLessThan(cheio);
  });

  it('aluno de 1 dia que treinou 1x não cai mais na faixa de "crítico" (<15%)', () => {
    const target = resolveMonthlyTarget('basic', '3', 1);
    expect(Math.round((1 / target) * 100)).toBeGreaterThanOrEqual(15);
  });

  it('aluno perfeito na primeira semana não é rotulado "alerta" por aritmética', () => {
    // ficha 3x/semana, 3 treinos em 7 dias = semana perfeita
    const target = resolveMonthlyTarget('basic', '3', 7);
    expect(Math.round((3 / target) * 100)).toBeGreaterThanOrEqual(45);
  });

  it('piso de 7 dias evita denominador de um único dia (aderência absurda)', () => {
    expect(resolveMonthlyTarget('basic', '3', 0)).toBe(resolveMonthlyTarget('basic', '3', 7));
  });

  it('a partir de 30 dias volta a ser o alvo mensal cheio', () => {
    const cheio = resolveMonthlyTarget('basic', '3');
    expect(resolveMonthlyTarget('basic', '3', 30)).toBe(cheio);
    expect(resolveMonthlyTarget('basic', '3', 90)).toBe(cheio);
  });

  it('sem data de atribuição mantém o comportamento anterior (alvo cheio)', () => {
    expect(resolveMonthlyTarget('basic', '3', null)).toBe(resolveMonthlyTarget('basic', '3'));
  });

  it('nunca devolve alvo zero — divisão por zero viraria NaN%', () => {
    for (const dias of [0, 1, 3, 7, 15, 29, 30]) {
      expect(resolveMonthlyTarget('basic', '3', dias)).toBeGreaterThanOrEqual(1);
      expect(resolveMonthlyTarget('basic', null, dias)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('P2-7 · actionType validado na borda, não pelo CHECK do banco', () => {
  it('o enum exportado cobre os tipos aceitos pela timeline', () => {
    expect(ACTION_TYPES).toContain('observation');
    expect(ACTION_TYPES).toContain('message_sent');
    expect(ACTION_TYPES).not.toContain('inventado');
  });

  it('a rota consegue recusar antes do INSERT (lista não vazia e imutável)', () => {
    expect(ACTION_TYPES.length).toBeGreaterThan(0);
    expect(ACTION_TYPES.includes('observation' as (typeof ACTION_TYPES)[number])).toBe(true);
  });
});
