/**
 * Interpretação do preset semanal — regressão do ISSUE-003 (/qa, ago/2026).
 *
 * O campo `week_preset` era lido em dois lugares com regras diferentes: o motor
 * de consistência mapeava `'semana_util'` para 5, e a escolha do treino do dia
 * fazia `parseInt`, obtinha `NaN` e prendia o aluno no Dia 1 para sempre. O
 * mesmo aluno, na mesma ficha, contava como "5 treinos previstos" enquanto o
 * app lhe entregava sempre o mesmo treino.
 *
 * Estes testes travam o intérprete único e o fuso — este último porque o
 * servidor roda em UTC e o aluno vive em São Paulo.
 */
import { computeTodayDayIndex, isoDayOfWeek, resolveWeekDays } from '../utils/weekPreset';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Semana de referência: 2026-08-10 é uma SEGUNDA.
const SEG = '2026-08-10';
const TER = '2026-08-11';
const QUA = '2026-08-12';
const QUI = '2026-08-13';
const SEX = '2026-08-14';
const SAB = '2026-08-15';
const DOM = '2026-08-16';

describe('resolveWeekDays', () => {
  it('semana_util é segunda a sexta — cinco dias', () => {
    expect(resolveWeekDays('semana_util')).toBe(5);
  });

  it('presets modernos continuam valendo', () => {
    for (const p of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(resolveWeekDays(p)).toBe(Number(p));
    }
  });

  it('nunca devolve NaN — era o defeito', () => {
    for (const p of ['semana_util', 'xpto', '', '  ', null, undefined, '0', '99', '3.5']) {
      const r = resolveWeekDays(p as string | null);
      expect(Number.isNaN(r as number)).toBe(false);
      expect(r === null || Number.isInteger(r)).toBe(true);
    }
  });

  it('preset desconhecido devolve null e registra aviso — não falha calado', () => {
    const logger = jest.requireMock('../lib/logger').default;
    logger.warn.mockClear();
    expect(resolveWeekDays('preset_que_ninguem_criou')).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'preset_que_ninguem_criou' }),
      expect.stringContaining('week_preset'),
    );
  });

  it('valor fora da faixa 1–7 não vira dia de treino', () => {
    expect(resolveWeekDays('0')).toBeNull();
    expect(resolveWeekDays('8')).toBeNull();
    expect(resolveWeekDays('-3')).toBeNull();
  });

  it('espaço em volta não quebra o apelido', () => {
    expect(resolveWeekDays(' semana_util ')).toBe(5);
  });
});

describe('isoDayOfWeek — segunda é 1, domingo é 7', () => {
  it.each([
    [SEG, 1],
    [TER, 2],
    [QUA, 3],
    [QUI, 4],
    [SEX, 5],
    [SAB, 6],
    [DOM, 7],
  ])('%s → %i', (dia, esperado) => {
    expect(isoDayOfWeek(dia)).toBe(esperado);
  });
});

describe('computeTodayDayIndex', () => {
  it('semana_util percorre os cinco dias, de segunda a sexta', () => {
    expect([SEG, TER, QUA, QUI, SEX].map((d) => computeTodayDayIndex('semana_util', d))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('o fim de semana volta ao começo do ciclo, como no preset 5', () => {
    // O motor não tem conceito de dia de descanso; sábado e domingo reentram no
    // ciclo. O importante é ser IGUAL ao preset '5', para que dois nomes do
    // mesmo conceito não produzam treinos diferentes.
    expect(computeTodayDayIndex('semana_util', SAB)).toBe(computeTodayDayIndex('5', SAB));
    expect(computeTodayDayIndex('semana_util', DOM)).toBe(computeTodayDayIndex('5', DOM));
  });

  it('é sempre 1-based — nunca devolve 0', () => {
    for (const preset of ['1', '2', '3', '4', '5', '6', '7', 'semana_util', 'xpto']) {
      for (const dia of [SEG, TER, QUA, QUI, SEX, SAB, DOM]) {
        const i = computeTodayDayIndex(preset, dia);
        expect(i).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(i)).toBe(true);
      }
    }
  });

  it('nunca passa do número de dias do ciclo', () => {
    for (const [preset, dias] of [['4', 4], ['5', 5], ['semana_util', 5]] as const) {
      for (const dia of [SEG, TER, QUA, QUI, SEX, SAB, DOM]) {
        expect(computeTodayDayIndex(preset, dia)).toBeLessThanOrEqual(dias);
      }
    }
  });

  it('ciclo de 4 dias vira na quinta, e não some nenhum dia', () => {
    expect([SEG, TER, QUA, QUI, SEX, SAB, DOM].map((d) => computeTodayDayIndex('4', d))).toEqual([
      1, 2, 3, 4, 1, 2, 3,
    ]);
  });

  it('ficha de um dia só entrega sempre o Dia 1', () => {
    for (const dia of [SEG, QUA, DOM]) {
      expect(computeTodayDayIndex('1', dia)).toBe(1);
    }
  });

  it('preset desconhecido cai no Dia 1 — o único índice que sempre existe', () => {
    expect(computeTodayDayIndex('xpto', QUA)).toBe(1);
    expect(computeTodayDayIndex(null, QUA)).toBe(1);
  });
});

describe('fuso — o dia é o do ALUNO, não o do servidor', () => {
  it('domingo 23h em Brasília ainda é domingo, mesmo já sendo segunda em UTC', () => {
    // 2026-08-16T23:30 BRT = 2026-08-17T02:30 UTC. Com `new Date().getDay()` no
    // servidor (UTC) o aluno receberia o treino de SEGUNDA no domingo à noite.
    // A função recebe o dia já resolvido no fuso do aluno, então isso não
    // acontece: domingo continua sendo o índice de domingo.
    expect(computeTodayDayIndex('semana_util', DOM)).toBe(2);
    expect(computeTodayDayIndex('semana_util', SEG)).toBe(1);
    expect(computeTodayDayIndex('semana_util', DOM)).not.toBe(
      computeTodayDayIndex('semana_util', SEG),
    );
  });

  it('a virada de mês não altera a sequência do ciclo', () => {
    // 2026-08-31 é segunda; 2026-09-01, terça.
    expect(computeTodayDayIndex('semana_util', '2026-08-31')).toBe(1);
    expect(computeTodayDayIndex('semana_util', '2026-09-01')).toBe(2);
  });

  it('a virada de ano também não', () => {
    // 2026-12-31 é quinta; 2027-01-01, sexta.
    expect(computeTodayDayIndex('semana_util', '2026-12-31')).toBe(4);
    expect(computeTodayDayIndex('semana_util', '2027-01-01')).toBe(5);
  });
});

describe('as duas leituras do preset concordam', () => {
  it('o alvo semanal e a rotação usam o mesmo número de dias', async () => {
    // Era exatamente aqui que o produto se contradizia.
    const { weeklyTargetFromPreset } = await import('../services/personalDashboardService');
    for (const preset of ['semana_util', '4', '5', '6']) {
      const alvo = weeklyTargetFromPreset(preset);
      const maiorIndice = Math.max(
        ...[SEG, TER, QUA, QUI, SEX, SAB, DOM].map((d) => computeTodayDayIndex(preset, d)),
      );
      expect(maiorIndice).toBe(alvo);
    }
  });
});
