/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B corrective) — resolução determinística de
 * texto livre contra o catálogo TACO. Substitui o ILIKE substring-contíguo
 * de `nutritionFoodService.searchCatalogFoods` (que falha sempre que uma
 * palavra do catálogo se intercala entre os termos do usuário — "pao frances"
 * nunca bate em "pao TRIGO frances") por um pipeline em camadas:
 *
 *   normalização → alias → exact (nome completo ou 1º segmento) → fuzzy
 *   (score por token, sobre TODO o catálogo em memória — algumas centenas de
 *   linhas, não milhões; ver PLAN §17/§18) → confiança por faixa de score +
 *   margem entre o 1º e o 2º colocado.
 *
 * Módulo PURO — nenhum acesso a banco. O catálogo entra como parâmetro
 * (`FoodIndexEntry[]`), carregado/cacheado por `nutritionFoodService.ts`.
 */

// ---------------------------------------------------------------------------
// Normalização (fonte única — nutritionFoodService e nutritionIntakeService
// tinham cada um sua cópia quase idêntica; consolidado aqui para garantir que
// alias/exact/fuzzy operem sobre exatamente a mesma forma normalizada).
// ---------------------------------------------------------------------------

export function normalizeFoodText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

// Palavras de ligação do próprio nome TACO ("Farinha, DE mandioca, crua") —
// não contam como "token extra não explicado pelo usuário" no denominador do
// score, mas continuam disponíveis para exact/prefix match caso o usuário as
// digite mesmo assim ("pão DE queijo").
const STOPWORDS = new Set(['de', 'do', 'da', 'dos', 'das', 'com', 'sem', 'em', 'e', 'a', 'o', 'no', 'na']);

export interface FoodIndexEntry {
  id: number;
  name: string;
  normalizedName: string;
  tokens: string[];
  /** 1º segmento do nome TACO antes da vírgula, normalizado — ex. "pao" em "Pão, trigo, francês". */
  firstSegment: string;
}

export function buildFoodIndex(foods: Array<{ id: number; name: string; normalizedName: string }>): FoodIndexEntry[] {
  return foods.map((f) => ({
    id: f.id,
    name: f.name,
    normalizedName: f.normalizedName,
    tokens: tokenize(f.normalizedName),
    firstSegment: normalizeFoodText(f.name.split(',')[0]),
  }));
}

// ---------------------------------------------------------------------------
// Aliases — lista pequena e explícita (PLAN §4). Cada entrada aponta para o
// `normalizedName` REAL de um alimento do catálogo — nunca macros próprias.
// Critério de inclusão: (a) grafias/nomes coloquiais inequívocos do mesmo
// alimento ("pão francês"/"pão de sal"/"pãozinho"; "macaxeira"/"aipim" para
// mandioca), ou (b) o nome-base de um alimento que só existe no catálogo com
// qualificador (o TACO nunca lista "Arroz" puro, só "Arroz, tipo 1, cozido"
// etc.) — nesses casos o alvo escolhido é sempre o tipo mais comum no Brasil
// E, quando existe, o mesmo item que já tem medida caseira curada em
// `nutrition_food_measures` (arroz tipo 1, feijão carioca, frango peito
// grelhado, banana prata, ovo de galinha) — nunca um palpite arbitrário.
// Termos genuinamente ambíguos sem candidato dominante (ex. "abóbora"/
// "jerimum", que têm 6 variedades no catálogo sem nenhuma medida curada)
// ficam DE FORA de propósito — a resolução correta ali é perguntar, não
// escolher (PLAN §22).
// ---------------------------------------------------------------------------
export const FOOD_ALIASES: Record<string, string> = {
  'pao frances': 'pao trigo frances',
  'pao de sal': 'pao trigo frances',
  paozinho: 'pao trigo frances',
  macaxeira: 'mandioca cozida',
  aipim: 'mandioca cozida',
  ovo: 'ovo de galinha inteiro cru',
  arroz: 'arroz tipo 1 cozido',
  feijao: 'feijao carioca cozido',
  frango: 'frango peito sem pele grelhado',
  banana: 'banana prata crua',
};

// ---------------------------------------------------------------------------
// Levenshtein + similaridade por token
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

const TOKEN_MATCH_MIN_SIM = 0.6;

/** Similaridade 0..1 entre dois tokens: exata > prefixo (>=3 chars) > edit-distance normalizada. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  const dist = levenshtein(a, b);
  const sim = 1 - dist / Math.max(a.length, b.length);
  return sim > 0 ? sim : 0;
}

// ---------------------------------------------------------------------------
// Score de um candidato contra os tokens da query (PLAN §6)
// ---------------------------------------------------------------------------

export interface CandidateScore {
  entry: FoodIndexEntry;
  score: number;
}

function scoreCandidate(queryTokens: string[], entry: FoodIndexEntry): number {
  const candidateTokens = entry.tokens;
  const meaningfulCandidateTokens = candidateTokens.filter((t) => !STOPWORDS.has(t));
  const matchedCandidateIdx = new Set<number>();

  let coverageSum = 0;
  for (const qt of queryTokens) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < candidateTokens.length; i++) {
      const sim = tokenSimilarity(qt, candidateTokens[i]);
      if (sim > best) {
        best = sim;
        bestIdx = i;
      }
    }
    coverageSum += best;
    if (best >= TOKEN_MATCH_MIN_SIM && bestIdx >= 0) matchedCandidateIdx.add(bestIdx);
  }
  const queryCoverage = queryTokens.length > 0 ? coverageSum / queryTokens.length : 0;

  const matchedMeaningful = candidateTokens.filter((t, i) => matchedCandidateIdx.has(i) && !STOPWORDS.has(t)).length;
  const tokenCountRatio = meaningfulCandidateTokens.length > 0 ? matchedMeaningful / meaningfulCandidateTokens.length : 1;

  const firstTokenBonus =
    queryTokens[0] && candidateTokens[0] && tokenSimilarity(queryTokens[0], candidateTokens[0]) >= 0.85 ? 0.15 : 0;

  const unmatchedMeaningful = meaningfulCandidateTokens.length - matchedMeaningful;
  const extraPenalty = Math.min(0.15, unmatchedMeaningful * 0.03);

  const score = queryCoverage * 0.55 + tokenCountRatio * 0.3 + firstTokenBonus - extraPenalty;
  return Math.max(0, Math.min(1, score));
}

export function topCandidates(query: string, index: FoodIndexEntry[], n = 3): CandidateScore[] {
  const queryTokens = tokenize(normalizeFoodText(query));
  return index
    .map((entry) => ({ entry, score: scoreCandidate(queryTokens, entry) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Thresholds — centralizados (PLAN §8/§10). Calibrados observando os scores
// reais do fuzzy matcher contra o catálogo TACO completo (582 itens) para o
// corpus de `nutritionFoodMatcher.test.ts` — nenhum valor escolhido às
// cegas: ver relatório de entrega para a distribuição observada.
// ---------------------------------------------------------------------------
export const FUZZY_HIGH_CONFIDENCE = 0.82;
export const FUZZY_MEDIUM_CONFIDENCE = 0.62;
export const FUZZY_MINIMUM_SCORE = 0.45;
/** Margem mínima entre o 1º e o 2º colocado para permitir auto-resolução em HIGH. */
export const FUZZY_MARGIN_MIN = 0.1;

export type MatchResolver = 'exact' | 'alias' | 'fuzzy';
export type MatchConfidence = 'high' | 'medium' | 'low';

export interface FoodMatchResult {
  resolved: boolean;
  entry?: FoodIndexEntry;
  resolver?: MatchResolver;
  confidence?: MatchConfidence;
  score?: number;
  /** Top-N candidatos (para UI de ambiguidade / telemetria) — nunca exposto ao usuário como está. */
  candidates: CandidateScore[];
}

/**
 * Nome completo OU 1º segmento (antes da vírgula) igual à query — "match
 * forte" pré-existente generalizado. Só conta como EXATO quando há um único
 * candidato: "leite"/"queijo"/"pão" batem o 1º segmento de várias dezenas de
 * itens do catálogo simultaneamente, e escolher UM deles "porque apareceu
 * primeiro" é exatamente a resolução silenciosa e arbitrária que este
 * módulo existe para eliminar — nesses casos cai para o fuzzy, cujo
 * empate de score entre os candidatos aciona a faixa `medium`/confirmação
 * em vez de uma escolha às cegas.
 */
function findExact(qNorm: string, index: FoodIndexEntry[]): FoodIndexEntry | null {
  const matches = index.filter((e) => e.normalizedName === qNorm || e.firstSegment === qNorm);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve uma query de texto livre já normalizável contra o índice do
 * catálogo. Não acessa banco — `index` é fornecido pelo chamador (cache em
 * `nutritionFoodService.ts`).
 */
export function matchFood(query: string, index: FoodIndexEntry[]): FoodMatchResult {
  const qNorm = normalizeFoodText(query);
  if (!qNorm) return { resolved: false, candidates: [] };

  const aliasTarget = FOOD_ALIASES[qNorm];
  if (aliasTarget) {
    const entry = index.find((e) => e.normalizedName === aliasTarget);
    if (entry) {
      return { resolved: true, entry, resolver: 'alias', confidence: 'high', score: 1, candidates: [{ entry, score: 1 }] };
    }
    // Alias configurado mas catálogo não tem mais o alvo (dado mudou) — cai para fuzzy normalmente.
  }

  const exact = findExact(qNorm, index);
  if (exact) {
    return { resolved: true, entry: exact, resolver: 'exact', confidence: 'high', score: 1, candidates: [{ entry: exact, score: 1 }] };
  }

  const top = topCandidates(query, index, 3);
  if (top.length === 0 || top[0].score < FUZZY_MINIMUM_SCORE) {
    return { resolved: false, candidates: top };
  }

  const margin = top[0].score - (top[1]?.score ?? 0);
  const best = top[0];

  if (best.score >= FUZZY_HIGH_CONFIDENCE && margin >= FUZZY_MARGIN_MIN) {
    return { resolved: true, entry: best.entry, resolver: 'fuzzy', confidence: 'high', score: best.score, candidates: top };
  }
  if (best.score >= FUZZY_MEDIUM_CONFIDENCE) {
    return { resolved: true, entry: best.entry, resolver: 'fuzzy', confidence: 'medium', score: best.score, candidates: top };
  }
  return { resolved: true, entry: best.entry, resolver: 'fuzzy', confidence: 'low', score: best.score, candidates: top };
}
