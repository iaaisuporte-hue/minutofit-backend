/**
 * Camada canônica de aderência/streak/tendência (SPEC 035 / P1A.4).
 *
 * Módulo puro, sem banco — mockar não seria necessário, mas o padrão do repo
 * mocka `config/database` em todo teste unitário; aqui nem é importado.
 */
import {
  computeAdherence,
  computeTrend,
  computeStreak,
  weightedAdherenceSum,
  buildCanonicalAdherenceBlock,
  MIN_EFFECTIVE_DAYS_FOR_SIGNAL,
  type MealCheckinStatus,
} from '../services/nutriAdherence';

describe('P1A.4 · computeAdherence — denominador proporcional (NUTRI-13)', () => {
  it('paciente de 2 dias de plano, 100% real, não lê 29% (denominador de 7 fixo)', () => {
    // 4 refeições/dia, 2 dias de vida, todas cumpridas: 8 de 8.
    const result = computeAdherence(8, 4, 7, 1); // daysSincePlanStart=1 → elapsed=2
    expect(result.effectiveDays).toBe(2);
    expect(result.pct).toBe(100);
    expect(result.calibrating).toBe(true); // < MIN_EFFECTIVE_DAYS_FOR_SIGNAL
  });

  it('fixture da SPEC (§30): 28 refeições possíveis, 20 done + 4 substituted + 2 delayed + 2 skipped → 93%', () => {
    const statuses: MealCheckinStatus[] = [
      ...Array(20).fill('done'),
      ...Array(4).fill('substituted'),
      ...Array(2).fill('delayed'),
      ...Array(2).fill('skipped'),
    ];
    const sum = weightedAdherenceSum(statuses);
    expect(sum).toBe(26); // 20+4+2+0
    const result = computeAdherence(sum, 4, 7, null); // janela fixa de 7 dias, 4 refeições/dia = 28
    expect(result.pct).toBe(93); // 26/28 = 92.857... → arredonda para 93
  });

  it('nunca ultrapassa 100% mesmo com soma inflada', () => {
    const result = computeAdherence(999, 4, 7, null);
    expect(result.pct).toBe(100);
  });

  it('sem refeições prescritas (mealsPerDay=0) → pct null, nunca divisão por zero', () => {
    const result = computeAdherence(0, 0, 7, null);
    expect(result.pct).toBeNull();
  });

  it('plano com vida > janela usa a janela inteira (comportamento antigo preservado)', () => {
    const result = computeAdherence(28, 4, 7, 90); // plano de 90 dias
    expect(result.effectiveDays).toBe(7);
    expect(result.pct).toBe(100);
    expect(result.calibrating).toBe(false);
  });

  it(`calibrating é true só abaixo de ${MIN_EFFECTIVE_DAYS_FOR_SIGNAL} dias efetivos`, () => {
    expect(computeAdherence(10, 4, 7, MIN_EFFECTIVE_DAYS_FOR_SIGNAL - 1 - 1).calibrating).toBe(true);
    expect(computeAdherence(10, 4, 7, MIN_EFFECTIVE_DAYS_FOR_SIGNAL - 1).calibrating).toBe(false);
  });
});

describe('P1A.4 · computeTrend — só com janela efetiva suficiente (NUTRI-33)', () => {
  it('null com menos de 14 dias efetivos — não compara 3 dias contra 4', () => {
    expect(computeTrend(50, 90, 7)).toBeNull();
    expect(computeTrend(50, 90, 13)).toBeNull();
  });

  it('com 14+ dias efetivos, delta >= 15pp é "up"', () => {
    expect(computeTrend(50, 70, 14)).toBe('up');
  });

  it('delta <= -15pp é "down"', () => {
    expect(computeTrend(70, 50, 14)).toBe('down');
  });

  it('delta pequeno é "stable"', () => {
    expect(computeTrend(60, 65, 14)).toBe('stable');
  });

  it('null se alguma das metades não tem denominador', () => {
    expect(computeTrend(null, 70, 14)).toBeNull();
  });
});

describe('P1A.4 · computeStreak — definição única (NUTRI-15)', () => {
  const byDay = (entries: Record<string, MealCheckinStatus[]>) => new Map(Object.entries(entries));

  it('hoje sem check-in ainda não zera — conta a partir de ontem', () => {
    const today = '2026-09-05';
    const map = byDay({
      '2026-09-04': ['done'],
      '2026-09-03': ['done'],
      '2026-09-02': ['skipped'],
    });
    expect(computeStreak(map, today)).toBe(2);
  });

  it('done, substituted, partial e delayed contam como presença; skipped quebra', () => {
    const today = '2026-09-05';
    const map = byDay({
      '2026-09-05': ['delayed'],
      '2026-09-04': ['substituted'],
      '2026-09-03': ['partial'],
      '2026-09-02': ['skipped'],
    });
    expect(computeStreak(map, today)).toBe(3);
  });

  it('sem nenhum registro, streak é 0', () => {
    expect(computeStreak(new Map(), '2026-09-05')).toBe(0);
  });

  it('mesmo cálculo serve tanto para o app do aluno quanto para a tela da nutri (contrato único)', () => {
    // Regressão do achado: "13 dias" no app do aluno vs "0 dias" na tela da
    // nutri na mesma manhã. Hoje sem check-in, ontem com 13 dias seguidos.
    const today = '2026-09-05';
    const entries: Record<string, MealCheckinStatus[]> = {};
    for (let i = 1; i <= 13; i++) {
      const d = new Date(Date.UTC(2026, 8, 5 - i));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      entries[key] = ['done'];
    }
    const map = byDay(entries);
    expect(computeStreak(map, today)).toBe(13);
  });
});

describe('P1A.4 · buildCanonicalAdherenceBlock — mesmo número em qualquer viewport (NUTRI-04)', () => {
  it('não depende de quantos dias o CLIENTE pediu — só da janela canônica fixa', () => {
    const checkins14d = [
      { checkDate: '2026-09-05', status: 'done' as MealCheckinStatus },
      { checkDate: '2026-09-04', status: 'done' as MealCheckinStatus },
      { checkDate: '2026-09-03', status: 'done' as MealCheckinStatus },
      { checkDate: '2026-09-02', status: 'partial' as MealCheckinStatus },
      { checkDate: '2026-09-01', status: 'done' as MealCheckinStatus },
      { checkDate: '2026-08-31', status: 'done' as MealCheckinStatus },
      { checkDate: '2026-08-30', status: 'done' as MealCheckinStatus },
    ];
    const block = buildCanonicalAdherenceBlock({
      checkins14d,
      mealsPerDay: 1,
      daysSincePlanStart: 90,
      todayKey: '2026-09-05',
      statusesByDay60d: new Map(checkins14d.map((c) => [c.checkDate, [c.status]])),
    });
    // 6 done (=1) + 1 partial (=0.5) = 6.5 / 7 = 92.86% → 93
    expect(block.adherencePct).toBe(93);
    expect(block.adherenceState).toBe('ready');
  });

  it('calibrando quando o plano é muito novo — nunca 0% arbitrário', () => {
    const block = buildCanonicalAdherenceBlock({
      checkins14d: [
        { checkDate: '2026-09-05', status: 'done' },
        { checkDate: '2026-09-04', status: 'done' },
      ],
      mealsPerDay: 1,
      daysSincePlanStart: 1, // plano de 2 dias
      todayKey: '2026-09-05',
      statusesByDay60d: new Map([
        ['2026-09-05', ['done']],
        ['2026-09-04', ['done']],
      ]),
    });
    expect(block.adherencePct).toBe(100); // proporcional aos 2 dias reais, não 29%
    expect(block.adherenceState).toBe('calibrating');
    expect(block.trend).toBeNull(); // sem sinal suficiente para tendência
  });
});
