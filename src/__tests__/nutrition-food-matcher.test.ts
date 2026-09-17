/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B corrective) — corpus de matching contra o
 * catálogo TACO REAL (582 itens, `src/seeds/tacoFoods.snapshot.json`), não
 * um catálogo sintético — os thresholds em `nutritionFoodMatcher.ts` foram
 * calibrados observando exatamente estes scores (PLAN §20/§23).
 *
 * Categorias do corpus: EXACT, NORMALIZAÇÃO, TYPOS, ALIASES, AMBÍGUOS,
 * NEGATIVOS, FALSOS POSITIVOS (§21/§22) — métricas de
 * autoResolvedCorrect/suggestedCorrect/unresolvedCorrect/falsePositive no
 * describe final.
 */
import fs from 'fs';
import path from 'path';
import {
  buildFoodIndex,
  matchFood,
  normalizeFoodText,
  FUZZY_HIGH_CONFIDENCE,
  FUZZY_MEDIUM_CONFIDENCE,
  FUZZY_MINIMUM_SCORE,
  type FoodIndexEntry,
} from '../services/nutritionFoodMatcher';

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../seeds/tacoFoods.snapshot.json'), 'utf8'),
) as Array<{ name: string; normalizedName: string }>;

let index: FoodIndexEntry[];

beforeAll(() => {
  const foods = raw.map((f, i) => ({ id: i + 1, name: f.name, normalizedName: f.normalizedName }));
  index = buildFoodIndex(foods);
});

describe('nutritionFoodMatcher — corpus real (582 itens TACO)', () => {
  it('sanity: catálogo carregado tem os itens esperados', () => {
    expect(index.length).toBe(582);
    expect(index.some((e) => e.normalizedName === 'pao trigo frances')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // O caso que originou a correção (PLAN §21) — teste de regressão obrigatório.
  // -------------------------------------------------------------------------
  describe('regressão — "pão francês" (o bug relatado)', () => {
    it.each(['pão francês', 'pao frances', 'pão françes', 'pao francez', 'PÃO FRANCÊS', 'PAO FRANCES', 'pao frnces'])(
      '"%s" resolve para Pão, trigo, francês (nunca unresolved, nunca 0 kcal)',
      (input) => {
        const r = matchFood(input, index);
        expect(r.resolved).toBe(true);
        expect(r.entry?.name).toBe('Pão, trigo, francês');
      },
    );
  });

  // -------------------------------------------------------------------------
  // EXACT
  // -------------------------------------------------------------------------
  describe('EXACT', () => {
    it('"arroz tipo 1 cozido" bate exato', () => {
      const r = matchFood('arroz tipo 1 cozido', index);
      expect(r).toMatchObject({ resolved: true, resolver: 'exact', confidence: 'high' });
      expect(r.entry?.name).toBe('Arroz, tipo 1, cozido');
    });

    it('"feijao carioca cozido" bate exato', () => {
      const r = matchFood('feijao carioca cozido', index);
      expect(r).toMatchObject({ resolved: true, resolver: 'exact', confidence: 'high' });
    });
  });

  // -------------------------------------------------------------------------
  // ALIASES — bare word ambíguo no TACO (só existe com qualificador) resolve
  // para o tipo mais comum, o mesmo que já tem medida caseira curada.
  // -------------------------------------------------------------------------
  describe('ALIASES', () => {
    const cases: Array<[string, string]> = [
      ['arroz', 'Arroz, tipo 1, cozido'],
      ['banana', 'Banana, prata, crua'],
      ['ovo', 'Ovo, de galinha, inteiro, cru'],
      ['frango', 'Frango, peito, sem pele, grelhado'],
      ['feijao', 'Feijão, carioca, cozido'],
      ['macaxeira', 'Mandioca, cozida'],
      ['aipim', 'Mandioca, cozida'],
      ['paozinho', 'Pão, trigo, francês'],
      ['pao de sal', 'Pão, trigo, francês'],
    ];
    it.each(cases)('"%s" resolve por alias para "%s"', (input, expectedName) => {
      const r = matchFood(input, index);
      expect(r).toMatchObject({ resolved: true, resolver: 'alias', confidence: 'high', score: 1 });
      expect(r.entry?.name).toBe(expectedName);
    });
  });

  // -------------------------------------------------------------------------
  // NEGATIVOS
  // -------------------------------------------------------------------------
  describe('NEGATIVOS', () => {
    it.each(['xyzabc', 'qualquercoisainexistente', 'blablabla123'])('"%s" não resolve (unresolved)', (input) => {
      const r = matchFood(input, index);
      expect(r.resolved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // FALSOS POSITIVOS (§22) — nunca resolver com HIGH confidence quando existe
  // ambiguidade real (tipo de pão, cru vs preparado, etc). Confirmação
  // (medium/low) é aceitável; auto-resolução silenciosa não.
  // -------------------------------------------------------------------------
  describe('falsos positivos — ambiguidade nunca vira HIGH sem margem clara', () => {
    it('"ovo" (bare, via alias) NUNCA vira "ovo de codorna"', () => {
      const r = matchFood('ovo', index);
      expect(r.entry?.name).not.toBe('Ovo, de codorna, inteiro, cru');
    });

    it('"leite" bare (sem alias, múltiplos candidatos empatados) não é HIGH', () => {
      const r = matchFood('leite', index);
      if (r.resolved) expect(r.confidence).not.toBe('high');
    });

    it('"queijo" bare (sem alias, múltiplos candidatos empatados) não é HIGH', () => {
      const r = matchFood('queijo', index);
      if (r.resolved) expect(r.confidence).not.toBe('high');
    });

    it('"pao" bare isolado (sem qualificador) não é HIGH — ambíguo entre vários pães', () => {
      const r = matchFood('pao', index);
      if (r.resolved) expect(r.confidence).not.toBe('high');
    });

    it('candidatos empatados (mesmo score) nunca saem como HIGH — margem insuficiente', () => {
      // Constrói cenário sintético controlado: dois candidatos idênticos em
      // score não podem produzir HIGH mesmo que o score bruto seja alto.
      const synthetic = buildFoodIndex([
        { id: 1, name: 'Peixe, tilápia, grelhado', normalizedName: 'peixe tilapia grelhado' },
        { id: 2, name: 'Peixe, tilápia, assado', normalizedName: 'peixe tilapia assado' },
      ]);
      const r = matchFood('peixe tilapia', synthetic);
      expect(r.confidence).not.toBe('high');
    });
  });

  // -------------------------------------------------------------------------
  // AMBÍGUOS — devem pedir confirmação (medium/low), nunca ficar unresolved
  // quando há candidato plausível, nem virar HIGH.
  // -------------------------------------------------------------------------
  describe('AMBÍGUOS — pedem confirmação', () => {
    it.each(['leite integral', 'frango cru', 'arroz cru'])('"%s" resolve com confiança < high (pede confirmação)', (input) => {
      const r = matchFood(input, index);
      expect(r.resolved).toBe(true);
      expect(r.confidence).not.toBe('high');
    });
  });

  // -------------------------------------------------------------------------
  // Thresholds fazem sentido entre si (contrato de configuração, não de dado)
  // -------------------------------------------------------------------------
  it('thresholds centralizados estão em ordem crescente coerente', () => {
    expect(FUZZY_MINIMUM_SCORE).toBeLessThan(FUZZY_MEDIUM_CONFIDENCE);
    expect(FUZZY_MEDIUM_CONFIDENCE).toBeLessThan(FUZZY_HIGH_CONFIDENCE);
  });

  // -------------------------------------------------------------------------
  // Métricas do corpus completo (§23) — falsePositive é a métrica prioritária.
  // -------------------------------------------------------------------------
  describe('métricas agregadas do corpus', () => {
    const CORPUS: Array<{ input: string; expectedName?: string; expectUnresolved?: boolean }> = [
      { input: 'arroz', expectedName: 'Arroz, tipo 1, cozido' },
      { input: 'banana', expectedName: 'Banana, prata, crua' },
      { input: 'ovo', expectedName: 'Ovo, de galinha, inteiro, cru' },
      { input: 'PÃO FRANCÊS', expectedName: 'Pão, trigo, francês' },
      { input: 'pão francês', expectedName: 'Pão, trigo, francês' },
      { input: 'PAO FRANCES', expectedName: 'Pão, trigo, francês' },
      { input: 'pão françes', expectedName: 'Pão, trigo, francês' },
      { input: 'pao francez', expectedName: 'Pão, trigo, francês' },
      { input: 'pao frnces', expectedName: 'Pão, trigo, francês' },
      { input: 'arroz tipo 1 cozido', expectedName: 'Arroz, tipo 1, cozido' },
      { input: 'feijao carioca cozido', expectedName: 'Feijão, carioca, cozido' },
      { input: 'macaxeira', expectedName: 'Mandioca, cozida' },
      { input: 'aipim', expectedName: 'Mandioca, cozida' },
      { input: 'paozinho', expectedName: 'Pão, trigo, francês' },
      { input: 'xyzabc', expectUnresolved: true },
      { input: 'qualquercoisainexistente', expectUnresolved: true },
    ];

    it('produz zero falso-positivo no corpus (nome resolvido nunca diverge do esperado)', () => {
      let autoResolvedCorrect = 0;
      let suggestedCorrect = 0;
      let unresolvedCorrect = 0;
      let falsePositive = 0;

      for (const c of CORPUS) {
        const r = matchFood(c.input, index);
        if (c.expectUnresolved) {
          if (!r.resolved) unresolvedCorrect++;
          else falsePositive++;
          continue;
        }
        if (!r.resolved || r.entry?.name !== c.expectedName) {
          falsePositive++;
          continue;
        }
        if (r.confidence === 'high') autoResolvedCorrect++;
        else suggestedCorrect++;
      }

      expect(falsePositive).toBe(0);
      expect(autoResolvedCorrect + suggestedCorrect + unresolvedCorrect).toBe(CORPUS.length);
      expect(autoResolvedCorrect).toBeGreaterThan(0);
    });
  });

  describe('normalizeFoodText', () => {
    it('remove acentos, uppercase, pontuação e espaços duplicados', () => {
      expect(normalizeFoodText('  Pão   Francês! ')).toBe('pao frances');
      expect(normalizeFoodText('PÃO FRANCÊS')).toBe('pao frances');
    });
  });
});
