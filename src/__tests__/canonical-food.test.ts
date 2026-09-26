/**
 * PLAN CANONICAL_FOOD_MODEL_SPIKE.md §6-§9 — Canonical Food Resolver.
 * Unit puro: sem banco, sem I/O.
 */
import { toCanonicalFood, derivePreparationFromSourceName } from '../services/canonicalFood';

describe('toCanonicalFood', () => {
  it('alimento curado devolve nome natural, nunca a taxonomia bruta da fonte', () => {
    const cf = toCanonicalFood({ name: 'Frango, peito, sem pele, grelhado', normalizedName: 'frango peito sem pele grelhado' }, 'grelhado');
    expect(cf).toEqual({ baseFood: 'peito de frango', variant: null, preparation: 'grelhado' });
  });

  it('preserva `variant` quando o mapa curado tem um (banana prata)', () => {
    const cf = toCanonicalFood({ name: 'Banana, prata, crua', normalizedName: 'banana prata crua' }, null);
    expect(cf).toEqual({ baseFood: 'banana', variant: 'prata', preparation: null });
  });

  it('leite fluido importado do USDA usa o MESMO mapa curado — fonte-agnóstico (§14)', () => {
    const cf = toCanonicalFood({ name: 'Leite, de vaca, integral', normalizedName: 'leite de vaca integral' }, null);
    expect(cf).toEqual({ baseFood: 'leite', variant: 'integral', preparation: null });
  });

  it('preparo vem do parâmetro (Interpreter), nunca re-derivado do nome da fonte para o vencedor', () => {
    // Mesmo que a fonte diga "cru", o preparo passado explicitamente vence —
    // é o que o usuário disse, e o vencedor nunca diverge disso (§6).
    const cf = toCanonicalFood({ name: 'Ovo, de galinha, inteiro, cru', normalizedName: 'ovo de galinha inteiro cru' }, 'frito');
    expect(cf.preparation).toBe('frito');
  });

  it('alimento fora do mapa curado cai no transformador genérico — nunca pior que a string bruta, nunca quebra', () => {
    const cf = toCanonicalFood({ name: 'Corimbatá, assado', normalizedName: 'corimbata assado' }, 'assado');
    expect(cf.baseFood).toBe('Corimbatá');
    expect(cf.preparation).toBe('assado');
  });

  it('reconhece "cozida/10minutos" (convenção TACO de anotar tempo) como preparo puro — nunca duplica no nome-base', () => {
    const cf = toCanonicalFood({ name: 'Ovo, de galinha, clara, cozida/10minutos', normalizedName: 'ovo de galinha clara cozida 10minutos' }, null);
    expect(cf.baseFood).toBe('Ovo, de galinha, clara');
  });

  it('transformador genérico preserva variantes/qualificadores que NÃO são preparo', () => {
    const cf = toCanonicalFood({ name: 'Frango, coração, grelhado', normalizedName: 'frango coracao grelhado' }, 'grelhado');
    // "coração" não é preparo — fica no nome-base; "grelhado" some do nome
    // (já aparece como `preparation`, nunca duplicado).
    expect(cf.baseFood).toBe('Frango, coração');
  });
});

describe('derivePreparationFromSourceName', () => {
  it('extrai o preparo do PRÓPRIO nome da fonte (usado só para candidatos alternativos, §10)', () => {
    expect(derivePreparationFromSourceName('Frango, peito, com pele, assado')).toBe('assado');
    expect(derivePreparationFromSourceName('Ovo, de galinha, inteiro, frito')).toBe('frito');
  });

  it('devolve null quando nenhum segmento é puramente preparo', () => {
    expect(derivePreparationFromSourceName('Banana, prata, crua')).toBe('cru');
    expect(derivePreparationFromSourceName('Leite, de vaca, integral')).toBeNull();
  });
});
