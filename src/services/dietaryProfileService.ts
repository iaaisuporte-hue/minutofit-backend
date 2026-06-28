import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';

// ---------------------------------------------------------------------------
// Perfil Clínico-Nutricional (Spec 019)
// Catálogo padronizado + itens polimórficos por paciente.
// ---------------------------------------------------------------------------

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

const KINDS: DietaryKind[] = [
  'allergy', 'intolerance', 'restriction', 'preference', 'clinical_condition', 'medication',
];
const SEVERITIES: Severity[] = ['mild', 'moderate', 'severe'];
const PREFERENCE_KINDS: PreferenceKind[] = ['like', 'avoid'];

export interface CatalogEntry {
  id: number;
  kind: DietaryKind;
  code: string;
  name: string;
  description: string | null;
}

export interface ProfileItem {
  id: number;
  kind: DietaryKind;
  label: string;
  catalogId: number | null;
  customLabel: string | null;
  severity: Severity | null;
  preferenceKind: PreferenceKind | null;
  notes: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface ProfileItemInput {
  kind: DietaryKind;
  catalogId?: number | null;
  customLabel?: string | null;
  severity?: Severity | null;
  preferenceKind?: PreferenceKind | null;
  notes?: string | null;
  status?: 'active' | 'inactive';
}

export interface DietAlert {
  mealIndex: number;
  level: AlertLevel;
  kind: DietaryKind;
  label: string;
  matchedTerm: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
 * Casa um termo no texto da refeição respeitando fronteira de palavra, para
 * evitar falso-positivo de substring (ex: "sal" dentro de "salada", "ovo" em
 * "novo"). O texto já vem normalizado (ascii lowercase + espaços), então a
 * fronteira por não-alfanumérico é segura inclusive para termos com espaço
 * (ex: "creme de leite").
 */
export function termMatches(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(haystack);
}

/** Nível de alerta proporcional à categoria/severidade. */
function alertLevelFor(kind: DietaryKind, severity: Severity | null, preferenceKind: PreferenceKind | null): AlertLevel | null {
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
// Catálogo
// ---------------------------------------------------------------------------

export async function listCatalog(kind?: string): Promise<CatalogEntry[]> {
  const params: unknown[] = [];
  let where = 'WHERE active = true';
  if (kind && KINDS.includes(kind as DietaryKind)) {
    params.push(kind);
    where += ` AND kind = $1`;
  }
  const { rows } = await pool.query(
    `SELECT id, kind, code, name, description
     FROM dietary_profile_catalog
     ${where}
     ORDER BY kind, name`,
    params,
  );
  return rows as CatalogEntry[];
}

// ---------------------------------------------------------------------------
// Perfil do paciente
// ---------------------------------------------------------------------------

const ITEM_SELECT = `
  SELECT i.id, i.kind,
         COALESCE(c.name, i.custom_label) AS label,
         i.catalog_id AS "catalogId",
         i.custom_label AS "customLabel",
         i.severity, i.preference_kind AS "preferenceKind",
         i.notes, i.status, i.created_at AS "createdAt"
  FROM patient_dietary_profile_items i
  LEFT JOIN dietary_profile_catalog c ON c.id = i.catalog_id
`;

export async function getClinicalProfile(
  patientId: number,
  nutriId: number,
  ip?: string,
): Promise<{ items: ProfileItem[]; hasSevereAllergy: boolean }> {
  const { rows } = await pool.query(
    `${ITEM_SELECT}
     WHERE i.patient_id = $1 AND i.status = 'active'
     ORDER BY i.kind, i.created_at`,
    [patientId],
  );
  const items = rows as ProfileItem[];
  const hasSevereAllergy = items.some((it) => it.kind === 'allergy' && it.severity === 'severe');
  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'nutri.clinical_profile.read',
    ip,
  });
  return { items, hasSevereAllergy };
}

/** Leitura read-only do próprio paciente (lado aluno). Sem auditoria de profissional. */
export async function getProfileForUser(
  userId: number,
): Promise<{ items: ProfileItem[]; hasSevereAllergy: boolean }> {
  const { rows } = await pool.query(
    `${ITEM_SELECT}
     WHERE i.patient_id = $1 AND i.status = 'active'
     ORDER BY i.kind, i.created_at`,
    [userId],
  );
  const items = rows as ProfileItem[];
  const hasSevereAllergy = items.some((it) => it.kind === 'allergy' && it.severity === 'severe');
  return { items, hasSevereAllergy };
}

async function validateAndNormalize(input: ProfileItemInput): Promise<{
  kind: DietaryKind;
  catalogId: number | null;
  customLabel: string | null;
  severity: Severity | null;
  preferenceKind: PreferenceKind | null;
  notes: string | null;
}> {
  const kind = input.kind;
  if (!KINDS.includes(kind)) {
    throw new ValidationError(`Categoria inválida: ${kind}`);
  }

  const hasCatalog = input.catalogId != null;
  const customLabel = typeof input.customLabel === 'string' ? input.customLabel.trim() : '';
  const hasCustom = customLabel.length > 0;

  if (hasCatalog === hasCustom) {
    throw new ValidationError('Envie exatamente um de catalogId ou customLabel.');
  }

  let catalogId: number | null = null;
  if (hasCatalog) {
    const { rows } = await pool.query(
      `SELECT kind FROM dietary_profile_catalog WHERE id = $1 AND active = true`,
      [input.catalogId],
    );
    if (rows.length === 0) {
      throw new ValidationError('Item de catálogo não encontrado.');
    }
    if (rows[0].kind !== kind) {
      throw new ValidationError('Categoria do item não corresponde ao catálogo.');
    }
    catalogId = Number(input.catalogId);
  }

  // Severidade: obrigatória para alergia; opcional para intolerância; ignorada nas demais.
  let severity: Severity | null = null;
  if (input.severity != null) {
    if (!SEVERITIES.includes(input.severity)) {
      throw new ValidationError(`Severidade inválida: ${input.severity}`);
    }
    if (kind === 'allergy' || kind === 'intolerance') {
      severity = input.severity;
    }
  }
  if (kind === 'allergy' && severity == null) {
    throw new ValidationError('Severidade é obrigatória para alergia.');
  }

  // Preferência: tipo obrigatório quando kind = preference.
  let preferenceKind: PreferenceKind | null = null;
  if (kind === 'preference') {
    if (input.preferenceKind == null || !PREFERENCE_KINDS.includes(input.preferenceKind)) {
      throw new ValidationError('preferenceKind (like|avoid) é obrigatório para preferência.');
    }
    preferenceKind = input.preferenceKind;
  }

  const notes = typeof input.notes === 'string' && input.notes.trim()
    ? input.notes.trim().slice(0, 280)
    : null;

  return {
    kind,
    catalogId,
    customLabel: hasCustom ? customLabel.slice(0, 120) : null,
    severity,
    preferenceKind,
    notes,
  };
}

export async function addProfileItem(
  patientId: number,
  createdBy: number,
  academyId: number | null,
  input: ProfileItemInput,
  ip?: string,
): Promise<ProfileItem> {
  const v = await validateAndNormalize(input);
  const { rows } = await pool.query(
    `INSERT INTO patient_dietary_profile_items
       (patient_id, created_by, academy_id, kind, catalog_id, custom_label, severity, preference_kind, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [patientId, createdBy, academyId, v.kind, v.catalogId, v.customLabel, v.severity, v.preferenceKind, v.notes],
  );
  await logDataAccessEvent({
    actorId: createdBy,
    subjectUserId: patientId,
    eventType: 'nutri.clinical_profile.updated',
    eventPayload: { action: 'add', kind: v.kind, itemId: rows[0].id },
    ip,
  });
  return fetchItem(rows[0].id);
}

export async function updateProfileItem(
  patientId: number,
  itemId: number,
  createdBy: number,
  input: ProfileItemInput,
  ip?: string,
): Promise<ProfileItem> {
  // Carrega o item atual para preservar kind/origem quando não enviados.
  const current = await fetchRawItem(patientId, itemId);
  if (!current) {
    throw new ValidationError('Item não encontrado.');
  }
  const merged: ProfileItemInput = {
    kind: input.kind ?? current.kind,
    catalogId: input.catalogId !== undefined ? input.catalogId : current.catalog_id,
    customLabel: input.customLabel !== undefined ? input.customLabel : current.custom_label,
    severity: input.severity !== undefined ? input.severity : current.severity,
    preferenceKind: input.preferenceKind !== undefined ? input.preferenceKind : current.preference_kind,
    notes: input.notes !== undefined ? input.notes : current.notes,
  };
  const v = await validateAndNormalize(merged);
  const status = input.status === 'inactive' || input.status === 'active' ? input.status : current.status;

  await pool.query(
    `UPDATE patient_dietary_profile_items
     SET kind = $1, catalog_id = $2, custom_label = $3, severity = $4,
         preference_kind = $5, notes = $6, status = $7, updated_at = NOW()
     WHERE id = $8 AND patient_id = $9`,
    [v.kind, v.catalogId, v.customLabel, v.severity, v.preferenceKind, v.notes, status, itemId, patientId],
  );
  await logDataAccessEvent({
    actorId: createdBy,
    subjectUserId: patientId,
    eventType: 'nutri.clinical_profile.updated',
    eventPayload: { action: 'update', itemId },
    ip,
  });
  return fetchItem(itemId);
}

export async function deactivateProfileItem(
  patientId: number,
  itemId: number,
  createdBy: number,
  ip?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE patient_dietary_profile_items
     SET status = 'inactive', updated_at = NOW()
     WHERE id = $1 AND patient_id = $2 AND status = 'active'`,
    [itemId, patientId],
  );
  if (rowCount && rowCount > 0) {
    await logDataAccessEvent({
      actorId: createdBy,
      subjectUserId: patientId,
      eventType: 'nutri.clinical_profile.updated',
      eventPayload: { action: 'deactivate', itemId },
      ip,
    });
    return true;
  }
  return false;
}

async function fetchItem(itemId: number): Promise<ProfileItem> {
  const { rows } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [itemId]);
  return rows[0] as ProfileItem;
}

async function fetchRawItem(patientId: number, itemId: number): Promise<{
  kind: DietaryKind; catalog_id: number | null; custom_label: string | null;
  severity: Severity | null; preference_kind: PreferenceKind | null; notes: string | null;
  status: 'active' | 'inactive';
} | null> {
  const { rows } = await pool.query(
    `SELECT kind, catalog_id, custom_label, severity, preference_kind, notes, status
     FROM patient_dietary_profile_items WHERE id = $1 AND patient_id = $2`,
    [itemId, patientId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Checagem de incompatibilidade da dieta contra o perfil (heurística por termos)
// ---------------------------------------------------------------------------

export interface MealForCheck {
  name?: string;
  orientation?: string;
  alternatives?: string[];
}

export async function checkDietAgainstProfile(
  patientId: number,
  meals: MealForCheck[],
): Promise<DietAlert[]> {
  // Itens ativos + termos efetivos (catálogo.match_terms ou o próprio custom_label).
  const { rows } = await pool.query(
    `SELECT i.id, i.kind, i.severity, i.preference_kind,
            COALESCE(c.name, i.custom_label) AS label,
            COALESCE(c.match_terms, i.custom_label) AS match_terms
     FROM patient_dietary_profile_items i
     LEFT JOIN dietary_profile_catalog c ON c.id = i.catalog_id
     WHERE i.patient_id = $1 AND i.status = 'active'`,
    [patientId],
  );

  const profile = rows.map((r) => ({
    kind: r.kind as DietaryKind,
    severity: r.severity as Severity | null,
    preferenceKind: r.preference_kind as PreferenceKind | null,
    label: r.label as string,
    terms: String(r.match_terms || '')
      .split(',')
      .map((t) => normalizeText(t))
      .filter((t) => t.length >= 3), // termos muito curtos geram falso-positivo
  }));

  const alerts: DietAlert[] = [];

  meals.forEach((meal, mealIndex) => {
    const haystack = normalizeText(
      [meal.name || '', meal.orientation || '', ...(meal.alternatives || [])].join(' · '),
    );
    if (!haystack) return;

    for (const item of profile) {
      const level = alertLevelFor(item.kind, item.severity, item.preferenceKind);
      if (!level) continue;
      const matched = item.terms.find((term) => termMatches(haystack, term));
      if (matched) {
        alerts.push({
          mealIndex,
          level,
          kind: item.kind,
          label: item.label,
          matchedTerm: matched,
        });
      }
    }
  });

  return alerts;
}

// ---------------------------------------------------------------------------
// Motor de substituição assistida (Fase 2 · Onda A) — regra-baseado, AI-ready.
// Sem catálogo de alimentos: (1) avalia as alternativas que o NUTRI já cadastrou
// contra o perfil; (2) oferece dicas genéricas de troca por alérgeno/restrição
// via mapa curado em código (Open/Closed — nova categoria não exige nova tabela).
// ---------------------------------------------------------------------------

// Dicas de troca por código de catálogo; fallback por categoria. Texto curto,
// orientativo, nunca prescritivo automático — o nutri decide.
const SWAP_HINTS_BY_CODE: Record<string, string> = {
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

const SWAP_HINTS_BY_KIND: Partial<Record<DietaryKind, string>> = {
  allergy: 'Substituir por alimento sem o alérgeno; confirmar com o paciente',
  intolerance: 'Versão tolerada ou alternativa que evite o componente',
  restriction: 'Trocar pelo equivalente que respeite a restrição',
  clinical_condition: 'Ajustar conforme a condição clínica do paciente',
  preference: 'Oferecer alternativa que o paciente aceite melhor',
  medication: 'Atenção a interações; orientar conforme o medicamento',
};

interface ConflictWithCode extends Omit<DietAlert, 'mealIndex'> {
  code: string | null;
}

export interface SubstitutionSuggestion {
  hasConflict: boolean;
  conflicts: Array<Omit<DietAlert, 'mealIndex'>>;
  alternatives: Array<{ description: string; safe: boolean; conflictLabels: string[] }>;
  swapHints: string[];
}

export async function suggestSubstitutions(
  patientId: number,
  meal: MealForCheck,
): Promise<SubstitutionSuggestion> {
  const { rows } = await pool.query(
    `SELECT i.kind, i.severity, i.preference_kind,
            COALESCE(c.name, i.custom_label) AS label,
            c.code AS code,
            COALESCE(c.match_terms, i.custom_label) AS match_terms
     FROM patient_dietary_profile_items i
     LEFT JOIN dietary_profile_catalog c ON c.id = i.catalog_id
     WHERE i.patient_id = $1 AND i.status = 'active'`,
    [patientId],
  );

  const profile = rows.map((r) => ({
    kind: r.kind as DietaryKind,
    severity: r.severity as Severity | null,
    preferenceKind: r.preference_kind as PreferenceKind | null,
    label: r.label as string,
    code: (r.code as string | null) ?? null,
    terms: String(r.match_terms || '')
      .split(',')
      .map((t) => normalizeText(t))
      .filter((t) => t.length >= 3),
  }));

  const conflictsOf = (text: string): ConflictWithCode[] => {
    const hay = normalizeText(text);
    const out: ConflictWithCode[] = [];
    if (!hay) return out;
    for (const it of profile) {
      const level = alertLevelFor(it.kind, it.severity, it.preferenceKind);
      if (!level) continue;
      const matched = it.terms.find((term) => termMatches(hay, term));
      if (matched) {
        out.push({ level, kind: it.kind, label: it.label, matchedTerm: matched, code: it.code });
      }
    }
    return out;
  };

  const mainConflicts = conflictsOf([meal.name || '', meal.orientation || ''].join(' · '));

  // Avalia as alternativas que o próprio nutri cadastrou: quais são seguras.
  const alternatives = (meal.alternatives || []).map((description) => {
    const conf = conflictsOf(description);
    return {
      description,
      safe: conf.length === 0,
      conflictLabels: Array.from(new Set(conf.map((c) => c.label))),
    };
  });

  // Dicas curadas por conflito (código do catálogo → fallback por categoria).
  const swapHints = Array.from(
    new Set(
      mainConflicts
        .map((c) => (c.code && SWAP_HINTS_BY_CODE[c.code]) || SWAP_HINTS_BY_KIND[c.kind])
        .filter((h): h is string => Boolean(h)),
    ),
  );

  return {
    hasConflict: mainConflicts.length > 0,
    conflicts: mainConflicts.map(({ code: _code, ...rest }) => rest),
    alternatives,
    swapHints,
  };
}
