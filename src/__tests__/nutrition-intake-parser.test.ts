import { parseIntakeText } from '../services/nutritionIntakeParser';

describe('nutritionIntakeParser', () => {
  it('grams com "g"', () => {
    const [t] = parseIntakeText('200g de frango');
    expect(t).toMatchObject({ foodQuery: 'frango', quantity: 200, unitType: 'grams', measureName: null });
  });

  it('grams com "gr"', () => {
    const [t] = parseIntakeText('150gr arroz');
    expect(t).toMatchObject({ foodQuery: 'arroz', quantity: 150, unitType: 'grams' });
  });

  it('grams com a palavra "gramas"', () => {
    const [t] = parseIntakeText('80 gramas de aveia');
    expect(t).toMatchObject({ foodQuery: 'aveia', quantity: 80, unitType: 'grams' });
  });

  it('ml', () => {
    const [t] = parseIntakeText('250ml de leite');
    expect(t).toMatchObject({ foodQuery: 'leite', quantity: 250, unitType: 'grams' });
  });

  it('decimal com vírgula', () => {
    const [t] = parseIntakeText('12,5g de castanha');
    expect(t).toMatchObject({ foodQuery: 'castanha', quantity: 12.5, unitType: 'grams' });
  });

  it('decimal com ponto', () => {
    const [t] = parseIntakeText('12.5g de castanha');
    expect(t).toMatchObject({ foodQuery: 'castanha', quantity: 12.5, unitType: 'grams' });
  });

  it('colher de sopa', () => {
    const [t] = parseIntakeText('2 colheres de sopa de azeite');
    expect(t).toMatchObject({ foodQuery: 'azeite', quantity: 2, unitType: 'measure', measureName: 'colher_sopa' });
  });

  it('colher de chá', () => {
    const [t] = parseIntakeText('1 colher de chá de mel');
    expect(t).toMatchObject({ foodQuery: 'mel', quantity: 1, unitType: 'measure', measureName: 'colher_cha' });
  });

  it('xícara', () => {
    const [t] = parseIntakeText('1 xícara de arroz');
    expect(t).toMatchObject({ foodQuery: 'arroz', quantity: 1, unitType: 'measure', measureName: 'xicara' });
  });

  it('xícara sem acento', () => {
    const [t] = parseIntakeText('1 xicara de arroz');
    expect(t).toMatchObject({ measureName: 'xicara' });
  });

  it('copo', () => {
    const [t] = parseIntakeText('1 copo de suco');
    expect(t).toMatchObject({ foodQuery: 'suco', quantity: 1, unitType: 'measure', measureName: 'copo' });
  });

  it('concha', () => {
    const [t] = parseIntakeText('2 conchas de feijão');
    expect(t).toMatchObject({ foodQuery: 'feijao', quantity: 2, unitType: 'measure', measureName: 'concha' });
  });

  it('fatia', () => {
    const [t] = parseIntakeText('2 fatias de pão integral');
    expect(t).toMatchObject({ foodQuery: 'pao integral', quantity: 2, unitType: 'measure', measureName: 'fatia' });
  });

  it('unidade explícita', () => {
    const [t] = parseIntakeText('1 unidade de banana');
    expect(t).toMatchObject({ foodQuery: 'banana', quantity: 1, unitType: 'measure', measureName: 'unidade' });
  });

  it('contagem de alimento no plural (sem palavra de medida) — "2 ovos"', () => {
    const [t] = parseIntakeText('2 ovos');
    expect(t).toMatchObject({ foodQuery: 'ovo', quantity: 2, unitType: 'measure', measureName: null });
  });

  it('contagem de alimento no plural — "3 bananas"', () => {
    const [t] = parseIntakeText('3 bananas');
    expect(t).toMatchObject({ foodQuery: 'banana', quantity: 3, unitType: 'measure', measureName: null });
  });

  it('separador "+"', () => {
    const tokens = parseIntakeText('200g de frango + 150g de arroz + 2 ovos');
    expect(tokens).toHaveLength(3);
    expect(tokens[0].foodQuery).toBe('frango');
    expect(tokens[1].foodQuery).toBe('arroz');
    expect(tokens[2].foodQuery).toBe('ovo');
  });

  it('separador ","', () => {
    const tokens = parseIntakeText('200g de frango, 150g de arroz');
    expect(tokens).toHaveLength(2);
  });

  it('separador " e " isolado', () => {
    const tokens = parseIntakeText('200g de frango e 150g de arroz');
    expect(tokens).toHaveLength(2);
    expect(tokens[1].foodQuery).toBe('arroz');
  });

  it('não confunde "e" dentro de uma palavra com separador', () => {
    const tokens = parseIntakeText('100g de feijão');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].foodQuery).toBe('feijao');
  });

  it('quebra de linha como separador', () => {
    const tokens = parseIntakeText('200g de frango\n150g de arroz');
    expect(tokens).toHaveLength(2);
  });

  it('texto sem quantidade reconhecível cai no fallback (1 unidade, sem medida)', () => {
    const [t] = parseIntakeText('salada de frutas');
    expect(t).toMatchObject({ quantity: 1, unitType: 'measure', measureName: null });
    expect(t.foodQuery).toContain('salada');
  });

  it('lixo puro não quebra o parser', () => {
    expect(() => parseIntakeText('###@@@ ??? ')).not.toThrow();
  });

  it('string vazia devolve lista vazia', () => {
    expect(parseIntakeText('')).toEqual([]);
  });

  it('maiúsculas e acentos são normalizados no foodQuery', () => {
    const [t] = parseIntakeText('200G DE PÃO FRANCÊS');
    expect(t.foodQuery).toBe('pao frances');
  });

  it('preserva o rawText original do segmento', () => {
    const [t] = parseIntakeText('200g de frango');
    expect(t.rawText).toBe('200g de frango');
  });
});
