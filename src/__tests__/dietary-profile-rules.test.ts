/**
 * Matcher clínico do Perfil Nutricional (SPEC 035 / P1A.6).
 *
 * Módulo puro (`dietaryProfileRules.ts`), sem banco. Casos exigidos pela
 * SPEC 035 §23: plural, acento, caixa, pontuação, negação, composto,
 * singular, plural irregular.
 */
import { normalizeText, consolidate, evaluateConflicts, type RawProfileRow } from '../services/dietaryProfileRules';

function profileWith(rows: Partial<RawProfileRow>[]) {
  const full: RawProfileRow[] = rows.map((r, i) => ({
    id: i + 1,
    kind: 'allergy',
    severity: 'severe',
    preference_kind: null,
    label: 'Item',
    code: null,
    match_terms: null,
    notes: null,
    ...r,
  }));
  return consolidate(1, full, new Date().toISOString());
}

function hasConflict(profile: ReturnType<typeof profileWith>, text: string): boolean {
  return evaluateConflicts(profile, text).length > 0;
}

describe('P1A.6 · plural PT-BR (NUTRI-06)', () => {
  const cases: Array<[string, string, string]> = [
    ['ovo', '2 ovos cozidos', 'plural regular'],
    ['ovo', 'omelete de 3 ovos', 'plural no meio da frase'],
    ['queijo', 'queijos variados', 'plural regular'],
    ['iogurte', 'iogurtes naturais', 'plural regular'],
    ['castanha', 'castanhas do pará', 'plural regular'],
    ['peixe', 'peixes grelhados', 'plural regular'],
    ['pao', 'pães integrais', 'plural irregular ão→ães'],
    ['cogumelo', 'cogumelos salteados', 'plural regular'],
  ];

  for (const [term, text, desc] of cases) {
    it(`"${term}" casa com "${text}" (${desc})`, () => {
      const profile = profileWith([{ label: 'Item', match_terms: term }]);
      expect(hasConflict(profile, text)).toBe(true);
    });
  }

  it('singular continua casando (não regrediu)', () => {
    const profile = profileWith([{ label: 'Ovo', match_terms: 'ovo' }]);
    expect(hasConflict(profile, '1 ovo cozido')).toBe(true);
  });

  it('não casa palavra parecida ("novo" não é "ovo") — fronteira de palavra preservada', () => {
    const profile = profileWith([{ label: 'Ovo', match_terms: 'ovo' }]);
    expect(hasConflict(profile, 'Prato novo do cardápio')).toBe(false);
  });
});

describe('P1A.6 · acento, caixa e pontuação', () => {
  it('normalizeText remove acento e baixa a caixa', () => {
    expect(normalizeText('Pão de Açúcar com Amêndoas')).toBe('pao de acucar com amendoas');
  });

  it('casa termo em CAIXA ALTA', () => {
    const profile = profileWith([{ label: 'Leite', match_terms: 'leite' }]);
    expect(hasConflict(profile, 'LEITE INTEGRAL')).toBe(true);
  });

  it('casa termo seguido de pontuação', () => {
    const profile = profileWith([{ label: 'Leite', match_terms: 'leite' }]);
    expect(hasConflict(profile, 'Contém leite.')).toBe(true);
  });
});

describe('P1A.6 · negação (NUTRI-21)', () => {
  const milkProfile = () => profileWith([{ label: 'Leite', match_terms: 'leite,lactose' }]);
  const sugarProfile = () => profileWith([{ kind: 'clinical_condition', severity: null, label: 'Diabetes', match_terms: 'acucar' }]);
  const glutenProfile = () => profileWith([{ kind: 'intolerance', severity: 'severe', label: 'Glúten', match_terms: 'gluten' }]);

  it('"sem lactose" não alerta', () => {
    expect(hasConflict(milkProfile(), 'Iogurte sem lactose')).toBe(false);
  });

  it('"zero açúcar" não alerta', () => {
    expect(hasConflict(sugarProfile(), 'Refrigerante zero açúcar')).toBe(false);
  });

  it('"sem adição de açúcar" (marcador + 2 palavras) não alerta', () => {
    expect(hasConflict(sugarProfile(), 'Suco sem adição de açúcar')).toBe(false);
  });

  it('"isento de lactose" não alerta', () => {
    expect(hasConflict(milkProfile(), 'Bebida isenta de lactose')).toBe(false);
  });

  it('"pão sem glúten" não alerta', () => {
    expect(hasConflict(glutenProfile(), 'Pão sem glúten')).toBe(false);
  });

  it('negação não suprime OUTRA ocorrência genuína do mesmo termo no texto', () => {
    expect(hasConflict(milkProfile(), 'Molho sem lactose, servido com queijo e leite integral')).toBe(true);
  });
});

describe('P1A.6 · composto nominal (NUTRI-21)', () => {
  const milkProfile = () => profileWith([{ label: 'Leite', match_terms: 'leite,lactose,manteiga' }]);
  const veganProfile = () => profileWith([{ kind: 'restriction', severity: null, label: 'Vegano', match_terms: 'carne' }]);

  it('"leite de coco" não alerta alergia a leite', () => {
    expect(hasConflict(milkProfile(), 'Curry com leite de coco')).toBe(false);
  });

  it('"leite de amêndoas" não alerta', () => {
    expect(hasConflict(milkProfile(), 'Vitamina de leite de amêndoas')).toBe(false);
  });

  it('"bebida vegetal sem lactose" não alerta (negação, não composto — caso real da P0)', () => {
    expect(hasConflict(milkProfile(), 'Bebida vegetal sem lactose zero açúcar')).toBe(false);
  });

  it('"manteiga de amendoim" não alerta alergia a leite', () => {
    expect(hasConflict(milkProfile(), 'Pasta de manteiga de amendoim')).toBe(false);
  });

  it('"carne de soja" não viola restrição vegana', () => {
    expect(hasConflict(veganProfile(), 'Estrogonofe de carne de soja')).toBe(false);
  });

  it('"leite integral" (sem composto) continua alertando', () => {
    expect(hasConflict(milkProfile(), 'Café com leite integral')).toBe(true);
  });

  it('"carne bovina" (sem composto) continua violando restrição vegana', () => {
    expect(hasConflict(veganProfile(), 'Carne bovina grelhada')).toBe(true);
  });
});

describe('P1A.6 · classificação de alerta permanece inalterada (regressão)', () => {
  it('alergia é sempre "strong"', () => {
    const profile = profileWith([{ kind: 'allergy', severity: 'mild', label: 'Ovo', match_terms: 'ovo' }]);
    expect(evaluateConflicts(profile, 'omelete')[0]).toBeUndefined(); // "omelete" não casa termo "ovo"
    expect(evaluateConflicts(profile, '2 ovos')[0]?.level).toBe('strong');
  });

  it('preferência "like" nunca gera conflito', () => {
    const profile = profileWith([{ kind: 'preference', preference_kind: 'like', label: 'Frango', match_terms: 'frango' }]);
    expect(hasConflict(profile, 'Frango grelhado')).toBe(false);
  });
});
