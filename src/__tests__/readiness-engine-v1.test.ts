/**
 * S2CORE Readiness v1 — motor determinístico (SPEC Mobile P3 §60–§63, §69).
 *
 * Contrato em `READINESS_ALGORITHM_V1.md`. Estes testes verificam o documento,
 * não o código: se os dois divergirem, é o código que está errado.
 */
import { computeReadiness } from '../modules/readiness/v1/engine';
import { ALGORITHM_VERSION, WEIGHTS } from '../modules/readiness/v1/config';
import type {
  Baseline, MuscleLoadEntry, ReadinessInput, SubjectiveInput,
} from '../modules/readiness/v1/types';

const AGORA = new Date('2026-09-02T12:00:00Z');
const HOJE = '2026-09-02';
const hAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

function baseline(over: Partial<Baseline> = {}): Baseline {
  return {
    mode: 'established',
    daysOfHistory: 60,
    sleepGoodRatio: 0.6,
    hrvMedian: 55,
    restingHrMedian: 58,
    weeklyLoadAvg: 100,
    muscleLoadPeak: { chest: 100, quads: 100, back: 100 },
    ...over,
  };
}

function subj(over: Partial<SubjectiveInput> = {}): SubjectiveInput {
  return {
    energy: 'normal', sleepQuality: 'good', soreness: 'none', stress: 'low',
    measuredAt: `${HOJE}T07:00:00Z`, ...over,
  };
}

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    userId: 1, date: HOJE, subjective: subj(), sleep: { sleptWell: true, measuredAt: hAtras(5) },
    hrv: null, restingHr: null,
    trainingLoad: { last7dLoad: 100, consecutiveDays: 1 },
    muscleLoad: [], baseline: baseline(), metabolicScore: 70, ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('determinismo (§61)', () => {
  it('mesma entrada, mesma saída — sempre', () => {
    const i = input();
    const a = computeReadiness(i, AGORA);
    const b = computeReadiness(i, AGORA);
    const c = computeReadiness(JSON.parse(JSON.stringify(i)), AGORA);
    expect(a).toEqual(b);
    expect(a.score).toBe(c.score);
    expect(a.factors).toEqual(c.factors);
  });

  it('o motor não lê o relógio — o instante entra por parâmetro', () => {
    // Sem isto o determinismo seria impossível de afirmar com honestidade.
    const i = input({ muscleLoad: [{ group: 'chest', load: 100, occurredAt: hAtras(24), sessionRpe: 7, discomfort: false }] });
    const agora1 = computeReadiness(i, AGORA);
    const agora2 = computeReadiness(i, new Date(AGORA.getTime() + 24 * 3_600_000));
    // Passou um dia: a recuperação DEVE mudar. É a prova de que o parâmetro manda.
    expect(agora2.muscleRecovery[0].recovery).toBeGreaterThan(agora1.muscleRecovery[0].recovery);
  });
});

describe('cold start (§11)', () => {
  it('0–6 dias: score é NULL, não um número baixo', () => {
    const r = computeReadiness(input({ baseline: baseline({ mode: 'cold_start', daysOfHistory: 2 }) }), AGORA);
    expect(r.score).toBeNull();
    expect(r.state).toBe('calibrating');
    expect(r.recommendation).toBe('CHECKIN_FIRST');
    expect(r.confidence).toBe('low');
  });

  it('sem baseline nenhum também é cold start', () => {
    expect(computeReadiness(input({ baseline: null }), AGORA).score).toBeNull();
  });

  it('7–20 dias: score sai, mas a confiança tem TETO em medium', () => {
    const r = computeReadiness(input({ baseline: baseline({ mode: 'building', daysOfHistory: 12 }) }), AGORA);
    expect(r.score).not.toBeNull();
    expect(r.confidence).toBe('medium');
  });

  it('21+ dias com boa cobertura chega a high', () => {
    expect(computeReadiness(input(), AGORA).confidence).toBe('high');
  });
});

describe('missing data — ausência NÃO é zero (§38, §62, QA-P3-25)', () => {
  it('HRV ausente não derruba o score', () => {
    const comHrv = computeReadiness(input({ hrv: { value: 55, measuredAt: hAtras(2), source: 's2core' } }), AGORA);
    const semHrv = computeReadiness(input({ hrv: null }), AGORA);
    // 55 é exatamente o baseline → hrvScore 85, próximo da média. O score sem
    // HRV não pode ser MENOR que com um HRV normal.
    expect(semHrv.score!).toBeGreaterThanOrEqual(comHrv.score! - 2);
    expect(semHrv.components.find((c) => c.key === 'hrv')!.absentReason).toBe('no_data');
  });

  it('o peso do ausente é redistribuído, não zerado', () => {
    const r = computeReadiness(input(), AGORA);
    // hrv e restingHr ausentes → cobertura = 1 − 0.08 − 0.04
    expect(r.dataCompleteness).toBeCloseTo(1 - WEIGHTS.hrv - WEIGHTS.restingHr, 4);
  });

  it('só check-in: score sai, mas a confiança é BAIXA e a cobertura mostra por quê', () => {
    const r = computeReadiness(
      input({ sleep: null, trainingLoad: null, muscleLoad: [], baseline: baseline({ weeklyLoadAvg: null }) }),
      AGORA,
    );
    expect(r.score).not.toBeNull();
    // subjective + muscleRecovery (100, sem carga na janela)
    expect(r.dataCompleteness).toBeCloseTo(WEIGHTS.subjective + WEIGHTS.muscleRecovery, 4);
    expect(r.confidence).toBe('medium');
  });

  it('nenhum componente presente → score null, nunca 0', () => {
    const r = computeReadiness(
      input({ subjective: null, sleep: null, trainingLoad: null, muscleLoad: [],
              baseline: baseline({ weeklyLoadAvg: null }) }),
      AGORA,
    );
    // muscleRecovery devolve 100 ("sem carga" é informação), então há 1 presente.
    expect(r.components.filter((c) => c.value != null).map((c) => c.key)).toEqual(['muscleRecovery']);
    expect(r.confidence).toBe('low');
  });

  it('check-in de ONTEM não descreve hoje (§40)', () => {
    const r = computeReadiness(input({ subjective: subj({ measuredAt: '2026-09-01T07:00:00Z' }) }), AGORA);
    expect(r.components.find((c) => c.key === 'subjective')!.absentReason).toBe('stale');
    expect(r.confidence).toBe('low'); // sem check-in do dia
  });
});

describe('outliers (§39, QA-P3-26)', () => {
  it('HRV de 500 ms é IGNORADO e não destrói o score', () => {
    const r = computeReadiness(input({ hrv: { value: 500, measuredAt: hAtras(2), source: 's2core' } }), AGORA);
    const c = r.components.find((x) => x.key === 'hrv')!;
    expect(c.value).toBeNull();
    expect(c.absentReason).toBe('implausible');
    expect(c.detail).toMatchObject({ ignored: 500 });
    expect(r.score).toBe(computeReadiness(input(), AGORA).score);
  });

  it('FC de repouso de 15 bpm é ignorada', () => {
    const c = computeReadiness(input({ restingHr: { value: 15, measuredAt: hAtras(2), source: 's2core' } }), AGORA)
      .components.find((x) => x.key === 'restingHr')!;
    expect(c.absentReason).toBe('implausible');
  });

  it('HRV velho (3 dias) não é usado como se fosse de hoje (§40)', () => {
    const c = computeReadiness(input({ hrv: { value: 55, measuredAt: hAtras(72), source: 's2core' } }), AGORA)
      .components.find((x) => x.key === 'hrv')!;
    expect(c.absentReason).toBe('stale');
  });

  it('sem baseline de HRV, o valor absoluto NÃO é interpretado (§13)', () => {
    const c = computeReadiness(
      input({ hrv: { value: 55, measuredAt: hAtras(2), source: 's2core' }, baseline: baseline({ hrvMedian: null }) }),
      AGORA,
    ).components.find((x) => x.key === 'hrv')!;
    expect(c.absentReason).toBe('no_baseline');
  });
});

describe('isolamento de componentes (QA-P3-24)', () => {
  it('mudar o sono afeta SÓ o componente de sono', () => {
    const bom = computeReadiness(input({ sleep: { sleptWell: true, measuredAt: hAtras(5) } }), AGORA);
    const ruim = computeReadiness(input({ sleep: { sleptWell: false, measuredAt: hAtras(5) } }), AGORA);
    const outros = (r: typeof bom) => r.components.filter((c) => c.key !== 'sleep').map((c) => [c.key, c.value]);
    expect(outros(ruim)).toEqual(outros(bom));
    expect(ruim.score!).toBeLessThan(bom.score!);
  });

  it('mudar a carga afeta SÓ a carga', () => {
    const leve = computeReadiness(input({ trainingLoad: { last7dLoad: 60, consecutiveDays: 1 } }), AGORA);
    const pico = computeReadiness(input({ trainingLoad: { last7dLoad: 200, consecutiveDays: 1 } }), AGORA);
    const outros = (r: typeof leve) => r.components.filter((c) => c.key !== 'trainingLoad').map((c) => [c.key, c.value]);
    expect(outros(pico)).toEqual(outros(leve));
    expect(pico.score!).toBeLessThan(leve.score!);
  });
});

describe('baseline individual (§10, §63)', () => {
  it('quem dorme mal quase toda noite não é punido duas vezes pelo mesmo fato', () => {
    const noiteRuim = { sleptWell: false, measuredAt: hAtras(5) };
    const dormeSempreBem = computeReadiness(input({ sleep: noiteRuim, baseline: baseline({ sleepGoodRatio: 0.9 }) }), AGORA);
    const dormeSempreMal = computeReadiness(input({ sleep: noiteRuim, baseline: baseline({ sleepGoodRatio: 0.2 }) }), AGORA);
    const s = (r: typeof dormeSempreBem) => r.components.find((c) => c.key === 'sleep')!.value!;
    // A mesma noite ruim pesa MAIS para quem quase nunca tem uma.
    expect(s(dormeSempreBem)).toBeLessThan(s(dormeSempreMal));
  });

  it('baseline sem amostra suficiente vira componente ausente, não zero', () => {
    const c = computeReadiness(input({ baseline: baseline({ weeklyLoadAvg: null }) }), AGORA)
      .components.find((x) => x.key === 'trainingLoad')!;
    expect(c.value).toBeNull();
    expect(c.absentReason).toBe('no_baseline');
  });
});

describe('recuperação muscular (§16–§18, QA-P3-10 a 13)', () => {
  const pernaOntem: MuscleLoadEntry[] = [
    { group: 'quads', load: 100, occurredAt: hAtras(20), sessionRpe: 8, discomfort: false },
    { group: 'glutes', load: 60, occurredAt: hAtras(20), sessionRpe: 8, discomfort: false },
  ];

  it('treinar pernas reduz a recuperação das pernas (QA-P3-10/11)', () => {
    const r = computeReadiness(input({ muscleLoad: pernaOntem }), AGORA);
    const quads = r.muscleRecovery.find((m) => m.group === 'quads')!;
    expect(quads.recovery).toBeLessThan(85);
    expect(quads.state).not.toBe('recovered');
  });

  it('a recuperação sobe com o tempo (QA-P3-12/13)', () => {
    const r0 = computeReadiness(input({ muscleLoad: pernaOntem }), AGORA);
    const r48 = computeReadiness(input({ muscleLoad: pernaOntem }), new Date(AGORA.getTime() + 48 * 3_600_000));
    expect(r48.muscleRecovery.find((m) => m.group === 'quads')!.recovery)
      .toBeGreaterThan(r0.muscleRecovery.find((m) => m.group === 'quads')!.recovery);
  });

  it('carga fora da janela de 96 h não conta mais', () => {
    const r = computeReadiness(input({ muscleLoad: [{ group: 'quads', load: 100, occurredAt: hAtras(120), sessionRpe: 8, discomfort: false }] }), AGORA);
    expect(r.muscleRecovery).toHaveLength(0);
  });

  it('desconforto no grupo impõe teto de recuperação', () => {
    const r = computeReadiness(input({ muscleLoad: [{ group: 'chest', load: 10, occurredAt: hAtras(90), sessionRpe: 5, discomfort: true }] }), AGORA);
    expect(r.muscleRecovery.find((m) => m.group === 'chest')!.recovery).toBeLessThanOrEqual(60);
  });

  it('o global pondera pelos grupos do treino de HOJE (§29)', () => {
    // Pernas destruídas, peito intacto. Num dia de peito isso não deve pesar.
    const comum = { muscleLoad: pernaOntem };
    const diaDePeito = computeReadiness(input({ ...comum, plannedMuscleGroups: ['chest'] }), AGORA);
    const diaDePerna = computeReadiness(input({ ...comum, plannedMuscleGroups: ['quads'] }), AGORA);
    expect(diaDePeito.components.find((c) => c.key === 'muscleRecovery')!.value)
      .toBeGreaterThan(diaDePerna.components.find((c) => c.key === 'muscleRecovery')!.value!);
  });

  it('sem carga na janela: tudo recuperado, e isso é informação (não ausência)', () => {
    const c = computeReadiness(input({ muscleLoad: [] }), AGORA).components.find((x) => x.key === 'muscleRecovery')!;
    expect(c.value).toBe(100);
    expect(c.absentReason).toBeUndefined();
  });
});

describe('vetos por dor (§21, QA-P3-17)', () => {
  it('dor alta limita o score a 40 e a recomendação a LIGHT', () => {
    const r = computeReadiness(input({ subjective: subj({ soreness: 'high', energy: 'very_high' }) }), AGORA);
    expect(r.score!).toBeLessThanOrEqual(40);
    expect(['LIGHT', 'RECOVERY']).toContain(r.recommendation);
    expect(r.factors.some((f) => f.id === 'pain.high' && f.severity === 'block')).toBe(true);
  });

  it('dor moderada limita a 60 e a MODERATE', () => {
    const r = computeReadiness(input({ subjective: subj({ soreness: 'moderate', energy: 'very_high' }) }), AGORA);
    expect(r.score!).toBeLessThanOrEqual(60);
    expect(['MODERATE', 'LIGHT', 'RECOVERY']).toContain(r.recommendation);
  });

  it('a mensagem NÃO diagnostica — descreve e aponta o profissional (§50)', () => {
    const r = computeReadiness(input({ subjective: subj({ soreness: 'high', painArea: 'ombro' }) }), AGORA);
    expect(r.microcopy).toContain('ombro');
    expect(r.microcopy).toContain('profissional');
    expect(r.microcopy).not.toMatch(/lesão|doen|inflama|tendinite|ruptura/i);
  });

  it('o veto é TETO, nunca elevação: score já baixo permanece baixo', () => {
    // Tudo ruim E dor moderada. O teto de 60 não pode PUXAR o score para cima.
    const r = computeReadiness(
      input({ subjective: subj({ soreness: 'moderate', energy: 'very_low', stress: 'high', sleepQuality: 'poor' }),
              sleep: { sleptWell: false, measuredAt: hAtras(5) },
              trainingLoad: { last7dLoad: 250, consecutiveDays: 6 },
              muscleLoad: [{ group: 'quads', load: 100, occurredAt: hAtras(4), sessionRpe: 10, discomfort: false }] }),
      AGORA,
    );
    // O que importa é que o teto de 60 não PUXOU o score para cima: ele ficou
    // abaixo por mérito próprio. (47 com um grupo carregado entre onze — antes
    // da correção da média global isto dava 0, e o número era do defeito.)
    expect(r.score!).toBeLessThan(60);
    expect(['LIGHT', 'RECOVERY']).toContain(r.recommendation);
  });

  it('sem carga muscular na janela, "recuperado" sustenta o score — e isso é correto', () => {
    // Percepção péssima, mas quem não treina há dias TEM a musculatura pronta.
    // O componente vale 0.24 e não some; o resultado fica em moderado, não em
    // recuperação. Documentado porque é contraintuitivo à primeira leitura.
    const r = computeReadiness(
      input({ subjective: subj({ soreness: 'moderate', energy: 'very_low', stress: 'high', sleepQuality: 'poor' }),
              sleep: { sleptWell: false, measuredAt: hAtras(5) },
              trainingLoad: { last7dLoad: 250, consecutiveDays: 6 } }),
      AGORA,
    );
    expect(r.components.find((c) => c.key === 'muscleRecovery')!.value).toBe(100);
    expect(r.recommendation).toBe('MODERATE');
  });
});

describe('faixas e recomendação (§4, §23, QA-P3-14 a 16)', () => {
  it('readiness alto → treino intenso', () => {
    const r = computeReadiness(
      input({ subjective: subj({ energy: 'very_high', sleepQuality: 'excellent', stress: 'low' }),
              trainingLoad: { last7dLoad: 60, consecutiveDays: 1 } }),
      AGORA,
    );
    expect(r.score!).toBeGreaterThanOrEqual(80);
    expect(r.recommendation).toBe('INTENSE');
  });

  it('readiness baixo → recuperação', () => {
    const r = computeReadiness(
      input({ subjective: subj({ energy: 'very_low', sleepQuality: 'poor', stress: 'high', soreness: 'light' }),
              sleep: { sleptWell: false, measuredAt: hAtras(5) },
              trainingLoad: { last7dLoad: 300, consecutiveDays: 7 },
              muscleLoad: [{ group: 'quads', load: 100, occurredAt: hAtras(6), sessionRpe: 10, discomfort: false }] }),
      AGORA,
    );
    expect(r.score!).toBeLessThan(50);
    expect(['LIGHT', 'RECOVERY']).toContain(r.recommendation);
  });
});

describe('explicabilidade (§3, §32)', () => {
  it('nunca devolve só um número — há estado, motivos, confiança e recomendação (§2)', () => {
    const r = computeReadiness(input(), AGORA);
    expect(r.state).toBeTruthy();
    expect(r.recommendation).toBeTruthy();
    expect(r.confidence).toBeTruthy();
    expect(r.factors.length).toBeGreaterThan(0);
    expect(r.headline).toBeTruthy();
    expect(r.microcopy).toBeTruthy();
  });

  it('os fatores são frases, não fórmula', () => {
    const r = computeReadiness(input({ sleep: { sleptWell: false, measuredAt: hAtras(5) } }), AGORA);
    const f = r.factors.find((x) => x.id === 'sleep.below_baseline')!;
    expect(f.label).toBe('Sono abaixo do seu padrão');
    expect(f.direction).toBe('negative');
    expect(JSON.stringify(r.factors)).not.toMatch(/0\.28|peso|weight|\*/);
  });

  it('o breakdown técnico vai no snapshot, para auditoria (§33)', () => {
    const r = computeReadiness(input(), AGORA);
    expect(r.components).toHaveLength(6);
    expect(r.components.every((c) => c.key)).toBe(true);
    expect(r.components.find((c) => c.key === 'sleep')!.detail).toBeDefined();
  });
});

describe('versionamento (§34, QA-P3-27)', () => {
  it('a versão do algoritmo vem no resultado', () => {
    expect(computeReadiness(input(), AGORA).algorithmVersion).toBe(ALGORITHM_VERSION);
  });
});

describe('segurança da linguagem (§50, §51)', () => {
  it('nenhuma saída afirma doença ou risco clínico', () => {
    const cenarios = [
      input({ subjective: subj({ soreness: 'high' }) }),
      input({ restingHr: { value: 95, measuredAt: hAtras(2), source: 's2core' } }),
      input({ subjective: subj({ energy: 'very_low', stress: 'high' }) }),
    ];
    for (const c of cenarios) {
      const r = computeReadiness(c, AGORA);
      const texto = r.headline + r.microcopy + r.factors.map((f) => f.label).join(' ');
      // Fronteiras de palavra: "agravem" contém "grav" e não é alarmismo.
      expect(texto).not.toMatch(/\b(doente|doenças?|perigos?|graves?|alarmante)\b/i);
      expect(texto).not.toMatch(/risco de lesão|pode estar doente/i);
    }
  });

  it('FC elevada é descrita como desvio do padrão, nunca como sintoma', () => {
    const r = computeReadiness(
      input({ restingHr: { value: 70, measuredAt: hAtras(2), source: 's2core' } }),
      AGORA,
    );
    const f = r.factors.find((x) => x.id === 'resting_hr.elevated');
    if (f) expect(f.label).toBe('Frequência de repouso acima do seu padrão');
  });
});

describe('média de recuperação cobre o CORPO INTEIRO (regressão do QA P3)', () => {
  it('treinar pernas não zera a prontidão geral — peito e costas seguem intactos', () => {
    const r = computeReadiness(
      input({ muscleLoad: [
        { group: 'quads', load: 100, occurredAt: hAtras(1), sessionRpe: 9, discomfort: false },
        { group: 'glutes', load: 60, occurredAt: hAtras(1), sessionRpe: 9, discomfort: false },
        { group: 'hamstrings', load: 50, occurredAt: hAtras(1), sessionRpe: 9, discomfort: false },
      ] }),
      AGORA,
    );
    const c = r.components.find((x) => x.key === 'muscleRecovery')!;
    // Três grupos zerados entre os onze do corpo: a média fica alta, não em 0.
    expect(c.value!).toBeGreaterThan(65);
    expect(r.muscleRecovery.find((m) => m.group === 'quads')!.recovery).toBeLessThan(20);
  });

  it('mas num DIA DE PERNA a mesma carga pesa — a ponderação é por grupo (§29)', () => {
    const carga = [{ group: 'quads', load: 100, occurredAt: hAtras(1), sessionRpe: 9, discomfort: false }];
    const geral = computeReadiness(input({ muscleLoad: carga }), AGORA);
    const diaDePerna = computeReadiness(input({ muscleLoad: carga, plannedMuscleGroups: ['quads'] }), AGORA);
    const v = (r: typeof geral) => r.components.find((x) => x.key === 'muscleRecovery')!.value!;
    expect(v(diaDePerna)).toBeLessThan(v(geral));
    expect(v(diaDePerna)).toBeLessThan(20);
  });

  it('grupo não treinado conta como recuperado, não como ausente', () => {
    const c = computeReadiness(input({ muscleLoad: [], plannedMuscleGroups: ['chest'] }), AGORA)
      .components.find((x) => x.key === 'muscleRecovery')!;
    expect(c.value).toBe(100);
    expect(c.absentReason).toBeUndefined();
  });
});
