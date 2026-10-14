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
import { PREPARATION_LEMMAS } from './nutritionFoodMatcher';

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
  /**
   * Preparo extraído por `PREPARATION_LEMMAS` quando presente em `foodQuery`
   * (PLAN CANONICAL_FOOD_MODEL_SPIKE §9/§21) — primeira classe agora, em vez
   * de só afetar o score do fuzzy match. NÃO remove a palavra de `foodQuery`
   * (o matching continua precisando dela do jeito que já funciona) — é um
   * campo PARALELO, side-effect não-destrutivo, usado pelo Canonical Food
   * Resolver (`canonicalFood.ts`) para exibir "Grelhado" como legenda em vez
   * de deixá-lo enterrado dentro do nome bruto da fonte.
   */
  preparation: string | null;
}

/** Escaneia as palavras (já normalizadas) contra `PREPARATION_LEMMAS` — primeiro match encontrado vence; ordem não importa para os 6 lemas hoje conhecidos (nunca coexistem 2 preparos na mesma menção). */
function extractPreparation(words: string[]): string | null {
  for (const w of words) {
    const lemma = PREPARATION_LEMMAS[w];
    if (lemma) return lemma;
  }
  return null;
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

/**
 * Verbos de consumo no INÍCIO da frase ("comi 4 biscoitos", "tomei 200 ml de leite", "bebi um copo de água") — lista
 * fechada e explícita; o verbo descreve o ato, não o alimento, então sai do texto interpretado (o `rawText` fica intacto).
 */
const CONSUMPTION_VERB = /^(?:eu\s+)?(?:comi|tomei|bebi|ingeri|comemos|tomamos|bebemos)\s+/;

function stripConsumptionVerb(lowered: string): string {
  return lowered.replace(CONSUMPTION_VERB, '');
}

/** Numerais por extenso mais comuns na fala ("um pão", "duas fatias", "meia banana"). Lista fechada, sem inferência. */
const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  meio: 0.5, meia: 0.5,
};
const WORD_QUANTITY = new RegExp(`^(${Object.keys(NUMBER_WORDS).join('|')})\\b(?:\\s+e\\s+(meio|meia)\\b)?\\s*`);
const MIXED_FRACTION = /^(\d+)\s+e\s+(\d+)\s*\/\s*(\d+)(?!\d)\s*/;
const SIMPLE_FRACTION = /^(\d+)\s*\/\s*(\d+)(?!\d)\s*/;
const DIGIT_AND_HALF = /^(\d+(?:[.,]\d+)?)\s+e\s+(?:meio|meia)\b\s*/;

/**
 * Quantidade no início do trecho (já sem acento/minúsculo): fração ("1/2", "1 e 1/2"), "1 e meio", decimal, ou numeral
 * por extenso ("um", "duas", "meia", "um e meio"). Devolve a quantidade e quantos caracteres consumiu, ou `null`.
 * Fração com denominador 0 não é quantidade (cai no comportamento antigo) — nunca vira "1 unidade" silenciosa de "1/2".
 */
function extractLeadingQuantity(lowered: string): { quantity: number; length: number } | null {
  let m = lowered.match(MIXED_FRACTION);
  if (m) {
    const den = Number(m[3]);
    const q = den > 0 ? Number(m[1]) + Number(m[2]) / den : 0;
    return q > 0 ? { quantity: q, length: m[0].length } : null;
  }
  m = lowered.match(SIMPLE_FRACTION);
  if (m) {
    const den = Number(m[2]);
    const q = den > 0 ? Number(m[1]) / den : 0;
    return q > 0 ? { quantity: q, length: m[0].length } : null; // "0/2" não é quantidade (nunca 0 g "resolvido")
  }
  m = lowered.match(DIGIT_AND_HALF);
  if (m) {
    const base = parseQuantity(m[1]);
    return base == null ? null : { quantity: base + 0.5, length: m[0].length };
  }
  m = lowered.match(LEADING_QUANTITY);
  if (m) {
    const q = parseQuantity(m[1]);
    return q == null ? null : { quantity: q, length: m[0].length };
  }
  m = lowered.match(WORD_QUANTITY);
  if (m) {
    return { quantity: NUMBER_WORDS[m[1]] + (m[2] ? 0.5 : 0), length: m[0].length };
  }
  return null;
}

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

/**
 * "média/médio" é só o tamanho-padrão que as medidas curadas já assumem ("unidade média" da banana prata): fora
 * do `foodQuery` o alimento volta a casar ("1 banana média" = "1 banana"). "pequena/grande" NÃO são removidas —
 * a medida curada seria a errada, então a menção segue para confirmação em vez de usar o tamanho médio por engano.
 */
const MEDIUM_SIZE_WORDS = new Set(['media', 'medio', 'medias', 'medios']);

function dropMediumSize(words: string[]): string[] {
  return words.filter((w) => !MEDIUM_SIZE_WORDS.has(w));
}

/**
 * "sem açúcar/adoçante" é a AUSÊNCIA de um ingrediente — não muda o alimento descrito ("café sem açúcar" é o café), então
 * sai do `foodQuery`. Já "com açúcar", "com leite" etc. são ingredientes e ficam (a mistura é tratada no resolver).
 */
function dropNoSugar(text: string): string {
  return text.replace(/\bsem (?:acucar|adocante)\b/g, ' ').replace(/\s+/g, ' ').trim();
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
/** Quantidade (dígitos ou numeral por extenso) que pode ser seguida de " e meio" / " e 1/2" dentro do MESMO item. */
const SPLIT_GUARD_QUANTITY = '\\d+(?:[.,]\\d+)?|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze';

function splitSegments(text: string): string[] {
  // " e meio/meia" e " e X/Y" PERTENCEM à quantidade quando vêm logo depois de uma quantidade ("1 e meio pão", "um e 1/2
  // banana"); depois de um ALIMENTO ("1 pão e meia banana") continuam sendo o separador de itens. Protege só o primeiro caso.
  const joinedHalf = new RegExp(`\\b(${SPLIT_GUARD_QUANTITY})\\s+e\\s+(?=mei[oa]\\b|\\d+\\s*\\/\\s*\\d+)`, 'gi');
  return text
    .replace(joinedHalf, '$1\u0001')
    .split(/\+|;|\n|\s+e\s+|,(?!\d)|\s+com\s+(?=\d)/i)
    .map((s) => s.replace(/\u0001/g, ' e ').trim())
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
  const lowered = stripConsumptionVerb(stripAccents(rawText).toLowerCase().trim());
  const qtyMatch = extractLeadingQuantity(lowered);
  if (!qtyMatch) {
    return { rawText, foodQuery: dropNoSugar(normalizeText(lowered)), quantity: 1, unitType: 'measure', measureName: null, unitDimension: 'household', unitLabel: 'unidade', preparation: null };
  }
  const quantity = qtyMatch.quantity;
  const remainder = dropNoSugar(normalizeText(lowered.slice(qtyMatch.length)));
  if (!remainder) {
    return { rawText, foodQuery: dropNoSugar(normalizeText(lowered)), quantity: 1, unitType: 'measure', measureName: null, unitDimension: 'household', unitLabel: 'unidade', preparation: null };
  }
  const remainderWords = remainder.split(' ');

  // 1) unidade de massa, colada ("200g") ou separada ("200 g"/"2kg") — kg
  //    converte para gramas aqui (mesma dimensão, base única de cálculo).
  if (MASS_UNIT.test(remainderWords[0])) {
    const rest = dropLeadingDe(remainderWords.slice(1));
    const foodQuery = rest.join(' ').trim();
    if (foodQuery) {
      const isKg = KG_WORDS.has(remainderWords[0]);
      return {
        rawText, foodQuery,
        quantity: isKg ? quantity * 1000 : quantity,
        unitType: 'grams', measureName: null,
        unitDimension: 'mass', unitLabel: 'g',
        preparation: extractPreparation(rest),
      };
    }
  }

  // 1b) unidade de VOLUME ("200ml"/"1l") — dimensão própria, nunca colapsada
  //     em massa aqui (PLAN P1B.1 §2/§10) — l converte para ml (base única).
  if (VOLUME_UNIT.test(remainderWords[0])) {
    const rest = dropLeadingDe(remainderWords.slice(1));
    const foodQuery = rest.join(' ').trim();
    if (foodQuery) {
      const isL = L_WORDS.has(remainderWords[0]);
      return {
        rawText, foodQuery,
        quantity: isL ? quantity * 1000 : quantity,
        unitType: 'ml', measureName: null,
        unitDimension: 'volume', unitLabel: 'ml',
        preparation: extractPreparation(rest),
      };
    }
  }

  // 2) medida caseira nomeada (colher de sopa/chá, xícara, copo, concha, fatia, unidade).
  for (const alias of MEASURE_ALIASES_BY_LENGTH) {
    const prefix = remainderWords.slice(0, alias.words.length).join(' ');
    if (prefix === alias.words.join(' ')) {
      const rest = dropLeadingDe(remainderWords.slice(alias.words.length));
      const foodQuery = rest.join(' ').trim();
      if (foodQuery) {
        return {
          rawText, foodQuery, quantity, unitType: 'measure', measureName: alias.canonical,
          // xícara/copo são recipientes de LÍQUIDO na fala comum — colher/concha/fatia/unidade/scoop/dose não.
          unitDimension: alias.canonical === 'xicara' || alias.canonical === 'copo' ? 'volume' : 'household',
          unitLabel: MEASURE_LABELS[alias.canonical] ?? alias.canonical,
          preparation: extractPreparation(rest),
        };
      }
    }
  }

  // 3) contagem de alimento no plural, sem palavra de medida — "2 ovos", "3 bananas".
  const countRest = dropMediumSize(remainderWords.slice(1));
  const foodQuery = [singularize(remainderWords[0]), ...countRest].join(' ').trim();
  return {
    rawText, foodQuery, quantity, unitType: 'measure', measureName: null, unitDimension: 'count', unitLabel: 'unidade',
    preparation: extractPreparation(countRest),
  };
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
