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

export type ParsedUnitType = 'grams' | 'measure';

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
];
// Do prefixo mais longo (3 palavras) para o mais curto (1), senão "colher"
// isolado casaria antes de testar "colher de sopa".
const MEASURE_ALIASES_BY_LENGTH = [...MEASURE_ALIASES].sort((a, b) => b.words.length - a.words.length);

const GRAMS_ML_UNIT = /^(g|gr|gramas?|ml|mililitros?)$/;
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
 * isolado, ou ',' — mas só quando a vírgula NÃO é separador decimal
 * ("12,5g" nunca quebra; "castanha, 200g" quebra, porque o separador de
 * lista vem seguido de espaço e a decimal não).
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\+|;|\n|\s+e\s+|,(?!\d)/i)
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
    return { rawText, foodQuery: normalizeText(rawText), quantity: 1, unitType: 'measure', measureName: null };
  }
  const quantity = parseQuantity(qtyMatch[1]);
  const remainder = normalizeText(lowered.slice(qtyMatch[0].length));
  if (quantity == null || !remainder) {
    return { rawText, foodQuery: normalizeText(rawText), quantity: 1, unitType: 'measure', measureName: null };
  }
  const remainderWords = remainder.split(' ');

  // 1) unidade de grama/ml, colada ("200g") ou separada ("200 g").
  if (GRAMS_ML_UNIT.test(remainderWords[0])) {
    const foodQuery = dropLeadingDe(remainderWords.slice(1)).join(' ').trim();
    if (foodQuery) return { rawText, foodQuery, quantity, unitType: 'grams', measureName: null };
  }

  // 2) medida caseira nomeada (colher de sopa/chá, xícara, copo, concha, fatia, unidade).
  for (const alias of MEASURE_ALIASES_BY_LENGTH) {
    const prefix = remainderWords.slice(0, alias.words.length).join(' ');
    if (prefix === alias.words.join(' ')) {
      const foodQuery = dropLeadingDe(remainderWords.slice(alias.words.length)).join(' ').trim();
      if (foodQuery) return { rawText, foodQuery, quantity, unitType: 'measure', measureName: alias.canonical };
    }
  }

  // 3) contagem de alimento no plural, sem palavra de medida — "2 ovos", "3 bananas".
  const foodQuery = [singularize(remainderWords[0]), ...remainderWords.slice(1)].join(' ').trim();
  return { rawText, foodQuery, quantity, unitType: 'measure', measureName: null };
}

export function parseIntakeText(text: string): ParsedIntakeToken[] {
  return splitSegments(text).map(parseSegment);
}
