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
 */
export function termMatches(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(haystack);
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

/** Conflitos entre um texto livre (refeição/alternativa) e o perfil consolidado. */
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
    const matched = e.avoidTerms.find((term) => termMatches(haystack, term));
    if (matched) {
      out.push({ level, kind: e.kind, label: e.label, code: e.code, matchedTerm: matched });
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
