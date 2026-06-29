import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';
import {
  type DietaryKind,
  type Severity,
  type PreferenceKind,
  type AlertLevel,
  type RawProfileRow,
  type ConsolidatedDietaryProfile,
  DIETARY_KINDS,
  consolidate,
  evaluateConflicts,
  swapHintFor,
} from './dietaryProfileRules';

// ---------------------------------------------------------------------------
// Perfil Clínico-Nutricional (Spec 019 + Onda B)
// Catálogo padronizado + itens polimórficos por paciente.
//
// A INTERPRETAÇÃO (normalização, casamento de termos, nível de alerta,
// consolidação) vive em `dietaryProfileRules.ts` — fonte única. Este service
// cuida de persistência (CRUD) e orquestração, consumindo as regras puras.
// Consumidores que precisam das regras puras importam de `dietaryProfileRules`
// diretamente; do service consomem `getConsolidatedDietaryProfile` (o contrato).
// ---------------------------------------------------------------------------

const KINDS = DIETARY_KINDS;
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
// Carregamento canônico do perfil (projeção de interpretação)
// ---------------------------------------------------------------------------

/**
 * Linhas ativas do perfil com os campos de INTERPRETAÇÃO (code, match_terms) —
 * base do contrato consolidado. A leitura do EDITOR (catalogId/customLabel/
 * status) usa `loadProfileItems` (outra projeção da mesma tabela).
 */
async function loadActiveProfileRows(userId: number): Promise<RawProfileRow[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.kind, i.severity, i.preference_kind,
            COALESCE(c.name, i.custom_label) AS label,
            c.code AS code,
            COALESCE(c.match_terms, i.custom_label) AS match_terms,
            i.notes
     FROM patient_dietary_profile_items i
     LEFT JOIN dietary_profile_catalog c ON c.id = i.catalog_id
     WHERE i.patient_id = $1 AND i.status = 'active'
     ORDER BY i.kind, i.created_at`,
    [userId],
  );
  return rows as RawProfileRow[];
}

/**
 * Contrato CANÔNICO de leitura do Perfil Clínico-Nutricional (Onda B).
 * Fonte única de verdade para qualquer módulo (receitas, lista de compras,
 * montagem de dieta, substituições, recomendações MaaS, IA). Read-only,
 * determinístico e cache-ready (função de `userId`). Multi-tenant: isolado por
 * `userId` — o chamador é responsável pelo gate de consent quando expõe a dado
 * de terceiro (ver `requireActiveConsent('clinical_nutrition')` nas rotas nutri).
 */
export async function getConsolidatedDietaryProfile(userId: number): Promise<ConsolidatedDietaryProfile> {
  const rows = await loadActiveProfileRows(userId);
  return consolidate(userId, rows, new Date().toISOString());
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

/** Itens ativos do perfil na projeção do EDITOR (ProfileItem). Caminho único de leitura de display. */
async function loadProfileItems(userId: number): Promise<{ items: ProfileItem[]; hasSevereAllergy: boolean }> {
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

/** Leitura do perfil pelo nutri — registra acesso na auditoria. */
export async function getClinicalProfile(
  patientId: number,
  nutriId: number,
  ip?: string,
): Promise<{ items: ProfileItem[]; hasSevereAllergy: boolean }> {
  const result = await loadProfileItems(patientId);
  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'nutri.clinical_profile.read',
    ip,
  });
  return result;
}

/** Leitura read-only do próprio usuário (lado aluno). Sem auditoria de profissional. */
export async function getProfileForUser(
  userId: number,
): Promise<{ items: ProfileItem[]; hasSevereAllergy: boolean }> {
  return loadProfileItems(userId);
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
  // Consome o contrato canônico + a avaliação de conflitos centralizada (rules).
  const profile = await getConsolidatedDietaryProfile(patientId);
  const alerts: DietAlert[] = [];
  meals.forEach((meal, mealIndex) => {
    const text = [meal.name || '', meal.orientation || '', ...(meal.alternatives || [])].join(' · ');
    for (const c of evaluateConflicts(profile, text)) {
      alerts.push({ mealIndex, level: c.level, kind: c.kind, label: c.label, matchedTerm: c.matchedTerm });
    }
  });
  return alerts;
}

// ---------------------------------------------------------------------------
// Motor de substituição assistida (Fase 2 · Onda A) — regra-baseado, AI-ready.
// Avalia as alternativas que o NUTRI já cadastrou e sugere dicas de troca; toda
// a interpretação (conflito, severidade, dicas) vem de `dietaryProfileRules`.
// ---------------------------------------------------------------------------

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
  const profile = await getConsolidatedDietaryProfile(patientId);
  const mainConflicts = evaluateConflicts(profile, [meal.name || '', meal.orientation || ''].join(' · '));

  // Avalia as alternativas que o próprio nutri cadastrou: quais são seguras.
  const alternatives = (meal.alternatives || []).map((description) => {
    const conf = evaluateConflicts(profile, description);
    return {
      description,
      safe: conf.length === 0,
      conflictLabels: Array.from(new Set(conf.map((c) => c.label))),
    };
  });

  const swapHints = Array.from(
    new Set(mainConflicts.map(swapHintFor).filter((h): h is string => Boolean(h))),
  );

  return {
    hasConflict: mainConflicts.length > 0,
    conflicts: mainConflicts.map((c) => ({ level: c.level, kind: c.kind, label: c.label, matchedTerm: c.matchedTerm })),
    alternatives,
    swapHints,
  };
}
