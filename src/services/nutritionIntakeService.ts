/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B) — resolução do texto/refeição contra o
 * catálogo (SPEC 038) + persistência do registro. Regras de segurança que
 * este módulo protege:
 *
 * 1. Nenhum item NÃO RESOLVIDO chega a ser persistido — `persistIntakeLog`
 *    rejeita (lança `ValidationError`) antes de tocar o banco.
 * 2. Nenhum item de baixa confiança é persistido sem `confirmed:true` — e a
 *    confiança nunca é a que o cliente alega: quando o item veio de texto
 *    livre (`rawText` presente), o servidor RE-CALCULA a confiança a partir
 *    do próprio texto + do alimento escolhido, nunca aceitando o rótulo do
 *    cliente como verdade.
 * 3. `energyKcal/proteinG/carbohydrateG/fatG` de item de catálogo são SEMPRE
 *    recalculados a partir do per-100g atual do alimento (nunca do que o
 *    cliente mandou) — mesma disciplina de `nutritionCalculation.ts`
 *    (SPEC 038). Só o item `manual` é uma afirmação direta do usuário.
 * 4. `confidence_score` do log é SEMPRE derivado no servidor a partir dos
 *    pesos do resolver — nunca aceito do cliente.
 */
import pool from '../config/database';
import { dayKey } from '../utils/appDay';
import { parseIntakeText, type ParsedIntakeToken } from './nutritionIntakeParser';
import { calculateNutrition, sumNutrients, type NutrientsPer100g } from './nutritionCalculation';
import { getCatalogFoodById, listCatalogFoodMeasures, getFoodIndex, type FoodSummary, type FoodMeasure } from './nutritionFoodService';
import { matchFood, normalizeFoodText, type MatchConfidence } from './nutritionFoodMatcher';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Medidas caseiras sem correspondência cadastrada no catálogo (PLAN §10). */
export const FALLBACK_MEASURES_G: Record<string, number> = {
  colher_sopa: 15,
  colher_cha: 5,
  xicara: 120,
  copo: 200,
  concha: 80,
  fatia: 25,
};

/**
 * Fallback por contagem de alimento quando não há palavra de medida
 * ("2 ovos", "1 pão francês") — chave é a 1ª palavra da query já
 * normalizada. `pao: 50` cobre a família pão francês/pãozinho (unidade
 * padrão ~50g, mesma convenção já usada para `ovo`); não se aplica a pão de
 * forma/pão integral em fatia — esses exigem palavra de medida própria
 * ("1 fatia") e não caem neste fallback.
 */
export const FALLBACK_UNIT_FOOD_G: Record<string, number> = {
  ovo: 50,
  pao: 50,
};

/** Peso de cada resolver no `confidence_score` do log (PLAN §8). */
export const RESOLVER_WEIGHT: Record<'catalog' | 'measure' | 'manual' | 'plan' | 'ai', number> = {
  catalog: 1,
  measure: 1,
  plan: 1,
  manual: 0.8,
  ai: 0.7,
};

export type IntakeItemResolver = 'catalog' | 'measure' | 'manual' | 'plan';
/**
 * `medium` é nova (PLAN P1B corrective §8/§9) — fuzzy match plausível mas
 * não certo o bastante para entrar sem confirmação ("você quis dizer?").
 * Tratada como `low` para efeito de persistência: ambas exigem
 * `confirmed:true` (ver `resolveFoodItem`); a diferença é só de UX/telemetria.
 */
export type IntakeConfidence = MatchConfidence;

export interface IntakePreviewItem {
  resolved: boolean;
  rawText: string;
  foodQuery: string;
  foodId?: number;
  name?: string;
  grams?: number;
  measureId?: number | null;
  fallbackMeasureKey?: string | null;
  per100g?: { kcal: number; p: number; c: number; f: number };
  energyKcal?: number;
  proteinG?: number;
  carbohydrateG?: number;
  fatG?: number;
  resolver?: IntakeItemResolver;
  confidence?: IntakeConfidence;
  confirmed?: boolean;
  /** Top candidato(s) do fuzzy match — só populado quando `confidence` é `medium`/`low` (PLAN §14: UI "você quis dizer?", nunca detalhe técnico). */
  matchScore?: number;
}

function toPer100g(food: FoodSummary): NutrientsPer100g {
  return {
    energyKcal: food.energyKcal,
    proteinG: food.proteinG,
    carbohydrateG: food.carbohydrateG,
    fatG: food.fatG,
    fiberG: food.fiberG,
    sodiumMg: food.sodiumMg,
  };
}

/** Medida DB cujo nome normalizado contém as palavras esperadas do alias canônico. */
const MEASURE_WORDS: Record<string, string[]> = {
  colher_sopa: ['colher', 'sopa'],
  colher_cha: ['colher', 'cha'],
  xicara: ['xicara'],
  copo: ['copo'],
  concha: ['concha'],
  fatia: ['fatia'],
  unidade: ['unidade'],
};

function findDbMeasure(measures: FoodMeasure[], canonical: string): FoodMeasure | null {
  const words = MEASURE_WORDS[canonical] ?? [canonical];
  return measures.find((m) => {
    const n = normalizeFoodText(m.name);
    return words.every((w) => n.includes(w));
  }) ?? null;
}

/**
 * Resolve o alimento de um token do parser contra o catálogo (PLAN P1B
 * corrective) — pipeline alias → exato → fuzzy por token, sobre o índice em
 * memória (`nutritionFoodMatcher.matchFood`), no lugar do antigo ILIKE
 * substring-contíguo (que falhava sempre que uma palavra do TACO se
 * intercalava entre os termos do usuário — "pao frances" nunca batia em
 * "pao TRIGO frances"). Retorna o alimento completo (com macros) já
 * carregado, ou `null` quando nenhum candidato plausível existe.
 */
async function resolveFoodForQuery(foodQuery: string): Promise<{ food: FoodSummary; resolver: IntakeItemResolver; confidence: IntakeConfidence; score: number } | null> {
  const index = await getFoodIndex();
  const match = matchFood(foodQuery, index);
  if (!match.resolved || !match.entry) return null;
  const food = await getCatalogFoodById(match.entry.id);
  if (!food) return null;
  return { food, resolver: 'catalog', confidence: match.confidence!, score: match.score ?? 0 };
}

/** Resolve um token do parser contra o catálogo — usado pelo preview (`/parse`). */
export async function resolveTokenForPreview(token: ParsedIntakeToken): Promise<IntakePreviewItem> {
  const resolution = await resolveFoodForQuery(token.foodQuery);
  if (!resolution) {
    return { resolved: false, rawText: token.rawText, foodQuery: token.foodQuery };
  }
  const { food: best, confidence, score } = resolution;

  let grams: number | null = null;
  let measureId: number | null = null;
  let fallbackMeasureKey: string | null = null;

  if (token.unitType === 'grams') {
    grams = token.quantity;
  } else {
    const canonical = token.measureName ?? 'unidade';
    const dbMeasures = await listCatalogFoodMeasures(best.id);
    const dbMatch = findDbMeasure(dbMeasures, canonical);
    if (dbMatch) {
      grams = token.quantity * dbMatch.grams;
      measureId = dbMatch.id;
    } else if (token.measureName && FALLBACK_MEASURES_G[token.measureName]) {
      grams = token.quantity * FALLBACK_MEASURES_G[token.measureName];
      fallbackMeasureKey = token.measureName;
    } else if (!token.measureName) {
      const foodHead = token.foodQuery.split(' ')[0];
      if (FALLBACK_UNIT_FOOD_G[foodHead]) {
        grams = token.quantity * FALLBACK_UNIT_FOOD_G[foodHead];
        fallbackMeasureKey = foodHead;
      }
    }
  }

  if (grams == null || grams <= 0) {
    return { resolved: false, rawText: token.rawText, foodQuery: token.foodQuery };
  }

  const per100g = toPer100g(best);
  const calc = calculateNutrition(per100g, grams);

  return {
    resolved: true,
    rawText: token.rawText,
    foodQuery: token.foodQuery,
    foodId: best.id,
    name: best.name,
    grams,
    measureId,
    fallbackMeasureKey,
    per100g: { kcal: per100g.energyKcal, p: per100g.proteinG, c: per100g.carbohydrateG, f: per100g.fatG },
    energyKcal: calc.energyKcal,
    proteinG: calc.proteinG,
    carbohydrateG: calc.carbohydrateG,
    fatG: calc.fatG,
    resolver: token.unitType === 'grams' ? 'catalog' : 'measure',
    confidence,
    confirmed: confidence === 'high',
    matchScore: confidence === 'high' && score === 1 ? undefined : score,
  };
}

export interface ParsedPreview {
  items: IntakePreviewItem[];
  totals: ReturnType<typeof sumNutrients>;
  needsConfirmation: boolean;
}

export async function parseAndResolve(text: string): Promise<ParsedPreview> {
  const tokens = parseIntakeText(text);
  const items = await Promise.all(tokens.map(resolveTokenForPreview));
  const resolvedCalcs = items
    .filter((i) => i.resolved)
    .map((i) => ({
      energyKcal: i.energyKcal!, proteinG: i.proteinG!, carbohydrateG: i.carbohydrateG!, fatG: i.fatG!,
      fiberG: null, sodiumMg: null,
    }));
  return {
    items,
    totals: sumNutrients(resolvedCalcs),
    needsConfirmation: items.some((i) => !i.resolved || (i.confidence !== 'high' && !i.confirmed)),
  };
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

export type IntakeItemRequest =
  | {
      kind: 'food';
      foodId: number;
      quantity: number;
      unitType: 'grams' | 'measure';
      measureId?: number | null;
      fallbackMeasureKey?: string | null;
      /** Presente só quando o item nasceu de texto livre — dispara re-checagem de confiança no servidor. */
      rawText?: string | null;
      confirmed?: boolean;
    }
  | {
      kind: 'manual';
      name: string;
      grams?: number | null;
      energyKcal: number;
      proteinG: number;
      carbohydrateG: number;
      fatG: number;
    }
  | {
      kind: 'plan';
      planMealItemId: number;
    };

export interface PersistedIntakeItem {
  foodId?: number;
  name: string;
  grams: number | null;
  per100g?: { kcal: number; p: number; c: number; f: number };
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  /** null quando o alimento/medição não tem fibra conhecida — nunca 0 fabricado (PLAN §11). */
  fiberG: number | null;
  resolver: IntakeItemResolver;
  confidence: IntakeConfidence;
  confirmed: boolean;
}

const MANUAL_ITEM_KCAL_MAX = 3000;

/**
 * Re-deriva a confiança de um item de catálogo escolhido a partir de texto
 * livre — NUNCA aceita o rótulo de confiança que o cliente mandou. Item
 * escolhido por busca explícita (sem `rawText`) é sempre `high`: não há
 * ambiguidade de parser a reconfirmar quando o próprio usuário apontou o
 * alimento na lista. Quando há `rawText`, roda o MESMO matcher do preview
 * (`resolveFoodForQuery`) — se o alimento escolhido não é o que o matcher
 * também escolheria, ou a confiança dele não é `high`, trata como `low`
 * (nunca confia que o cliente "só confirmou o que já era certo").
 */
async function deriveFoodConfidence(rawText: string | null | undefined, foodId: number): Promise<IntakeConfidence> {
  if (!rawText) return 'high';
  const [token] = parseIntakeText(rawText);
  if (!token) return 'low';
  const resolution = await resolveFoodForQuery(token.foodQuery);
  if (!resolution || resolution.food.id !== foodId) return 'low';
  return resolution.confidence;
}

async function resolveFoodItem(item: Extract<IntakeItemRequest, { kind: 'food' }>): Promise<PersistedIntakeItem> {
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new ValidationError('invalid_quantity');
  const food = await getCatalogFoodById(item.foodId);
  if (!food) throw new ValidationError('food_not_found');

  let grams: number;
  let resolver: IntakeItemResolver;
  if (item.unitType === 'grams') {
    grams = item.quantity;
    resolver = 'catalog';
  } else {
    resolver = 'measure';
    if (item.measureId != null) {
      const measures = await listCatalogFoodMeasures(item.foodId);
      const measure = measures.find((m) => m.id === item.measureId);
      if (!measure) throw new ValidationError('measure_not_found_for_food');
      grams = item.quantity * measure.grams;
    } else if (item.fallbackMeasureKey && FALLBACK_MEASURES_G[item.fallbackMeasureKey] != null) {
      grams = item.quantity * FALLBACK_MEASURES_G[item.fallbackMeasureKey];
    } else if (item.fallbackMeasureKey && FALLBACK_UNIT_FOOD_G[item.fallbackMeasureKey] != null) {
      grams = item.quantity * FALLBACK_UNIT_FOOD_G[item.fallbackMeasureKey];
    } else {
      throw new ValidationError('measure_required');
    }
  }
  if (grams <= 0) throw new ValidationError('invalid_grams');

  const confidence = await deriveFoodConfidence(item.rawText, food.id);
  if (confidence !== 'high' && !item.confirmed) {
    throw new ValidationError('low_confidence_item_needs_confirmation');
  }

  const per100g = toPer100g(food);
  const calc = calculateNutrition(per100g, grams);
  return {
    foodId: food.id,
    name: food.name,
    grams,
    per100g: { kcal: per100g.energyKcal, p: per100g.proteinG, c: per100g.carbohydrateG, f: per100g.fatG },
    energyKcal: calc.energyKcal,
    proteinG: calc.proteinG,
    carbohydrateG: calc.carbohydrateG,
    fatG: calc.fatG,
    fiberG: calc.fiberG,
    resolver,
    confidence,
    confirmed: true,
  };
}

function resolveManualItem(item: Extract<IntakeItemRequest, { kind: 'manual' }>): PersistedIntakeItem {
  const name = item.name?.trim();
  if (!name) throw new ValidationError('manual_name_required');
  const nums = [item.energyKcal, item.proteinG, item.carbohydrateG, item.fatG];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
    throw new ValidationError('invalid_manual_macros');
  }
  if (item.energyKcal > MANUAL_ITEM_KCAL_MAX) throw new ValidationError('manual_kcal_too_high');
  return {
    name,
    grams: item.grams != null && item.grams > 0 ? item.grams : null,
    energyKcal: item.energyKcal,
    proteinG: item.proteinG,
    carbohydrateG: item.carbohydrateG,
    fatG: item.fatG,
    // Item manual não tem como o usuário informar fibra separadamente hoje —
    // `null` (não conhecida), nunca 0 (que afirmaria "sem fibra").
    fiberG: null,
    resolver: 'manual',
    confidence: 'high',
    confirmed: true,
  };
}

async function resolvePlanItem(userId: number, item: Extract<IntakeItemRequest, { kind: 'plan' }>): Promise<PersistedIntakeItem> {
  // IDOR: só pode copiar item de refeição de um plano do PRÓPRIO usuário.
  const { rows } = await pool.query(
    `SELECT nmi.food_name_snapshot, nmi.energy_kcal_snapshot, nmi.protein_g_snapshot,
            nmi.carbohydrate_g_snapshot, nmi.fat_g_snapshot, nmi.fiber_g_snapshot, nmi.grams
       FROM nutrition_meal_items nmi
       JOIN nutrition_plan_meals npm ON npm.id = nmi.meal_id
       JOIN nutrition_plans np ON np.id = npm.plan_id
      WHERE nmi.id = $1 AND nmi.deleted_at IS NULL AND np.patient_id = $2`,
    [item.planMealItemId, userId]
  );
  if (rows.length === 0) throw new ValidationError('plan_meal_item_not_found');
  const row = rows[0];
  return {
    name: row.food_name_snapshot,
    grams: Number(row.grams),
    energyKcal: Number(row.energy_kcal_snapshot),
    proteinG: Number(row.protein_g_snapshot),
    carbohydrateG: Number(row.carbohydrate_g_snapshot),
    fatG: Number(row.fat_g_snapshot),
    fiberG: row.fiber_g_snapshot == null ? null : Number(row.fiber_g_snapshot),
    resolver: 'plan',
    confidence: 'high',
    confirmed: true,
  };
}

export interface IntakeLogInput {
  userId: number;
  label: string;
  rawText?: string | null;
  mealId?: number | null;
  items: IntakeItemRequest[];
  source: 'parse' | 'parse_ai' | 'manual' | 'repeat' | 'favorite' | 'plan';
}

export interface IntakeLogRecord {
  id: number;
  dateKey: string;
  loggedAt: string;
  mealId: number | null;
  label: string;
  rawText: string | null;
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  /** null quando NENHUM item do log tinha fibra conhecida (PLAN §11) — nunca 0 fabricado. */
  fiberG: number | null;
  /** true quando ALGUM item do log não tinha fibra conhecida — `fiberG` é uma soma parcial. */
  fiberPartial: boolean;
  items: PersistedIntakeItem[];
  confidenceScore: number;
  source: string;
  isFavorite: boolean;
}

function mapRow(r: any): IntakeLogRecord {
  return {
    id: r.id,
    dateKey: r.date_key instanceof Date ? r.date_key.toISOString().slice(0, 10) : r.date_key,
    loggedAt: r.logged_at,
    mealId: r.meal_id,
    label: r.label,
    rawText: r.raw_text,
    energyKcal: Number(r.energy_kcal),
    proteinG: Number(r.protein_g),
    carbohydrateG: Number(r.carbohydrate_g),
    fatG: Number(r.fat_g),
    fiberG: r.fiber_g == null ? null : Number(r.fiber_g),
    fiberPartial: Boolean(r.fiber_partial),
    items: r.items,
    confidenceScore: Number(r.confidence_score),
    source: r.source,
    isFavorite: r.is_favorite,
  };
}

export async function persistIntakeLog(input: IntakeLogInput): Promise<IntakeLogRecord> {
  const label = input.label?.trim();
  if (!label) throw new ValidationError('label_required');
  if (label.length > 80) throw new ValidationError('label_too_long');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError('items_required');

  const resolved: PersistedIntakeItem[] = [];
  for (const item of input.items) {
    if (item.kind === 'food') resolved.push(await resolveFoodItem(item));
    else if (item.kind === 'manual') resolved.push(resolveManualItem(item));
    else if (item.kind === 'plan') resolved.push(await resolvePlanItem(input.userId, item));
    else throw new ValidationError('invalid_item_kind');
  }

  const totals = sumNutrients(resolved.map((i) => ({
    energyKcal: i.energyKcal, proteinG: i.proteinG, carbohydrateG: i.carbohydrateG, fatG: i.fatG,
    fiberG: i.fiberG, sodiumMg: null,
  })));

  const totalKcal = resolved.reduce((s, i) => s + i.energyKcal, 0);
  const confidenceScore = totalKcal > 0
    ? resolved.reduce((s, i) => s + i.energyKcal * RESOLVER_WEIGHT[i.resolver], 0) / totalKcal
    : RESOLVER_WEIGHT[resolved[0].resolver];

  const dateKey = dayKey();
  const { rows } = await pool.query(
    `INSERT INTO user_nutrition_intake_logs
       (user_id, date_key, meal_id, label, raw_text, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, fiber_partial, items, confidence_score, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.userId, dateKey, input.mealId ?? null, label, input.rawText ?? null,
      totals.energyKcal, totals.proteinG, totals.carbohydrateG, totals.fatG,
      totals.fiberG, totals.fiberPartial,
      JSON.stringify(resolved), Math.round(confidenceScore * 100) / 100, input.source,
    ]
  );
  return mapRow(rows[0]);
}

export async function getDayLogs(userId: number, dateKey: string): Promise<IntakeLogRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM user_nutrition_intake_logs
      WHERE user_id = $1 AND date_key = $2 AND deleted_at IS NULL
      ORDER BY logged_at`,
    [userId, dateKey]
  );
  return rows.map(mapRow);
}

export async function softDeleteLog(userId: number, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE user_nutrition_intake_logs SET deleted_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}

export async function setFavorite(userId: number, id: number, favorite: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE user_nutrition_intake_logs SET is_favorite = $3
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId, favorite]
  );
  return (rowCount ?? 0) > 0;
}

export type DayCoverageLevel = 'high' | 'partial' | 'low';

export interface DayCoverage {
  loggedMeals: number;
  expectedMeals: number;
  coverageRatio: number;
  confidence: number;
  level: DayCoverageLevel;
}

/**
 * Classificação de cobertura/confiança de UM dia (PLAN §11) — usada aqui só
 * para a faixa do dia do próprio aluno. A agregação de 7/14 dias para o
 * nutri (P1C) reaplica as MESMAS regras em `nutritionIntake.ts`, nunca uma
 * segunda fórmula.
 */
export interface DayLogSummary {
  loggedMeals: number;
  totalKcal: number;
  /** Média ponderada por kcal do `confidence_score` dos logs do dia (0..1). */
  weightedConfidence: number;
}

/**
 * Núcleo puro da classificação de cobertura/confiança de UM dia (PLAN §11).
 * Recebe o dia já resumido — reusado tanto para o dia único do aluno
 * (`classifyDayCoverage` abaixo, a partir de logs reais) quanto para os 14
 * dias pré-agregados por SQL que o nutri vê (`nutritionIntake.ts`, P1C) —
 * MESMA fórmula, nunca duas.
 */
export function classifyDaySummary(day: DayLogSummary, expectedMeals: number): DayCoverage {
  const { loggedMeals, weightedConfidence } = day;
  const coverageRatio = expectedMeals > 0 ? Math.min(loggedMeals / expectedMeals, 1) : 0;

  let level: DayCoverageLevel = 'low';
  if (coverageRatio >= 0.75 && weightedConfidence >= 0.8) level = 'high';
  else if (coverageRatio >= 0.5) level = 'partial';

  return { loggedMeals, expectedMeals, coverageRatio, confidence: Math.round(weightedConfidence * 100) / 100, level };
}

export function summarizeDayLogs(logs: Array<{ energyKcal: number; confidenceScore: number }>): DayLogSummary {
  const loggedMeals = logs.length;
  const totalKcal = logs.reduce((s, l) => s + l.energyKcal, 0);
  const weightedConfidence = totalKcal > 0
    ? logs.reduce((s, l) => s + l.energyKcal * l.confidenceScore, 0) / totalKcal
    : (loggedMeals > 0 ? logs.reduce((s, l) => s + l.confidenceScore, 0) / loggedMeals : 0);
  return { loggedMeals, totalKcal, weightedConfidence };
}

export function classifyDayCoverage(logs: IntakeLogRecord[], expectedMeals: number): DayCoverage {
  return classifyDaySummary(summarizeDayLogs(logs), expectedMeals);
}

export interface IntakeShortcuts {
  recent: Array<{ label: string; items: PersistedIntakeItem[] }>;
  favorites: Array<{ id: number; label: string; items: PersistedIntakeItem[] }>;
  yesterdayMeals: Array<{ logId: number; label: string; loggedAt: string; items: PersistedIntakeItem[] }>;
}

export async function getShortcuts(userId: number): Promise<IntakeShortcuts> {
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 60 * 60 * 1000));

  const [recentRes, favRes, yesterdayRes] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (label) label, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY label, logged_at DESC LIMIT 5`,
      [userId]
    ),
    pool.query(
      `SELECT id, label, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND is_favorite
        ORDER BY logged_at DESC LIMIT 10`,
      [userId]
    ),
    pool.query(
      `SELECT id, label, logged_at, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND date_key = $2
        ORDER BY logged_at`,
      [userId, yesterday]
    ),
  ]);

  return {
    recent: recentRes.rows.map((r) => ({ label: r.label, items: r.items })),
    favorites: favRes.rows.map((r) => ({ id: r.id, label: r.label, items: r.items })),
    yesterdayMeals: yesterdayRes.rows.map((r) => ({ logId: r.id, label: r.label, loggedAt: r.logged_at, items: r.items })),
  };
}
