/**
 * Readiness Lens e adaptação de treino — unitários (Spec 033, Onda P6).
 *
 * Estes dois motores decidem o que o aluno vai fazer no ginásio hoje, e até
 * agora não tinham UM teste sequer: nem os doze fatores do Lens, nem os
 * percentuais da adaptação, nem o guard que impede o sistema de aumentar
 * exigência. A única barreira era `assertSafeAdaptation` em tempo de execução —
 * ou seja, o erro só apareceria com um aluno na frente do aparelho.
 */
import {
  computeReadinessLens,
  type ReadinessInput,
} from '../modules/readiness/readiness.engine';
import {
  ADAPTATION_RULES_V1,
  adaptWorkoutDay,
  assertSafeAdaptation,
} from '../modules/training/adaptive/adaptation.transformer';
import { DEFAULT_POLICY } from '../modules/training/adaptive/types';

// ── Readiness ──────────────────────────────────────────────────────────────

/** Aluno sem nenhum sinal ruim. Ponto de partida de todos os casos. */
const NEUTRO: ReadinessInput = {
  metabolicScore: 70,
  metabolismDelta7d: 0,
  feeling: 'neutral',
  sleptWell: true,
  inPain: false,
  stressed: false,
  nutritionLevel: 'ok',
  mentalLoadLevel: 'low',
};

const lens = (over: Partial<ReadinessInput> = {}) => computeReadinessLens({ ...NEUTRO, ...over });
const ids = (over: Partial<ReadinessInput> = {}) => lens(over).factors.map((f) => f.id);

describe('readiness — estado nominal', () => {
  it('sem sinal nenhum, verde com o fator de estado normal', () => {
    const r = lens();
    expect(r.level).toBe('green');
    expect(ids()).toContain('state.nominal');
  });

  it('toda saída tem headline e pelo menos um fator', () => {
    for (const caso of [{}, { inPain: true }, { feeling: 'tired' as const }]) {
      const r = lens(caso);
      expect(r.headline).toBeTruthy();
      expect(r.factors.length).toBeGreaterThan(0);
    }
  });
});

describe('readiness — sinais que levam a vermelho', () => {
  it('dor relatada bloqueia', () => {
    const r = lens({ inPain: true });
    expect(r.level).toBe('red');
    expect(r.factors.find((f) => f.id === 'pain.reported')?.severity).toBe('block');
  });

  it('cansaço somado a noite mal dormida é fadiga composta', () => {
    // Cada um sozinho é amarelo; juntos mudam de patamar. É a combinação que
    // importa, e é justamente o que uma regra por sinal isolado erraria.
    expect(lens({ feeling: 'tired' }).level).toBe('yellow');
    expect(lens({ sleptWell: false }).level).toBe('yellow');
    const r = lens({ feeling: 'tired', sleptWell: false });
    expect(r.level).toBe('red');
    expect(ids({ feeling: 'tired', sleptWell: false })).toContain('fatigue.compound');
  });

  it('a fadiga composta substitui os fatores isolados, não os acumula', () => {
    const f = ids({ feeling: 'tired', sleptWell: false });
    expect(f).not.toContain('sleep.poor');
    expect(f).not.toContain('energy.low');
  });

  it('metabolismo muito baixo e queda acentuada bloqueiam', () => {
    expect(lens({ metabolicScore: 30 }).level).toBe('red');
    expect(lens({ metabolismDelta7d: -20 }).level).toBe('red');
  });
});

describe('readiness — sinais de atenção', () => {
  it.each([
    ['sleep.poor', { sleptWell: false }],
    ['energy.low', { feeling: 'tired' as const }],
    ['mental_load.high', { stressed: true, mentalLoadLevel: 'high' as const }],
    ['metabolic.drop', { metabolismDelta7d: -15 }],
    ['metabolic.moderate_low', { metabolicScore: 40 }],
    ['nutrition.poor', { nutritionLevel: 'poor' as const }],
  ])('%s deixa amarelo', (id, entrada) => {
    const r = lens(entrada as Partial<ReadinessInput>);
    expect(r.level).toBe('yellow');
    expect(r.factors.map((f) => f.id)).toContain(id);
  });

  it('estresse sozinho não basta — precisa vir com carga mental alta', () => {
    expect(lens({ stressed: true }).level).toBe('green');
  });

  it('nutrição boa é informativa e não muda o nível', () => {
    const r = lens({ nutritionLevel: 'good' });
    expect(r.level).toBe('green');
    expect(r.factors.find((f) => f.id === 'nutrition.good')?.severity).toBe('info');
  });
});

describe('readiness — ritmo de carga (o fator que a P3 deixou órfão)', () => {
  it('pico de carga acende atenção', () => {
    const r = lens({ trainingLoadRatio: 1.8 });
    expect(r.level).toBe('yellow');
    expect(r.factors.map((f) => f.id)).toContain('load.spike');
  });

  it('abaixo do limiar não dispara', () => {
    expect(ids({ trainingLoadRatio: 1.5 })).not.toContain('load.spike');
    expect(lens({ trainingLoadRatio: 1.5 }).level).toBe('green');
  });

  it('ausência do dado não inventa fator — é o caso de quem não tem amostra', () => {
    expect(ids({ trainingLoadRatio: null })).not.toContain('load.spike');
    expect(ids({})).not.toContain('load.spike');
  });

  it('valor inválido é ignorado em vez de virar pico', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ids({ trainingLoadRatio: v })).not.toContain('load.spike');
    }
  });

  it('nunca sozinho leva a vermelho: carga alta não é dor nem exaustão', () => {
    expect(lens({ trainingLoadRatio: 99 }).level).toBe('yellow');
  });
});

describe('readiness — ausência de dados não vira afirmação', () => {
  it('todos os sinais subjetivos nulos mantêm verde, sem inventar alerta', () => {
    const r = lens({
      feeling: null,
      sleptWell: null,
      inPain: null,
      stressed: null,
      nutritionLevel: null,
      mentalLoadLevel: null,
    });
    expect(r.level).toBe('green');
    expect(r.factors.map((f) => f.id)).toEqual(['state.nominal']);
  });

  it('delta metabólico nulo não conta como queda', () => {
    expect(ids({ metabolismDelta7d: null })).not.toContain('metabolic.drop');
  });
});

describe('readiness — determinismo', () => {
  it('mesma entrada, mesma saída', () => {
    const entrada = { feeling: 'tired' as const, trainingLoadRatio: 2, metabolicScore: 40 };
    expect(lens(entrada)).toEqual(lens(entrada));
  });

  it('a linguagem nunca é clínica', () => {
    const proibidas = /overtraining|lesã|patolog|síndrome|diagnóst|doen/i;
    for (const caso of [{ inPain: true }, { feeling: 'tired' as const, sleptWell: false }, { trainingLoadRatio: 3 }]) {
      const r = lens(caso as Partial<ReadinessInput>);
      expect(`${r.headline} ${r.microcopy}`).not.toMatch(proibidas);
      for (const f of r.factors) expect(f.label).not.toMatch(proibidas);
    }
  });
});

// ── Adaptação ──────────────────────────────────────────────────────────────

/**
 * Política larga: isola as regras do MOTOR dos tetos do personal.
 *
 * Com o teto padrão (25% de séries) o piso engole a redução extra do vermelho
 * em exercícios de 3 a 6 séries — testado à parte, em "o teto do personal
 * manda". Aqui o teto é aberto de propósito, senão os testes das constantes
 * mediriam o clamp em vez da regra.
 */
const POLICY = {
  ...DEFAULT_POLICY,
  version: 3,
  masterEnabled: true,
  allowVolumeReduction: true,
  allowRestIncrease: true,
  allowIntensityReduction: true,
  maxSetReductionPct: 50,
};

/** Supino 4×10, 80 kg, 90 s, RPE 8 — o exemplo do enunciado da onda. */
const SUPINO = [
  {
    exerciseId: '11111111-1111-4111-8111-111111111111',
    name: 'Supino reto',
    sets: '4',
    reps: '10',
    rest: '90',
    rpe: '8',
  },
];

const adapt = (level: 'green' | 'yellow' | 'red', items = SUPINO, policy = POLICY) =>
  adaptWorkoutDay(items as never, level, policy as never);

describe('adaptação — verde não mexe em nada', () => {
  it('devolve o prescrito, sem mudanças', () => {
    const r = adapt('green');
    expect(r.changes).toEqual([]);
    expect(r.adaptedItems).toEqual(SUPINO);
  });

  it('master desligado também não mexe, mesmo no vermelho', () => {
    const r = adapt('red', SUPINO, { ...POLICY, masterEnabled: false });
    expect(r.changes).toEqual([]);
  });
});

describe('adaptação — números exatos', () => {
  it('amarelo: 4 séries → 3, descanso 90 → 103 s, RPE 8 → 7', () => {
    const [item] = adapt('yellow').adaptedItems;
    expect(item.sets).toBe('3');
    // 90 × 1.15 dá 103,49999… em ponto flutuante, e não 103,5 — arredonda para
    // 103, não 104. O valor "óbvio" no papel não é o que a máquina produz, e é
    // por isso que este teste crava o número em vez de recalculá-lo.
    expect(item.rest).toBe('103s');
    expect(item.rpe).toBe('7');
  });

  it('vermelho: 4 séries → 2, descanso 90 → 117 s, RPE 8 → piso da política', () => {
    const [item] = adapt('red').adaptedItems;
    expect(item.sets).toBe('2');
    // 90 × 1.30 = 117, e o teto de +30% também dá 117 — bate exatamente no limite.
    expect(item.rest).toBe('117s');
    // piso = round(8 × 70/100) = 6
    expect(item.rpe).toBe('6');
  });

  it('os números vêm da constante, não de literais espalhados', () => {
    expect(ADAPTATION_RULES_V1.SETS_REDUCTION).toEqual({ yellow: 1, red: 2 });
    expect(ADAPTATION_RULES_V1.REST_FACTOR).toEqual({ yellow: 1.15, red: 1.3 });
    expect(ADAPTATION_RULES_V1.RPE_STEP_YELLOW).toBe(1);
  });

  it('faixa de repetições colapsa no limite inferior', () => {
    const itens = [{ ...SUPINO[0], reps: '8-12' }];
    expect(adapt('yellow', itens).adaptedItems[0].reps).toBe('8');
  });

  it('técnica avançada é rebaixada', () => {
    const itens = [{ ...SUPINO[0], technique: { type: 'drop_set' } }];
    const r = adapt('yellow', itens as never);
    expect((r.adaptedItems[0] as { technique?: { type: string } }).technique?.type).toBe('none');
  });
});

describe('adaptação — o teto do personal manda', () => {
  it('a redução de séries respeita o piso da política', () => {
    // maxSetReductionPct 25 sobre 4 séries → piso 3: o vermelho não desce a 2.
    const r = adapt('red', SUPINO, { ...POLICY, maxSetReductionPct: 25 });
    expect(r.adaptedItems[0].sets).toBe('3');
  });

  it('o aumento de descanso respeita o teto da política', () => {
    const r = adapt('red', SUPINO, { ...POLICY, maxRestIncreasePct: 10 });
    expect(r.adaptedItems[0].rest).toBe('99s');
  });

  it('com o teto PADRÃO de séries, vermelho e amarelo reduzem igual em 3–6 séries', () => {
    // Achado da onda: `maxSetReductionPct: 25` produz piso = ceil(sets × 0,75),
    // que engole a redução extra do vermelho em toda faixa comum de prescrição.
    // Não é defeito do motor — é o teto do personal fazendo o que promete —,
    // mas significa que a diferença de VOLUME entre os dois estados só aparece
    // a partir de 7 séries. O que separa o vermelho do amarelo na prática é o
    // descanso, o RPE e a sugestão de recuperação.
    const padrao = { ...POLICY, maxSetReductionPct: 25 };
    for (const sets of ['3', '4', '5', '6']) {
      const itens = [{ ...SUPINO[0], sets }];
      expect(adapt('red', itens, padrao).adaptedItems[0].sets).toBe(
        adapt('yellow', itens, padrao).adaptedItems[0].sets,
      );
    }
    // A partir de 8 séries o piso deixa de mandar e a diferença aparece.
    const oito = [{ ...SUPINO[0], sets: '8' }];
    expect(adapt('yellow', oito, padrao).adaptedItems[0].sets).toBe('7');
    expect(adapt('red', oito, padrao).adaptedItems[0].sets).toBe('6');
  });

  it('permissão desligada significa campo intocado', () => {
    const r = adapt('red', SUPINO, { ...POLICY, allowVolumeReduction: false, allowRestIncrease: false });
    expect(r.adaptedItems[0].sets).toBe('4');
    expect(r.adaptedItems[0].rest).toBe('90');
  });
});

describe('adaptação — idempotência', () => {
  it('partir sempre do ORIGINAL dá sempre o mesmo resultado', () => {
    // Esta é a idempotência que importa e a que o produto garante: o aluno
    // recarrega a tela dez vezes e vê o mesmo treino, porque a rota sempre
    // adapta a partir da prescrição do personal.
    const uma = adapt('yellow').adaptedItems;
    for (let i = 0; i < 5; i += 1) {
      expect(adapt('yellow').adaptedItems).toEqual(uma);
    }
  });

  it('encadear adaptação COMPÕE desconto — e é por isso que o original é obrigatório', () => {
    // O motor é uma função pura: ele não sabe se o que recebeu já foi adaptado.
    // Alimentá-lo com a própria saída reduz de novo (4→3→2 séries), que é
    // exatamente o "80 → 72 → 64,8" que não pode chegar ao aluno.
    //
    // O teste crava esse comportamento em vez de escondê-lo: a proteção não
    // está aqui dentro, está em quem chama — e é uma invariante de chamada,
    // não uma propriedade do motor. Se alguém um dia passar o adaptado adiante,
    // este teste explica o que vai acontecer.
    const uma = adapt('yellow').adaptedItems;
    const duas = adapt('yellow', uma as never).adaptedItems;
    expect(uma[0].sets).toBe('3');
    expect(duas[0].sets).toBe('2');
    expect(duas[0].rest).not.toBe(uma[0].rest);
  });

  it('a mesma entrada produz sempre a mesma saída', () => {
    expect(adapt('red')).toEqual(adapt('red'));
  });

  it('o original não é mutado', () => {
    const copia = JSON.parse(JSON.stringify(SUPINO));
    adapt('red');
    expect(SUPINO).toEqual(copia);
  });
});

describe('adaptação — limites', () => {
  it('nunca produz série zero, descanso negativo ou NaN', () => {
    const itens = [{ ...SUPINO[0], sets: '1', rest: '0', rpe: '1' }];
    const [item] = adapt('red', itens).adaptedItems;
    expect(Number(item.sets)).toBeGreaterThanOrEqual(1);
    expect(Number(item.rest)).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Number(item.rpe))).toBe(false);
  });

  it('exercício de peso corporal não ganha carga inventada', () => {
    const itens = [{ exerciseId: 'x', name: 'Flexão', sets: '3', reps: '15', rest: '60' }];
    const [item] = adapt('red', itens as never).adaptedItems;
    // Nenhuma carga externa é inventada para "reduzir intensidade": num
    // exercício de peso corporal, o que sobra é volume e descanso.
    expect(item).not.toHaveProperty('loadKg');
    expect(item.sets).toBe('2');
    expect(item.rest).toBe('78s');
  });

  it('campos ausentes não viram valores fabricados', () => {
    const itens = [{ exerciseId: 'x', name: 'Prancha', sets: '3' }];
    const [item] = adapt('yellow', itens as never).adaptedItems;
    expect(item.rest).toBeUndefined();
    expect(item.rpe).toBeUndefined();
  });
});

describe('guard de segurança — o sistema nunca aumenta exigência', () => {
  it('aceita uma adaptação legítima', () => {
    expect(() => assertSafeAdaptation(SUPINO as never, adapt('red').adaptedItems)).not.toThrow();
  });

  it('recusa mais séries que o prescrito', () => {
    const pior = [{ ...SUPINO[0], sets: '5' }];
    expect(() => assertSafeAdaptation(SUPINO as never, pior as never)).toThrow();
  });

  it('recusa RPE acima do prescrito', () => {
    const pior = [{ ...SUPINO[0], rpe: '9' }];
    expect(() => assertSafeAdaptation(SUPINO as never, pior as never)).toThrow();
  });

  it('recusa descanso menor que o prescrito', () => {
    const pior = [{ ...SUPINO[0], rest: '60' }];
    expect(() => assertSafeAdaptation(SUPINO as never, pior as never)).toThrow();
  });

  it('recusa troca de exercício — substituir é prescrever', () => {
    const outro = [{ ...SUPINO[0], exerciseId: '22222222-2222-4222-8222-222222222222', name: 'Crucifixo' }];
    expect(() => assertSafeAdaptation(SUPINO as never, outro as never)).toThrow();
  });

  it('recusa contagem diferente de exercícios', () => {
    expect(() => assertSafeAdaptation(SUPINO as never, [] as never)).toThrow();
  });
});
