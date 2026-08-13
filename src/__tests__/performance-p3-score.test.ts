/**
 * Progress Score, carga e tendência — Spec 033, Onda P3.
 *
 * O que estes testes protegem, além dos números: as PROPRIEDADES que tornam o
 * score confiável. Um score que despenca com um treino ruim, ou explode com um
 * PR, ou vira NaN com dado faltando, seria pior que não ter score — o aluno
 * aprenderia a ignorá-lo.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import {
  compareFactorWindows,
  computeProgressScore,
  isOnboardingScore,
  type ScoreInput,
} from '../modules/performance/progress.engine';
import { computeLoadReading } from '../modules/performance/trainingLoad.engine';
import { resolveTrend } from '../utils/trend';
import { SCORE_WEIGHTS_V1 } from '../modules/performance/performance.constants';

/** Aluno com histórico suficiente e nada de excepcional acontecendo. */
function baseline(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    accountAgeDays: 120,
    sessionsInLookback: 20,
    daysSinceLastSession: 1,
    keyExercises: { total: 0, improved: 0, regressed: 0 },
    consistencyPct: null,
    tonnageCurrent: null,
    tonnagePrevious: null,
    prCount: 0,
    goalsAchieved: 0,
    ...over,
  };
}

const idsOf = (r: ReturnType<typeof computeProgressScore>) => r.factors.map((f) => f.id);

// ── baseline e estados ──────────────────────────────────────────────────────

describe('P3 · baseline', () => {
  it('sem nada acontecendo, o score fica na base e explica isso', () => {
    const r = computeProgressScore(baseline());
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE);
    expect(r.status).toBe('ok');
    expect(idsOf(r)).toEqual(['steady']);
  });

  it('NUNCA devolve breakdown vazio — é a regra do produto', () => {
    for (const input of [baseline(), baseline({ consistencyPct: 60 }), baseline({ prCount: 0 })]) {
      expect(computeProgressScore(input).factors.length).toBeGreaterThan(0);
    }
  });
});

describe('P3 · dados insuficientes', () => {
  it('conta nova não recebe número', () => {
    const r = computeProgressScore(baseline({ accountAgeDays: 10 }));
    expect(r.value).toBeNull();
    expect(r.status).toBe('onboarding');
    expect(idsOf(r)).toEqual(['onboarding.calibrating']);
  });

  it('conta antiga com poucos treinos também não', () => {
    const r = computeProgressScore(baseline({ accountAgeDays: 400, sessionsInLookback: 3 }));
    expect(r.value).toBeNull();
    expect(r.status).toBe('onboarding');
  });

  it('idade desconhecida é tratada como insuficiente, não como zero', () => {
    expect(isOnboardingScore(baseline({ accountAgeDays: null }))).toBe(true);
  });

  it('na fronteira exata (28 dias, 6 sessões) já pontua', () => {
    const r = computeProgressScore(baseline({ accountAgeDays: 28, sessionsInLookback: 6 }));
    expect(r.status).toBe('ok');
    expect(r.value).not.toBeNull();
  });
});

// ── componentes ─────────────────────────────────────────────────────────────

describe('P3 · progressão de carga', () => {
  it('todos os exercícios em melhora dá o máximo do fator', () => {
    const r = computeProgressScore(baseline({ keyExercises: { total: 4, improved: 4, regressed: 0 } }));
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.PROGRESSION_MAX);
    expect(idsOf(r)).toContain('progression.load');
  });

  it('metade em melhora dá metade do peso, proporcional', () => {
    const r = computeProgressScore(baseline({ keyExercises: { total: 4, improved: 2, regressed: 0 } }));
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE + Math.round(0.5 * SCORE_WEIGHTS_V1.PROGRESSION_MAX));
  });

  it('queda em ≥40% dos exercícios penaliza', () => {
    const r = computeProgressScore(baseline({ keyExercises: { total: 5, improved: 0, regressed: 2 } }));
    expect(idsOf(r)).toContain('progression.regression');
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.REGRESSION_DELTA);
  });

  it('queda abaixo do limiar não penaliza', () => {
    const r = computeProgressScore(baseline({ keyExercises: { total: 10, improved: 0, regressed: 3 } }));
    expect(idsOf(r)).not.toContain('progression.regression');
  });

  it('sem exercício comparável, o fator não participa', () => {
    const r = computeProgressScore(baseline({ keyExercises: { total: 0, improved: 0, regressed: 0 } }));
    expect(idsOf(r)).not.toContain('progression.load');
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE);
  });
});

describe('P3 · consistência', () => {
  it('alta soma, baixa subtrai', () => {
    expect(computeProgressScore(baseline({ consistencyPct: 90 })).value)
      .toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.CONSISTENCY_HIGH_DELTA);
    expect(computeProgressScore(baseline({ consistencyPct: 20 })).value)
      .toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.CONSISTENCY_LOW_DELTA);
  });

  it('faixa do meio não mexe no score', () => {
    const r = computeProgressScore(baseline({ consistencyPct: 60 }));
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE);
  });

  it('NULL (aluno sem ficha) não penaliza — ausência não é falta', () => {
    const semFicha = computeProgressScore(baseline({ consistencyPct: null }));
    expect(semFicha.value).toBe(SCORE_WEIGHTS_V1.BASE);
    expect(idsOf(semFicha)).not.toContain('consistency.low');
  });
});

describe('P3 · volume', () => {
  it('crescimento dentro da banda é proporcional', () => {
    // +15% sobre banda de 30% → metade do peso
    const r = computeProgressScore(baseline({ tonnageCurrent: 11500, tonnagePrevious: 10000 }));
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE + Math.round(0.5 * SCORE_WEIGHTS_V1.VOLUME_MAX));
  });

  it('crescimento SATURA na banda — dobrar o volume não vale o dobro', () => {
    const trintaPct = computeProgressScore(baseline({ tonnageCurrent: 13000, tonnagePrevious: 10000 }));
    const dobrou = computeProgressScore(baseline({ tonnageCurrent: 20000, tonnagePrevious: 10000 }));
    expect(trintaPct.value).toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.VOLUME_MAX);
    expect(dobrou.value).toBe(trintaPct.value);
  });

  it('queda satura igualmente', () => {
    const r = computeProgressScore(baseline({ tonnageCurrent: 1000, tonnagePrevious: 10000 }));
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE - SCORE_WEIGHTS_V1.VOLUME_MAX);
  });

  it('BODYWEIGHT: tonelagem nula nas duas janelas não gera fator nenhum', () => {
    const r = computeProgressScore(baseline({ tonnageCurrent: null, tonnagePrevious: null }));
    expect(idsOf(r)).not.toContain('volume.trend');
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE);
  });

  it('BODYWEIGHT parcial: tonelagem só numa janela não vira queda de 100%', () => {
    const soAtual = computeProgressScore(baseline({ tonnageCurrent: 5000, tonnagePrevious: null }));
    const soAnterior = computeProgressScore(baseline({ tonnageCurrent: null, tonnagePrevious: 5000 }));
    expect(idsOf(soAtual)).not.toContain('volume.trend');
    expect(idsOf(soAnterior)).not.toContain('volume.trend');
    expect(soAtual.value).toBe(SCORE_WEIGHTS_V1.BASE);
    expect(soAnterior.value).toBe(SCORE_WEIGHTS_V1.BASE);
  });

  it('janela anterior ZERO não divide por zero', () => {
    const r = computeProgressScore(baseline({ tonnageCurrent: 5000, tonnagePrevious: 0 }));
    expect(Number.isFinite(r.value as number)).toBe(true);
    expect(idsOf(r)).not.toContain('volume.trend');
  });
});

describe('P3 · recordes e inatividade', () => {
  it('um PR soma o peso fixo', () => {
    expect(computeProgressScore(baseline({ prCount: 1 })).value)
      .toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.PR_RECENT_DELTA);
  });

  it('PR ISOLADO não explode o score — dez recordes valem o mesmo que um', () => {
    const um = computeProgressScore(baseline({ prCount: 1 }));
    const dez = computeProgressScore(baseline({ prCount: 10 }));
    expect(dez.value).toBe(um.value);
    expect((dez.value as number) - SCORE_WEIGHTS_V1.BASE).toBeLessThanOrEqual(6);
  });

  it('inatividade prolongada derruba', () => {
    const r = computeProgressScore(baseline({ daysSinceLastSession: 30 }));
    expect(idsOf(r)).toContain('inactivity');
    expect(r.value).toBe(SCORE_WEIGHTS_V1.BASE + SCORE_WEIGHTS_V1.INACTIVITY_DELTA);
  });

  it('quem treinou ontem não é penalizado', () => {
    expect(idsOf(computeProgressScore(baseline({ daysSinceLastSession: 1 })))).not.toContain('inactivity');
  });

  it('nunca treinou (null) não vira inatividade artificial', () => {
    expect(idsOf(computeProgressScore(baseline({ daysSinceLastSession: null })))).not.toContain('inactivity');
  });

  it('metas somam 0 até a Onda P4 existir', () => {
    expect(idsOf(computeProgressScore(baseline({ goalsAchieved: 0 })))).not.toContain('goal.achieved');
  });
});

// ── estabilidade ────────────────────────────────────────────────────────────

describe('P3 · estabilidade do score', () => {
  it('um treino ruim isolado não move o score — todos os fatores medem JANELA', () => {
    // A diferença entre "treinou ontem" e "treinou hoje" não altera fator nenhum.
    const a = computeProgressScore(baseline({ daysSinceLastSession: 0 }));
    const b = computeProgressScore(baseline({ daysSinceLastSession: 2 }));
    expect(a.value).toBe(b.value);
  });

  it('nenhum fator isolado leva o score a 0 ou 100', () => {
    const soPositivo = computeProgressScore(
      baseline({ keyExercises: { total: 3, improved: 3, regressed: 0 } }));
    const soNegativo = computeProgressScore(baseline({ daysSinceLastSession: 60 }));
    expect(soPositivo.value).toBeLessThan(SCORE_WEIGHTS_V1.MAX);
    expect(soNegativo.value).toBeGreaterThan(SCORE_WEIGHTS_V1.MIN);
  });

  it('o melhor cenário possível não estoura 100 e o pior não fura 0', () => {
    const melhor = computeProgressScore(baseline({
      keyExercises: { total: 5, improved: 5, regressed: 0 },
      consistencyPct: 100, tonnageCurrent: 20000, tonnagePrevious: 10000,
      prCount: 5, goalsAchieved: 3,
    }));
    const pior = computeProgressScore(baseline({
      keyExercises: { total: 5, improved: 0, regressed: 5 },
      consistencyPct: 0, tonnageCurrent: 100, tonnagePrevious: 10000,
      daysSinceLastSession: 90,
    }));
    expect(melhor.value).toBeLessThanOrEqual(100);
    expect(melhor.value).toBeGreaterThanOrEqual(0);
    expect(pior.value).toBeLessThanOrEqual(100);
    expect(pior.value).toBeGreaterThanOrEqual(0);
  });
});

// ── propriedades / invariantes ──────────────────────────────────────────────

describe('P3 · invariantes de propriedade', () => {
  /** Gera entradas variadas, inclusive absurdas, de forma determinística. */
  function* casos(): Generator<ScoreInput> {
    const nums = [null, 0, 1, -1, 0.5, 42, 1e6, 1e12, Number.MAX_SAFE_INTEGER];
    const pcts = [null, 0, 39, 40, 85, 100, 150, -20];
    for (const t of nums) {
      for (const p of pcts) {
        yield baseline({
          tonnageCurrent: t as number | null,
          tonnagePrevious: t as number | null,
          consistencyPct: p,
          keyExercises: { total: 3, improved: 2, regressed: 1 },
          prCount: 2,
          daysSinceLastSession: 5,
        });
      }
    }
  }

  it('0 <= score <= 100 para toda entrada válida', () => {
    for (const c of casos()) {
      const v = computeProgressScore(c).value;
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('o score é sempre INTEIRO — nada de 82.374 na tela', () => {
    for (const c of casos()) {
      const v = computeProgressScore(c).value;
      if (v !== null) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('nenhuma entrada produz NaN ou Infinity', () => {
    const venenos = [NaN, Infinity, -Infinity];
    for (const p of venenos) {
      const r = computeProgressScore(baseline({
        tonnageCurrent: p, tonnagePrevious: p, consistencyPct: p,
        daysSinceLastSession: p, accountAgeDays: 120, sessionsInLookback: 20,
      }));
      expect(Number.isFinite(r.value as number)).toBe(true);
      for (const f of r.factors) expect(Number.isFinite(f.delta)).toBe(true);
    }
  });

  it('valores negativos não quebram nem invertem a lógica', () => {
    const r = computeProgressScore(baseline({
      tonnageCurrent: -500, tonnagePrevious: -1000, consistencyPct: -50,
    }));
    expect(Number.isFinite(r.value as number)).toBe(true);
    expect(r.value).toBeGreaterThanOrEqual(0);
  });

  it('é determinística: mesma entrada, mesma saída', () => {
    for (const c of casos()) {
      expect(computeProgressScore(c)).toEqual(computeProgressScore(c));
    }
  });

  it('todo delta é inteiro', () => {
    for (const c of casos()) {
      for (const f of computeProgressScore(c).factors) {
        expect(Number.isInteger(f.delta)).toBe(true);
      }
    }
  });
});

// ── explicabilidade ─────────────────────────────────────────────────────────

describe('P3 · o que mudou (explicação determinística)', () => {
  it('fator que apareceu entra com o delta cheio', () => {
    const antes = computeProgressScore(baseline()).factors;
    const agora = computeProgressScore(baseline({ prCount: 1 })).factors;
    const mudou = compareFactorWindows(agora, antes);
    expect(mudou.find((m) => m.id === 'pr.recent')?.delta).toBe(SCORE_WEIGHTS_V1.PR_RECENT_DELTA);
  });

  it('fator que SUMIU aparece com sinal invertido — sair da inatividade é notícia boa', () => {
    const antes = computeProgressScore(baseline({ daysSinceLastSession: 40 })).factors;
    const agora = computeProgressScore(baseline({ daysSinceLastSession: 1 })).factors;
    const mudou = compareFactorWindows(agora, antes);
    const inatividade = mudou.find((m) => m.id === 'inactivity');
    expect(inatividade?.delta).toBe(-SCORE_WEIGHTS_V1.INACTIVITY_DELTA);
    expect(inatividade!.delta).toBeGreaterThan(0);
  });

  it('sem mudança, não inventa explicação', () => {
    const f = computeProgressScore(baseline({ consistencyPct: 90 })).factors;
    expect(compareFactorWindows(f, f)).toEqual([]);
  });

  it('ordena pelo maior movimento — é o que explica melhor', () => {
    const antes = computeProgressScore(baseline()).factors;
    const agora = computeProgressScore(baseline({
      prCount: 1, keyExercises: { total: 4, improved: 4, regressed: 0 },
    })).factors;
    const mudou = compareFactorWindows(agora, antes);
    expect(Math.abs(mudou[0].delta)).toBeGreaterThanOrEqual(Math.abs(mudou[1].delta));
  });

  it('ignora os fatores de moldura (calibrando / sem mudança)', () => {
    const onboarding = computeProgressScore(baseline({ accountAgeDays: 5 })).factors;
    const normal = computeProgressScore(baseline()).factors;
    expect(compareFactorWindows(normal, onboarding)).toEqual([]);
  });
});

// ── carga ───────────────────────────────────────────────────────────────────

describe('P3 · ritmo de carga', () => {
  it('amostra pequena não vira faixa — não há padrão a comparar', () => {
    const r = computeLoadReading({ sum7d: 400, sum28d: 800, sessionsWithLoad28d: 3 });
    expect(r.ratioBand).toBeNull();
    expect(r.ratio).toBeNull();
    expect(r.effortLoad7d).toBe(400);
  });

  it('ritmo igual ao padrão fica "dentro"', () => {
    // 7d = 1/4 de 28d → médias diárias iguais → razão 1
    const r = computeLoadReading({ sum7d: 250, sum28d: 1000, sessionsWithLoad28d: 12 });
    expect(r.ratio).toBe(1);
    expect(r.ratioBand).toBe('within');
  });

  it('classifica abaixo, acima e pico', () => {
    const abaixo = computeLoadReading({ sum7d: 100, sum28d: 1000, sessionsWithLoad28d: 12 });
    const acima = computeLoadReading({ sum7d: 350, sum28d: 1000, sessionsWithLoad28d: 12 });
    const pico = computeLoadReading({ sum7d: 450, sum28d: 1000, sessionsWithLoad28d: 12 });
    expect(abaixo.ratioBand).toBe('below');
    expect(acima.ratioBand).toBe('above');
    expect(pico.ratioBand).toBe('spike');
  });

  it('28 dias sem carga não divide por zero', () => {
    const r = computeLoadReading({ sum7d: 100, sum28d: 0, sessionsWithLoad28d: 12 });
    expect(r.ratioBand).toBeNull();
    expect(r.ratio).toBeNull();
  });

  it('NULL e valores venenosos não viram faixa', () => {
    for (const v of [null, NaN, Infinity]) {
      const r = computeLoadReading({ sum7d: v as number, sum28d: 1000, sessionsWithLoad28d: 12 });
      expect(r.ratioBand).toBeNull();
    }
  });
});

// ── tendência ───────────────────────────────────────────────────────────────

describe('P3 · tendência', () => {
  it('série curta é estável — não se afirma direção com 4 pontos', () => {
    expect(resolveTrend([50, 60, 70, 80])).toBe('stable');
  });

  it('subida sustentada é up; queda é down', () => {
    expect(resolveTrend([50, 53, 56, 59, 62, 65])).toBe('up');
    expect(resolveTrend([65, 62, 59, 56, 53, 50])).toBe('down');
  });

  it('oscilação sem direção continua estável', () => {
    expect(resolveTrend([50, 52, 49, 51, 50, 51])).toBe('stable');
  });

  it('dia sem score é ausência, não zero — não derruba a tendência', () => {
    expect(resolveTrend([60, null, 61, null, 62, 63, 64])).toBe('up');
  });

  it('não devolve direção a partir de lixo', () => {
    expect(resolveTrend([NaN, Infinity, null, undefined])).toBe('stable');
  });
});
