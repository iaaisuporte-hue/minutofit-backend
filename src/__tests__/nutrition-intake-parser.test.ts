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

  // PLAN P1B.1 ("Smart Food Logging" spike) — ml deixou de ser sinônimo de
  // grama: são dimensões físicas diferentes, e a conversão (quando possível
  // e segura) só acontece no Measure Resolver do serviço, nunca aqui.
  it('ml preserva a dimensão de volume — nunca colapsa em grama', () => {
    const [t] = parseIntakeText('250ml de leite');
    expect(t).toMatchObject({ foodQuery: 'leite', quantity: 250, unitType: 'ml', unitDimension: 'volume', unitLabel: 'ml' });
  });

  it('litro converte para ml (base única de volume)', () => {
    const [t] = parseIntakeText('1l de leite');
    expect(t).toMatchObject({ foodQuery: 'leite', quantity: 1000, unitType: 'ml' });
  });

  it('quilo converte para grama (base única de massa)', () => {
    const [t] = parseIntakeText('1kg de arroz');
    expect(t).toMatchObject({ foodQuery: 'arroz', quantity: 1000, unitType: 'grams' });
  });

  it('separador " com " só quebra quando seguido de outra quantidade', () => {
    const withQty = parseIntakeText('200g de frango grelhado com 150g de arroz cozido');
    expect(withQty).toHaveLength(2);
    expect(withQty[0].foodQuery).toBe('frango grelhado');
    expect(withQty[1].foodQuery).toBe('arroz cozido');

    const withoutQty = parseIntakeText('arroz com feijão');
    expect(withoutQty).toHaveLength(1);
  });

  it('scoop e dose são reconhecidos como medida caseira (suplemento, PLAN §caveat 6)', () => {
    const [t] = parseIntakeText('1 scoop de whey');
    expect(t).toMatchObject({ foodQuery: 'whey', quantity: 1, unitType: 'measure', measureName: 'scoop', unitLabel: 'scoop' });
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

  // Adendo "Preparações" — quantidade e "alimento + preparo" são
  // responsabilidades separadas (§1/§11): o parser só separa QUANTIDADE de
  // "o resto"; é o resolver (`nutritionFoodMatcher`) quem lematiza o preparo
  // dentro desse "resto" na hora de pontuar candidatos — o parser nunca
  // descarta a palavra de preparo, só não sabe (nem precisa saber) o que ela
  // significa.
  describe('separação quantidade × "alimento + preparo" (preparo nunca descartado aqui)', () => {
    it('"2 ovos fritos": quantidade=2, foodQuery carrega alimento E preparo intactos', () => {
      const [t] = parseIntakeText('2 ovos fritos');
      expect(t.quantity).toBe(2);
      expect(t.foodQuery).toBe('ovo fritos');
    });

    it('"200g de frango grelhado": quantidade em gramas, foodQuery = alimento + preparo', () => {
      const [t] = parseIntakeText('200g de frango grelhado');
      expect(t).toMatchObject({ quantity: 200, unitType: 'grams' });
      expect(t.foodQuery).toBe('frango grelhado');
    });

    it('"150 gramas de arroz cozido"', () => {
      const [t] = parseIntakeText('150 gramas de arroz cozido');
      expect(t).toMatchObject({ quantity: 150, unitType: 'grams' });
      expect(t.foodQuery).toBe('arroz cozido');
    });

    it('"1 banana prata": quantidade=1, foodQuery preserva a variante "prata"', () => {
      const [t] = parseIntakeText('1 banana prata');
      expect(t.quantity).toBe(1);
      expect(t.foodQuery).toBe('banana prata');
    });
  });

  // P1 — "média" é o tamanho que as medidas curadas já assumem; sai do foodQuery. "grande"/"pequena" ficam.
  it('"1 banana média" e "2 bananas médias" → foodQuery só com o alimento', () => {
    expect(parseIntakeText('1 banana média')[0]).toMatchObject({ foodQuery: 'banana', quantity: 1 });
    expect(parseIntakeText('2 bananas médias')[0]).toMatchObject({ foodQuery: 'banana', quantity: 2 });
  });

  it('"1 banana grande" mantém o tamanho no foodQuery (não usa a medida média por engano)', () => {
    expect(parseIntakeText('1 banana grande')[0].foodQuery).toBe('banana grande');
  });

  // Alimentação Livre — entrada natural: verbos de consumo, numerais por extenso e frações.
  describe('linguagem natural (verbos, numerais, frações)', () => {
    it.each([
      ['Comi 4 biscoitos', 4, 'unidade', 'biscoito'],
      ['Tomei 200 ml de leite', 200, 'ml', 'leite'],
      ['Bebi um copo de água', 1, 'copo', 'agua'],
      ['Comi um pão', 1, 'unidade', 'pao'],
      ['Duas fatias de pão', 2, 'fatia', 'pao'],
      ['Meia banana', 0.5, 'unidade', 'banana'],
      ['1/2 banana', 0.5, 'unidade', 'banana'],
      ['Um scoop de whey', 1, 'scoop', 'whey'],
      ['Comi dois ovos fritos', 2, 'unidade', 'ovo fritos'],
      ['meia xícara de arroz', 0.5, 'xícara', 'arroz'],
      ['uma colher de sopa de arroz', 1, 'colher de sopa', 'arroz'],
      ['1 e meio pão', 1.5, 'unidade', 'pao'],
      ['um e meio pão', 1.5, 'unidade', 'pao'],
      ['1 e 1/2 banana', 1.5, 'unidade', 'banana'],
      ['3/4 xícara de leite', 0.75, 'xícara', 'leite'],
    ])('%s → quantidade %p, unidade %s, alimento "%s"', (text, quantity, unitLabel, foodQuery) => {
      const tokens = parseIntakeText(text as string);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({ quantity, unitLabel, foodQuery });
    });

    it('"Comi um pão e dois ovos" → dois itens separados, cada um com a sua quantidade', () => {
      const tokens = parseIntakeText('Comi um pão e dois ovos');
      expect(tokens.map((t) => [t.quantity, t.foodQuery])).toEqual([[1, 'pao'], [2, 'ovo']]);
    });

    it('"1/2" NUNCA vira 1 unidade de "2 banana" (quantidade silenciosamente errada)', () => {
      const [t] = parseIntakeText('1/2 banana');
      expect(t.quantity).toBe(0.5);
      expect(t.foodQuery).not.toMatch(/2/);
    });

    it('o rawText original é preservado (verbo e numeral por extenso)', () => {
      expect(parseIntakeText('Comi dois ovos fritos')[0].rawText).toBe('Comi dois ovos fritos');
    });

    it('verbo sem quantidade ("comi arroz") sai do foodQuery; "e meio/meia" não quebra o item em dois', () => {
      expect(parseIntakeText('comi arroz')[0]).toMatchObject({ foodQuery: 'arroz', quantity: 1 });
      expect(parseIntakeText('um e meio pão')).toHaveLength(1);
    });

    it('fração com denominador 0 não vira quantidade; palavras que só COMEÇAM como numeral não são afetadas', () => {
      expect(parseIntakeText('3/0 banana')[0].quantity).toBe(1);
      expect(parseIntakeText('umbu')[0].foodQuery).toBe('umbu');
      expect(parseIntakeText('dez azeitonas')[0]).toMatchObject({ quantity: 10, foodQuery: 'azeitona' });
    });

    it('não regride a forma numérica de sempre', () => {
      expect(parseIntakeText('2 ovos')[0]).toMatchObject({ quantity: 2, foodQuery: 'ovo' });
      expect(parseIntakeText('200g de frango')[0]).toMatchObject({ quantity: 200, unitType: 'grams', foodQuery: 'frango' });
      expect(parseIntakeText('1,5 scoop de whey')[0]).toMatchObject({ quantity: 1.5, measureName: 'scoop' });
    });
  });
});
