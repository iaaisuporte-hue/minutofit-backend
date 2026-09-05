/**
 * Regras de domínio do Perfil Clínico-Nutricional (Fase 2 · Onda B).
 *
 * Módulo PURO — sem acesso a banco, sem efeitos colaterais. É a ÚNICA fonte de
 * verdade da *interpretação* de alergias, intolerâncias, restrições e
 * preferências: normalização de texto, casamento de termos, nível de alerta,
 * consolidação do perfil e derivação de flags. Qualquer módulo (receitas, lista
 * de compras, montagem de dieta, substituições, recomendações MaaS, IA) deve
 * consumir estas regras — nunca reimplementar.
 *
 * Por ser puro e determinístico, é trivial de testar (jest), cachear (função de
 * `(rows, generatedAt)`) e servir de base para IA posterior.
 */

export type DietaryKind =
  | 'allergy'
  | 'intolerance'
  | 'restriction'
  | 'preference'
  | 'clinical_condition'
  | 'medication';

export type Severity = 'mild' | 'moderate' | 'severe';
export type PreferenceKind = 'like' | 'avoid';
export type AlertLevel = 'strong' | 'moderate' | 'info' | 'suggestion';

export const DIETARY_KINDS: DietaryKind[] = [
  'allergy', 'intolerance', 'restriction', 'preference', 'clinical_condition', 'medication',
];

/** Linha crua do perfil (vinda do banco); única dependência de formato. */
export interface RawProfileRow {
  id: number;
  kind: DietaryKind;
  severity: Severity | null;
  preference_kind: PreferenceKind | null;
  label: string;
  code: string | null;        // código do catálogo (identificador estável p/ consumidores/IA)
  match_terms: string | null; // csv de termos (catálogo) ou custom_label
  notes: string | null;
}

/** Entrada consolidada — modelo de domínio que os consumidores enxergam. */
export interface ConsolidatedProfileEntry {
  id: number;
  kind: DietaryKind;
  label: string;
  code: string | null;
  severity: Severity | null;
  preferenceKind: PreferenceKind | null;
  notes: string | null;
  /** Termos normalizados a evitar (vazio p/ categorias não-evitação como 'like'). */
  avoidTerms: string[];
}

export interface DietaryProfileFlags {
  hasSevereAllergy: boolean;
  isVegan: boolean;
  isVegetarian: boolean;
  isGlutenFree: boolean;
  isLactoseFree: boolean;
  hasClinicalConditions: boolean;
  hasMedications: boolean;
  total: number;
}

/** Perfil consolidado — contrato único de leitura para todo o ecossistema. */
export interface ConsolidatedDietaryProfile {
  userId: number;
  entries: ConsolidatedProfileEntry[];
  byKind: Record<DietaryKind, ConsolidatedProfileEntry[]>;
  flags: DietaryProfileFlags;
  generatedAt: string; // ISO — âncora p/ cache/TTL futuro
}

/** Conflito detectado entre um texto (refeição) e o perfil. */
export interface ProfileConflict {
  level: AlertLevel;
  kind: DietaryKind;
  label: string;
  code: string | null;
  matchedTerm: string;
}

// ---------------------------------------------------------------------------
// Primitivas de texto
// ---------------------------------------------------------------------------

/** lowercase + remove acentos para casamento robusto de termos. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Casa um termo respeitando fronteira de palavra (evita "sal" em "salada",
 * "ovo" em "novo"). `haystack` já deve vir normalizado.
 *
 * SPEC 035 / NUTRI-06: mantido para compatibilidade (não usado mais por
 * `evaluateConflicts`, que precisa de ÍNDICE do match para negação/composto
 * — ver `findTermHits`). Casamento LITERAL, sem tolerância a plural.
 */
export function termMatches(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(haystack);
}

/**
 * Variantes plurais aproximadas de um termo SINGULAR em PT-BR (SPEC 035 /
 * NUTRI-06). Não é um lematizador completo — é a regra prática que cobre os
 * casos de alimento mais comuns ("ovo"→"ovos", "pão"→"pães", "sal"→"sais"),
 * suficiente porque o catálogo é curado (46 itens) e o objetivo é reduzir
 * falso-negativo de segurança alimentar, não fazer linguística geral.
 * Termos com espaço (ex.: "creme de leite") não recebem variante — a
 * pluralização de composto nominal PT-BR não segue um padrão único, e
 * multiplicar tentativas erradas custaria mais em falso-positivo do que
 * ganharia em cobertura.
 */
function pluralVariants(term: string): string[] {
  if (term.includes(' ') || term.length < MIN_TERM_LEN) return [term];
  if (term.endsWith('ao')) {
    const stem = term.slice(0, -2);
    return [term, `${stem}oes`, `${stem}aes`, `${stem}aos`];
  }
  if (term.endsWith('l') && term.length > 2) {
    return [term, `${term.slice(0, -1)}is`];
  }
  if (/[aeiou]$/.test(term)) {
    return [term, `${term}s`];
  }
  return [term, `${term}es`];
}

interface TermHit {
  index: number;
  length: number;
}

/**
 * Encontra TODAS as ocorrências de um termo (já tolerando plural) no texto,
 * com posição — negação e composto nominal precisam saber ONDE o termo
 * apareceu, não só SE apareceu (SPEC 035 / NUTRI-06/NUTRI-21).
 */
function findTermHits(haystack: string, term: string): TermHit[] {
  const variants = pluralVariants(term);
  const escaped = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?:^|[^a-z0-9])(${escaped.join('|')})(?=[^a-z0-9]|$)`, 'g');
  const hits: TermHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack))) {
    const matchedText = m[1];
    const start = m.index + (m[0].length - matchedText.length);
    hits.push({ index: start, length: matchedText.length });
    if (re.lastIndex === m.index) re.lastIndex += 1; // evita loop infinito em match vazio
  }
  return hits;
}

/**
 * Marcadores de negação, em PT-BR normalizado (sem acento). Janela de até 2
 * palavras entre o marcador e o termo cobre "sem adição de açúcar", "isento
 * de lactose", "livre de glúten" — sem exigir que o marcador seja a palavra
 * imediatamente anterior (SPEC 035 / NUTRI-21).
 */
const NEGATION_BEFORE_RE = /\b(?:sem|zero|isent[oa]s?|livre|nao)\b(?:\s+\S+){0,2}\s*$/;

function isNegatedAt(haystack: string, index: number): boolean {
  const windowStart = Math.max(0, index - 40);
  return NEGATION_BEFORE_RE.test(haystack.slice(windowStart, index));
}

/**
 * Compostos nominais que usam a mesma palavra do alérgeno/restrição mas NÃO
 * são o alimento de origem animal/glúten em questão — "leite de coco" não é
 * leite de vaca, "carne de soja" não é carne (SPEC 035 / NUTRI-21). Lista
 * deliberadamente pequena e documentada — não é um dicionário completo, é a
 * defesa contra os casos que a P0 encontrou de verdade. Ampliar conforme
 * novos falso-positivos aparecerem em uso real.
 */
const COMPOUND_EXCLUSION_QUALIFIERS: Record<string, string[]> = {
  leite: ['coco', 'amendoa', 'amendoas', 'soja', 'aveia', 'arroz', 'castanha', 'castanhas', 'alpiste'],
  manteiga: ['amendoim', 'amendoins', 'cacau', 'coco', 'girassol'],
  creme: ['coco', 'arroz'],
  carne: ['soja'],
};

function isExcludedCompoundAt(haystack: string, index: number, length: number, term: string): boolean {
  const qualifiers = COMPOUND_EXCLUSION_QUALIFIERS[term];
  if (!qualifiers) return false;
  const after = haystack.slice(index + length, index + length + 30);
  const m = /^\s*(?:de\s+)?([a-z0-9]+)/.exec(after);
  return !!m && qualifiers.includes(m[1]);
}

const MIN_TERM_LEN = 3; // termos < 3 chars geram falso-positivo

/** Termos normalizados de um csv, filtrando ruído. */
export function parseTerms(matchTerms: string | null): string[] {
  return String(matchTerms || '')
    .split(',')
    .map((t) => normalizeText(t))
    .filter((t) => t.length >= MIN_TERM_LEN);
}

// ---------------------------------------------------------------------------
// Regra de severidade do alerta — ÚNICA definição
// ---------------------------------------------------------------------------

/** Nível de alerta proporcional à categoria/severidade. `null` = não alerta. */
export function alertLevelFor(
  kind: DietaryKind,
  severity: Severity | null,
  preferenceKind: PreferenceKind | null,
): AlertLevel | null {
  switch (kind) {
    case 'allergy':
      return 'strong'; // alergia sempre forte; severe reforça no front
    case 'intolerance':
      return severity === 'severe' ? 'strong' : 'moderate';
    case 'restriction':
    case 'clinical_condition':
    case 'medication':
      return 'info';
    case 'preference':
      return preferenceKind === 'avoid' ? 'suggestion' : null; // "like" não alerta
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Consolidação — transforma linhas cruas no modelo de domínio
// ---------------------------------------------------------------------------

function emptyByKind(): Record<DietaryKind, ConsolidatedProfileEntry[]> {
  return {
    allergy: [], intolerance: [], restriction: [],
    preference: [], clinical_condition: [], medication: [],
  };
}

export function consolidate(
  userId: number,
  rows: RawProfileRow[],
  generatedAt: string,
): ConsolidatedDietaryProfile {
  const entries: ConsolidatedProfileEntry[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    code: r.code,
    severity: r.severity,
    preferenceKind: r.preference_kind,
    notes: r.notes,
    // "like" é apreço, não evitação → sem termos de conflito.
    avoidTerms: r.kind === 'preference' && r.preference_kind === 'like' ? [] : parseTerms(r.match_terms),
  }));

  const byKind = emptyByKind();
  for (const e of entries) byKind[e.kind].push(e);

  const hasCode = (kind: DietaryKind, code: string) =>
    byKind[kind].some((e) => e.code === code);

  const flags: DietaryProfileFlags = {
    hasSevereAllergy: byKind.allergy.some((e) => e.severity === 'severe'),
    isVegan: hasCode('restriction', 'vegan'),
    isVegetarian: hasCode('restriction', 'vegan') || hasCode('restriction', 'vegetarian'),
    isGlutenFree:
      hasCode('restriction', 'gluten_free') ||
      hasCode('allergy', 'wheat') ||
      hasCode('intolerance', 'gluten') ||
      hasCode('clinical_condition', 'celiac'),
    isLactoseFree:
      hasCode('restriction', 'lactose_free') ||
      hasCode('allergy', 'milk') ||
      hasCode('intolerance', 'lactose'),
    hasClinicalConditions: byKind.clinical_condition.length > 0,
    hasMedications: byKind.medication.length > 0,
    total: entries.length,
  };

  return { userId, entries, byKind, flags, generatedAt };
}

// ---------------------------------------------------------------------------
// Avaliação de conflitos — ÚNICA implementação usada por check/suggest/IA
// ---------------------------------------------------------------------------

/**
 * Conflitos entre um texto livre (refeição/alternativa) e o perfil
 * consolidado (SPEC 035 / NUTRI-06 e NUTRI-21).
 *
 * Antes: `termMatches` era um `.test()` — só dizia SE o termo aparecia, sem
 * tolerar plural ("queijos" não casava com o termo "queijo" do catálogo) e
 * sem distinguir "leite de coco" de "leite" de vaca. Agora cada termo pode
 * ter VÁRIAS ocorrências no texto; uma ocorrência só conta como conflito se
 * NÃO estiver negada ("sem lactose") nem for um composto nominal que
 * exclui o alérgeno ("leite de amêndoas"). Basta UMA ocorrência genuína
 * para alertar — o texto pode mencionar o mesmo termo negado em um lugar e
 * de verdade em outro.
 */
export function evaluateConflicts(
  profile: ConsolidatedDietaryProfile,
  text: string,
): ProfileConflict[] {
  const haystack = normalizeText(text);
  if (!haystack) return [];
  const out: ProfileConflict[] = [];
  for (const e of profile.entries) {
    const level = alertLevelFor(e.kind, e.severity, e.preferenceKind);
    if (!level || e.avoidTerms.length === 0) continue;

    let matchedTerm: string | null = null;
    for (const term of e.avoidTerms) {
      const hits = findTermHits(haystack, term);
      const genuine = hits.find(
        (h) => !isNegatedAt(haystack, h.index) && !isExcludedCompoundAt(haystack, h.index, h.length, term)
      );
      if (genuine) {
        matchedTerm = term;
        break;
      }
    }
    if (matchedTerm) {
      out.push({ level, kind: e.kind, label: e.label, code: e.code, matchedTerm });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dicas curadas de troca — por código de catálogo, fallback por categoria.
// (Onda A) Mantidas aqui por serem regra de domínio; Open/Closed.
// ---------------------------------------------------------------------------

export const SWAP_HINTS_BY_CODE: Record<string, string> = {
  milk: 'Bebida vegetal (amêndoas, aveia, coco, arroz) ou versão sem lactose',
  lactose: 'Versões sem lactose ou bebidas vegetais',
  egg: 'Tofu mexido, grão-de-bico ou substituto de ovo em receitas',
  peanut: 'Sementes (girassol, abóbora), se não houver alergia cruzada',
  tree_nuts: 'Sementes (girassol, abóbora) no lugar de oleaginosas',
  soy: 'Proteína de ervilha ou grão-de-bico no lugar da soja',
  wheat: 'Farinhas sem glúten (arroz, mandioca, milho, aveia certificada)',
  gluten: 'Opções sem glúten: arroz, milho, mandioca, quinoa',
  fish: 'Outra proteína conforme tolerância (frango, ovo, leguminosas)',
  shellfish: 'Outra proteína conforme tolerância (frango, ovo, leguminosas)',
  sesame: 'Evitar gergelim/tahine; usar pasta de girassol',
  vegan: 'Proteína vegetal: tofu, tempeh, PTS, grão-de-bico, lentilha',
  vegetarian: 'Proteína vegetal ou ovo/laticínio conforme aceitação',
  gluten_free: 'Substituir por arroz, batata, mandioca, quinoa',
  lactose_free: 'Bebidas vegetais ou laticínios sem lactose',
  hypertension: 'Reduzir sal/sódio; temperar com ervas e especiarias',
  diabetes_t2: 'Carboidratos integrais de baixo índice glicêmico; controlar porção',
  diabetes_t1: 'Carboidratos integrais; ajustar conforme contagem',
  celiac: 'Alimentos naturalmente sem glúten; atenção à contaminação cruzada',
  gout: 'Reduzir carne vermelha, vísceras, frutos do mar e álcool',
};

export const SWAP_HINTS_BY_KIND: Partial<Record<DietaryKind, string>> = {
  allergy: 'Substituir por alimento sem o alérgeno; confirmar com o paciente',
  intolerance: 'Versão tolerada ou alternativa que evite o componente',
  restriction: 'Trocar pelo equivalente que respeite a restrição',
  clinical_condition: 'Ajustar conforme a condição clínica do paciente',
  preference: 'Oferecer alternativa que o paciente aceite melhor',
  medication: 'Atenção a interações; orientar conforme o medicamento',
};

/** Dica de troca para um conflito (código → fallback por categoria). */
export function swapHintFor(conflict: ProfileConflict): string | null {
  return (conflict.code && SWAP_HINTS_BY_CODE[conflict.code]) || SWAP_HINTS_BY_KIND[conflict.kind] || null;
}
