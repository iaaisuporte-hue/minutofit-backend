/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B) — parser DETERMINÍSTICO de texto livre
 * de refeição ("200g de frango + 150g de arroz + 2 ovos") em tokens
 * estruturados. Módulo PURO — nenhum acesso a catálogo/banco aqui; a
 * resolução contra `nutrition_foods` fica em `nutritionIntakeService.ts`.
 *
 * A IA (quando `nutrition_intake_ai` estiver ligada) só entra depois deste
 * parser, e só sobre os tokens que ele não conseguiu separar — nunca
 * substitui esta etapa determinística.
 */

/**
 * PLAN P1B.1 ("Smart Food Logging" spike, §2/§10) — `ml` deixou de ser
 * sinônimo de `grams`. Massa e volume são dimensões físicas diferentes; a
 * conversão de volume para grama SÓ acontece no Measure Resolver
 * (`nutritionIntakeService.ts`), de forma encapsulada e restrita a alimentos
 * cuja densidade é conhecida com segurança (categoria Bebidas) — nunca aqui,
 * e nunca com um fator 1:1 universal.
 */
export type ParsedUnitType = 'grams' | 'ml' | 'measure';
export type ParsedUnitDimension = 'mass' | 'volume' | 'count' | 'household';

export interface ParsedIntakeToken {
  /** Texto original do trecho, antes de qualquer normalização — para exibir "?" ao usuário. */
  rawText: string;
  /** Nome do alimento a buscar no catálogo, já normalizado (minúsculo, sem acento). */
  foodQuery: string;
  quantity: number;
  unitType: ParsedUnitType;
  /**
   * Nome canônico da medida quando `unitType === 'measure'` E o usuário citou
   * uma palavra de medida explícita (ex.: 'colher_sopa', 'unidade'). `null`
   * quando a própria contagem do alimento é a "medida" (ex.: "3 bananas") —
   * a resolução decide se existe medida cadastrada para o alimento singular.
   */
  measureName: string | null;
  /**
   * Dimensão física da unidade tal como o usuário a expressou — usada só
   * para (a) rotular a quantidade na UI sem nunca forjar "g" onde o usuário
   * disse "ml" (§3 do spike: nunca pedir "informe em gramas" para algo já
   * informado corretamente) e (b) desambiguar alimento por medida (café em
   * xícara = a bebida, não o pó — ver `nutritionFoodMatcher.findExact`).
   */
  unitDimension: ParsedUnitDimension;
  /** Rótulo de exibição da unidade tal como o usuário disse ("ml", "xícara", "unidade") — nunca "g" por padrão. */
  unitLabel: string;
}

/** Medidas caseiras com nome canônico reconhecido pelo parser (PLAN §10). */
const MEASURE_ALIASES: Array<{ words: string[]; canonical: string }> = [
  { words: ['colher', 'de', 'sopa'], canonical: 'colher_sopa' },
  { words: ['colheres', 'de', 'sopa'], canonical: 'colher_sopa' },
  { words: ['colher', 'de', 'cha'], canonical: 'colher_cha' },
  { words: ['colheres', 'de', 'cha'], canonical: 'colher_cha' },
  { words: ['xicara'], canonical: 'xicara' },
  { words: ['xicaras'], canonical: 'xicara' },
  { words: ['copo'], canonical: 'copo' },
  { words: ['copos'], canonical: 'copo' },
  { words: ['concha'], canonical: 'concha' },
  { words: ['conchas'], canonical: 'concha' },
  { words: ['fatia'], canonical: 'fatia' },
  { words: ['fatias'], canonical: 'fatia' },
  { words: ['unidade'], canonical: 'unidade' },
  { words: ['unidades'], canonical: 'unidade' },
  // Suplemento (whey/creatina) — nunca resolvido no catálogo TACO (§Fora de
  // escopo: nenhum banco externo), mas reconhecer a MEDIDA já ajuda o
  // histórico do usuário a bater no nome do alimento sem o ruído de
  // "scoop"/"dose" dentro do `foodQuery` (PLAN P1B.1 §caveat 6).
  { words: ['scoop'], canonical: 'scoop' },
  { words: ['scoops'], canonical: 'scoop' },
  { words: ['dose'], canonical: 'dose' },
  { words: ['doses'], canonical: 'dose' },
];
// Do prefixo mais longo (3 palavras) para o mais curto (1), senão "colher"
// isolado casaria antes de testar "colher de sopa".
const MEASURE_ALIASES_BY_LENGTH = [...MEASURE_ALIASES].sort((a, b) => b.words.length - a.words.length);

const MASS_UNIT = /^(g|gr|gramas?|kg|quilos?|kilos?)$/;
const VOLUME_UNIT = /^(ml|mililitros?|l|litros?)$/;
const KG_WORDS = new Set(['kg', 'quilo', 'quilos', 'kilo', 'kilos']);
const L_WORDS = new Set(['l', 'litro', 'litros']);
const LEADING_QUANTITY = /^(\d+(?:[.,]\d+)?)\s*/;

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function normalizeText(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQuantity(raw: string): number | null {
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Heurística de plural → singular do PT-BR (só o suficiente para "ovos"→"ovo", "bananas"→"banana"). */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith('oes')) return `${word.slice(0, -3)}ao`;
  if (word.length > 2 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function dropLeadingDe(words: string[]): string[] {
  return words[0] === 'de' ? words.slice(1) : words;
}

/**
 * Divide o texto em segmentos por alimento: '+', ';', quebra de linha, " e "
 * isolado, ',' (mas só quando NÃO é separador decimal — "12,5g" nunca
 * quebra; "castanha, 200g" quebra), e " com " SÓ quando seguido de outra
 * quantidade numérica (PLAN P1B.1 §9, caso 8: "200g de frango grelhado com
 * 150g de arroz cozido" são dois itens; "arroz com feijão", sem número
 * depois de "com", continua um prato único — nunca quebrado).
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\+|;|\n|\s+e\s+|,(?!\d)|\s+com\s+(?=\d)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Faz o parse de um segmento único ("200g de frango", "2 ovos", "1 xícara de arroz").
 * Nunca lança — segmento não reconhecido cai no fallback "1 unidade" (a resolução
 * decide se vira não resolvido).
 */
function parseSegment(rawText: string): ParsedIntakeToken {
  // Extrai a quantidade ANTES de normalizar (a normalização apaga o "." decimal
  // junto com o resto da pontuação) — só baixa a caixa/acento aqui.
  const lowered = stripAccents(rawText).toLowerCase().trim();
  const qtyMatch = lowered.match(LEADING_QUANTITY);
  if (!qtyMatch) {
    return { rawText, foodQuery: normalizeText(rawText), quantity: 1, unitType: 'measure', measureName: null, unitDimension: 'household', unitLabel: 'unidade' };
  }
  const quantity = parseQuantity(qtyMatch[1]);
  const remainder = normalizeText(lowered.slice(qtyMatch[0].length));
  if (quantity == null || !remainder) {
    return { rawText, foodQuery: normalizeText(rawText), quantity: 1, unitType: 'measure', measureName: null, unitDimension: 'household', unitLabel: 'unidade' };
  }
  const remainderWords = remainder.split(' ');

  // 1) unidade de massa, colada ("200g") ou separada ("200 g"/"2kg") — kg
  //    converte para gramas aqui (mesma dimensão, base única de cálculo).
  if (MASS_UNIT.test(remainderWords[0])) {
    const foodQuery = dropLeadingDe(remainderWords.slice(1)).join(' ').trim();
    if (foodQuery) {
      const isKg = KG_WORDS.has(remainderWords[0]);
      return {
        rawText, foodQuery,
        quantity: isKg ? quantity * 1000 : quantity,
        unitType: 'grams', measureName: null,
        unitDimension: 'mass', unitLabel: 'g',
      };
    }
  }

  // 1b) unidade de VOLUME ("200ml"/"1l") — dimensão própria, nunca colapsada
  //     em massa aqui (PLAN P1B.1 §2/§10) — l converte para ml (base única).
  if (VOLUME_UNIT.test(remainderWords[0])) {
    const foodQuery = dropLeadingDe(remainderWords.slice(1)).join(' ').trim();
    if (foodQuery) {
      const isL = L_WORDS.has(remainderWords[0]);
      return {
        rawText, foodQuery,
        quantity: isL ? quantity * 1000 : quantity,
        unitType: 'ml', measureName: null,
        unitDimension: 'volume', unitLabel: 'ml',
      };
    }
  }

  // 2) medida caseira nomeada (colher de sopa/chá, xícara, copo, concha, fatia, unidade).
  for (const alias of MEASURE_ALIASES_BY_LENGTH) {
    const prefix = remainderWords.slice(0, alias.words.length).join(' ');
    if (prefix === alias.words.join(' ')) {
      const foodQuery = dropLeadingDe(remainderWords.slice(alias.words.length)).join(' ').trim();
      if (foodQuery) {
        return {
          rawText, foodQuery, quantity, unitType: 'measure', measureName: alias.canonical,
          // xícara/copo são recipientes de LÍQUIDO na fala comum — colher/concha/fatia/unidade/scoop/dose não.
          unitDimension: alias.canonical === 'xicara' || alias.canonical === 'copo' ? 'volume' : 'household',
          unitLabel: MEASURE_LABELS[alias.canonical] ?? alias.canonical,
        };
      }
    }
  }

  // 3) contagem de alimento no plural, sem palavra de medida — "2 ovos", "3 bananas".
  const foodQuery = [singularize(remainderWords[0]), ...remainderWords.slice(1)].join(' ').trim();
  return { rawText, foodQuery, quantity, unitType: 'measure', measureName: null, unitDimension: 'count', unitLabel: 'unidade' };
}

/** Rótulo de exibição por medida canônica — nunca "g" (PLAN P1B.1 §3). */
const MEASURE_LABELS: Record<string, string> = {
  colher_sopa: 'colher de sopa',
  colher_cha: 'colher de chá',
  xicara: 'xícara',
  copo: 'copo',
  concha: 'concha',
  fatia: 'fatia',
  unidade: 'unidade',
  scoop: 'scoop',
  dose: 'dose',
};

export function parseIntakeText(text: string): ParsedIntakeToken[] {
  return splitSegments(text).map(parseSegment);
}
