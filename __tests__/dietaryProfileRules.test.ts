/**
 * Testes das regras de domínio do Perfil Clínico-Nutricional (Onda B).
 * Módulo puro — fonte única de interpretação. Sem DB, sem mocks.
 */

import {
  normalizeText,
  termMatches,
  parseTerms,
  alertLevelFor,
  consolidate,
  evaluateConflicts,
  swapHintFor,
  type RawProfileRow,
} from '../src/services/dietaryProfileRules';

const AT = '2026-06-28T00:00:00.000Z';

function row(p: Partial<RawProfileRow> & Pick<RawProfileRow, 'kind'>): RawProfileRow {
  return {
    id: p.id ?? Math.floor(Math.random() * 1e6),
    kind: p.kind,
    severity: p.severity ?? null,
    preference_kind: p.preference_kind ?? null,
    label: p.label ?? 'X',
    code: p.code ?? null,
    match_terms: p.match_terms ?? null,
    notes: p.notes ?? null,
  };
}

describe('normalizeText', () => {
  it('lowercases e remove acentos', () => {
    expect(normalizeText('Leite com Açúcar e Pãozinho')).toBe('leite com acucar e paozinho');
  });
  it('trim', () => {
    expect(normalizeText('  Frango  ')).toBe('frango');
  });
});

describe('termMatches (fronteira de palavra)', () => {
  const hay = (s: string) => normalizeText(s);
  it('casa palavra inteira', () => {
    expect(termMatches(hay('vitamina de whey'), 'whey')).toBe(true);
    expect(termMatches(hay('omelete de ovo'), 'ovo')).toBe(true);
  });
  it('NÃO casa substring (sal em salada, ovo em novo)', () => {
    expect(termMatches(hay('salada de alface'), 'sal')).toBe(false);
    expect(termMatches(hay('bolo novo'), 'ovo')).toBe(false);
  });
  it('casa termo multi-palavra', () => {
    expect(termMatches(hay('creme de leite fresco'), 'creme de leite')).toBe(true);
  });
});

describe('parseTerms', () => {
  it('normaliza, separa por vírgula e descarta vazios (mantém ≥ 3 chars)', () => {
    expect(parseTerms('Leite, Sal, lactose, ')).toEqual(['leite', 'sal', 'lactose']);
  });
  it('descarta termos com menos de 3 caracteres', () => {
    expect(parseTerms('ab, oi, leite')).toEqual(['leite']);
  });
  it('mantém "sal" (3 chars) mas descarta vazios', () => {
    expect(parseTerms('sal,sodio,,')).toEqual(['sal', 'sodio']);
  });
  it('null vira lista vazia', () => {
    expect(parseTerms(null)).toEqual([]);
  });
});

describe('alertLevelFor', () => {
  it('alergia sempre forte', () => {
    expect(alertLevelFor('allergy', 'mild', null)).toBe('strong');
    expect(alertLevelFor('allergy', 'severe', null)).toBe('strong');
  });
  it('intolerância moderada, severe vira forte', () => {
    expect(alertLevelFor('intolerance', 'moderate', null)).toBe('moderate');
    expect(alertLevelFor('intolerance', 'severe', null)).toBe('strong');
  });
  it('restrição/condição/medicamento = info', () => {
    expect(alertLevelFor('restriction', null, null)).toBe('info');
    expect(alertLevelFor('clinical_condition', null, null)).toBe('info');
    expect(alertLevelFor('medication', null, null)).toBe('info');
  });
  it('preferência: avoid=sugestão, like=null', () => {
    expect(alertLevelFor('preference', null, 'avoid')).toBe('suggestion');
    expect(alertLevelFor('preference', null, 'like')).toBeNull();
  });
});

describe('consolidate', () => {
  const rows: RawProfileRow[] = [
    row({ kind: 'allergy', code: 'milk', label: 'Leite', severity: 'severe', match_terms: 'leite,whey,queijo' }),
    row({ kind: 'restriction', code: 'vegan', label: 'Vegano', match_terms: 'carne,frango,ovo' }),
    row({ kind: 'preference', code: 'coriander', label: 'Coentro', preference_kind: 'avoid', match_terms: 'coentro' }),
    row({ kind: 'preference', code: 'banana', label: 'Banana', preference_kind: 'like', match_terms: 'banana' }),
    row({ kind: 'medication', code: 'warfarin', label: 'Varfarina', match_terms: 'couve' }),
  ];
  const p = consolidate(42, rows, AT);

  it('agrupa por kind e preserva userId/generatedAt', () => {
    expect(p.userId).toBe(42);
    expect(p.generatedAt).toBe(AT);
    expect(p.byKind.allergy).toHaveLength(1);
    expect(p.byKind.restriction).toHaveLength(1);
    expect(p.byKind.preference).toHaveLength(2);
    expect(p.entries).toHaveLength(5);
  });
  it('preferência "like" não gera avoidTerms', () => {
    const banana = p.entries.find((e) => e.code === 'banana')!;
    expect(banana.avoidTerms).toEqual([]);
    const coentro = p.entries.find((e) => e.code === 'coriander')!;
    expect(coentro.avoidTerms).toEqual(['coentro']);
  });
  it('deriva flags corretamente', () => {
    expect(p.flags.hasSevereAllergy).toBe(true);
    expect(p.flags.isVegan).toBe(true);
    expect(p.flags.isVegetarian).toBe(true);     // vegan implica vegetariano
    expect(p.flags.isLactoseFree).toBe(true);     // alergia a leite
    expect(p.flags.isGlutenFree).toBe(false);
    expect(p.flags.hasMedications).toBe(true);
    expect(p.flags.total).toBe(5);
  });
});

describe('evaluateConflicts', () => {
  const rows: RawProfileRow[] = [
    row({ kind: 'allergy', code: 'milk', label: 'Leite', severity: 'severe', match_terms: 'leite,whey,iogurte' }),
    row({ kind: 'intolerance', code: 'lactose', label: 'Lactose', severity: 'moderate', match_terms: 'leite,iogurte' }),
    row({ kind: 'restriction', code: 'vegan', label: 'Vegano', match_terms: 'carne,frango,ovo' }),
    row({ kind: 'clinical_condition', code: 'hypertension', label: 'Hipertensão', match_terms: 'sal,sodio' }),
    row({ kind: 'preference', code: 'coriander', label: 'Coentro', preference_kind: 'avoid', match_terms: 'coentro' }),
    row({ kind: 'preference', code: 'banana', label: 'Banana', preference_kind: 'like', match_terms: 'banana' }),
  ];
  const p = consolidate(1, rows, AT);

  it('detecta alergia (forte) e intolerância (moderada) no mesmo termo', () => {
    const c = evaluateConflicts(p, 'Iogurte natural');
    expect(c.find((x) => x.kind === 'allergy' && x.level === 'strong')).toBeTruthy();
    expect(c.find((x) => x.kind === 'intolerance' && x.level === 'moderate')).toBeTruthy();
  });
  it('restrição vegana via "frango" = info', () => {
    const c = evaluateConflicts(p, 'Frango grelhado');
    expect(c).toEqual([expect.objectContaining({ kind: 'restriction', level: 'info', matchedTerm: 'frango' })]);
  });
  it('aversão coentro = suggestion', () => {
    const c = evaluateConflicts(p, 'Sopa com coentro');
    expect(c).toEqual([expect.objectContaining({ kind: 'preference', level: 'suggestion' })]);
  });
  it('NÃO gera falso-positivo: "salada" não casa hipertensão (sal)', () => {
    const c = evaluateConflicts(p, 'Salada de alface');
    expect(c).toHaveLength(0);
  });
  it('preferência "like" (banana) nunca conflita', () => {
    const c = evaluateConflicts(p, 'Vitamina de banana');
    expect(c).toHaveLength(0);
  });
  it('texto vazio → sem conflitos', () => {
    expect(evaluateConflicts(p, '')).toHaveLength(0);
  });
});

describe('swapHintFor', () => {
  it('usa o código do catálogo quando existe', () => {
    expect(swapHintFor({ level: 'strong', kind: 'allergy', label: 'Leite', code: 'milk', matchedTerm: 'leite' }))
      .toMatch(/bebida vegetal/i);
  });
  it('cai no fallback por categoria quando o código não tem dica', () => {
    expect(swapHintFor({ level: 'info', kind: 'restriction', label: 'X', code: 'codigo_inexistente', matchedTerm: 'x' }))
      .toMatch(/respeite a restri/i);
  });
  it('item custom (code null) usa fallback por categoria', () => {
    expect(swapHintFor({ level: 'strong', kind: 'allergy', label: 'Custom', code: null, matchedTerm: 'x' }))
      .toMatch(/alérgeno/i);
  });
});
