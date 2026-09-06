import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';

// ---------------------------------------------------------------------------
// SPEC 038 (P3A) — catálogo de alimentos (TACO) + alimentos customizados do
// nutri. Leitura do catálogo é pública para qualquer nutri autenticado
// (dado licenciado, não sensível). Alimento customizado é privado do dono —
// mesmo padrão `owner_X_id` já usado em `exercises`/`workout_protocols`.
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface NutrientInput {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG?: number | null;
  sodiumMg?: number | null;
}

export interface FoodSummary {
  id: number;
  kind: 'catalog' | 'custom';
  name: string;
  category: string | null;
  source: string;
  referenceAmountG: number;
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
  sodiumMg: number | null;
}

export interface FoodMeasure {
  id: number;
  name: string;
  grams: number;
}

function normalizeQuery(q: string): string {
  return q
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(name: string): string {
  return normalizeQuery(name);
}

const RANGE_CHECK: Array<[keyof NutrientInput, number, number]> = [
  ['energyKcal', 0, 950],
  ['proteinG', 0, 100],
  ['carbohydrateG', 0, 100],
  ['fatG', 0, 100],
];

function validateNutrients(input: NutrientInput): void {
  for (const [field, min, max] of RANGE_CHECK) {
    const v = input[field] as number;
    if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
      throw new ValidationError(`invalid_${field}`);
    }
  }
  if (input.fiberG != null && (typeof input.fiberG !== 'number' || input.fiberG < 0 || input.fiberG > 100)) {
    throw new ValidationError('invalid_fiberG');
  }
  if (input.sodiumMg != null && (typeof input.sodiumMg !== 'number' || input.sodiumMg < 0 || input.sodiumMg > 50000)) {
    throw new ValidationError('invalid_sodiumMg');
  }
}

// ---------------------------------------------------------------------------
// Catálogo (TACO) — leitura
// ---------------------------------------------------------------------------

export async function searchCatalogFoods(query: string, limit = 20): Promise<FoodSummary[]> {
  const q = normalizeQuery(query);
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  if (!q) {
    const { rows } = await pool.query(
      `SELECT id, name, category, source, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg
         FROM nutrition_foods WHERE is_active ORDER BY name LIMIT $1`,
      [safeLimit],
    );
    return rows.map(mapCatalogRow);
  }
  const { rows } = await pool.query(
    `SELECT id, name, category, source, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg
       FROM nutrition_foods
      WHERE is_active AND normalized_name ILIKE $1
      ORDER BY (normalized_name = $2) DESC, name
      LIMIT $3`,
    [`%${q}%`, q, safeLimit],
  );
  return rows.map(mapCatalogRow);
}

function mapCatalogRow(r: any): FoodSummary {
  return {
    id: r.id,
    kind: 'catalog',
    name: r.name,
    category: r.category,
    source: r.source,
    referenceAmountG: Number(r.reference_amount_g),
    energyKcal: Number(r.energy_kcal),
    proteinG: Number(r.protein_g),
    carbohydrateG: Number(r.carbohydrate_g),
    fatG: Number(r.fat_g),
    fiberG: r.fiber_g == null ? null : Number(r.fiber_g),
    sodiumMg: r.sodium_mg == null ? null : Number(r.sodium_mg),
  };
}

export async function getCatalogFoodById(id: number): Promise<FoodSummary | null> {
  const { rows } = await pool.query(
    `SELECT id, name, category, source, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg
       FROM nutrition_foods WHERE id = $1 AND is_active`,
    [id],
  );
  return rows.length ? mapCatalogRow(rows[0]) : null;
}

export async function listCatalogFoodMeasures(foodId: number): Promise<FoodMeasure[]> {
  const { rows } = await pool.query(
    `SELECT id, name, grams FROM nutrition_food_measures WHERE food_id = $1 ORDER BY grams`,
    [foodId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, grams: Number(r.grams) }));
}

// ---------------------------------------------------------------------------
// Alimentos customizados — CRUD com dono
// ---------------------------------------------------------------------------

export interface CustomFoodInput extends NutrientInput {
  name: string;
  brand?: string | null;
  notes?: string | null;
  referenceAmountG?: number;
}

function mapCustomRow(r: any): FoodSummary {
  return {
    id: r.id,
    kind: 'custom',
    name: r.name,
    category: null,
    source: 'custom',
    referenceAmountG: Number(r.reference_amount_g),
    energyKcal: Number(r.energy_kcal),
    proteinG: Number(r.protein_g),
    carbohydrateG: Number(r.carbohydrate_g),
    fatG: Number(r.fat_g),
    fiberG: r.fiber_g == null ? null : Number(r.fiber_g),
    sodiumMg: r.sodium_mg == null ? null : Number(r.sodium_mg),
  };
}

export async function listCustomFoods(nutriId: number): Promise<FoodSummary[]> {
  const { rows } = await pool.query(
    `SELECT id, name, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg
       FROM nutrition_custom_foods
      WHERE owner_nutri_id = $1 AND status = 'active'
      ORDER BY name`,
    [nutriId],
  );
  return rows.map(mapCustomRow);
}

export async function createCustomFood(nutriId: number, input: CustomFoodInput): Promise<FoodSummary> {
  const name = input.name?.trim();
  if (!name) throw new ValidationError('name_required');
  if (name.length > 200) throw new ValidationError('name_too_long');
  validateNutrients(input);
  const referenceAmountG = input.referenceAmountG ?? 100;
  if (referenceAmountG <= 0) throw new ValidationError('invalid_referenceAmountG');

  try {
    const { rows } = await pool.query(
      `INSERT INTO nutrition_custom_foods
         (owner_nutri_id, name, normalized_name, brand, notes, reference_amount_g,
          energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, name, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg`,
      [
        nutriId, name, normalizeName(name), input.brand?.trim() || null, input.notes?.trim() || null,
        referenceAmountG, input.energyKcal, input.proteinG, input.carbohydrateG, input.fatG,
        input.fiberG ?? null, input.sodiumMg ?? null,
      ],
    );
    await logDataAccessEvent({
      actorId: nutriId,
      subjectUserId: nutriId,
      eventType: 'nutri.custom_food.created',
      eventPayload: { customFoodId: rows[0].id },
    });
    return mapCustomRow(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') throw new ValidationError('duplicate_name');
    throw err;
  }
}

async function requireOwnedCustomFood(nutriId: number, id: number): Promise<{ id: number }> {
  const { rows } = await pool.query(
    `SELECT id, owner_nutri_id FROM nutrition_custom_foods WHERE id = $1 AND status = 'active'`,
    [id],
  );
  if (rows.length === 0) throw new ValidationError('not_found');
  // SPEC 038 §48/§64: IDOR — nutri B nunca edita/arquiva/lê alimento de nutri A.
  if (Number(rows[0].owner_nutri_id) !== nutriId) throw new ForbiddenError('not_owner');
  return rows[0];
}

export async function updateCustomFood(
  nutriId: number,
  id: number,
  input: Partial<CustomFoodInput>,
): Promise<FoodSummary> {
  await requireOwnedCustomFood(nutriId, id);

  const merged: NutrientInput = {
    energyKcal: input.energyKcal as number,
    proteinG: input.proteinG as number,
    carbohydrateG: input.carbohydrateG as number,
    fatG: input.fatG as number,
    fiberG: input.fiberG,
    sodiumMg: input.sodiumMg,
  };
  if (
    merged.energyKcal !== undefined || merged.proteinG !== undefined ||
    merged.carbohydrateG !== undefined || merged.fatG !== undefined
  ) {
    // Campos parciais em PATCH — só valida os que vieram, buscando o resto do banco.
    const current = await pool.query(
      `SELECT energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg FROM nutrition_custom_foods WHERE id = $1`,
      [id],
    );
    const c = current.rows[0];
    validateNutrients({
      energyKcal: input.energyKcal ?? Number(c.energy_kcal),
      proteinG: input.proteinG ?? Number(c.protein_g),
      carbohydrateG: input.carbohydrateG ?? Number(c.carbohydrate_g),
      fatG: input.fatG ?? Number(c.fat_g),
      fiberG: input.fiberG !== undefined ? input.fiberG : (c.fiber_g == null ? null : Number(c.fiber_g)),
      sodiumMg: input.sodiumMg !== undefined ? input.sodiumMg : (c.sodium_mg == null ? null : Number(c.sodium_mg)),
    });
  }

  const name = input.name?.trim();
  if (name !== undefined && !name) throw new ValidationError('name_required');

  const { rows } = await pool.query(
    `UPDATE nutrition_custom_foods SET
       name = COALESCE($3, name),
       normalized_name = COALESCE($4, normalized_name),
       brand = CASE WHEN $5::boolean THEN $6 ELSE brand END,
       notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
       energy_kcal = COALESCE($9, energy_kcal),
       protein_g = COALESCE($10, protein_g),
       carbohydrate_g = COALESCE($11, carbohydrate_g),
       fat_g = COALESCE($12, fat_g),
       fiber_g = CASE WHEN $13::boolean THEN $14 ELSE fiber_g END,
       sodium_mg = CASE WHEN $15::boolean THEN $16 ELSE sodium_mg END,
       updated_at = NOW()
     WHERE id = $1 AND owner_nutri_id = $2 AND status = 'active'
     RETURNING id, name, reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg`,
    [
      id, nutriId, name ?? null, name ? normalizeName(name) : null,
      input.brand !== undefined, input.brand?.trim() || null,
      input.notes !== undefined, input.notes?.trim() || null,
      input.energyKcal ?? null, input.proteinG ?? null, input.carbohydrateG ?? null, input.fatG ?? null,
      input.fiberG !== undefined, input.fiberG ?? null,
      input.sodiumMg !== undefined, input.sodiumMg ?? null,
    ],
  );
  if (rows.length === 0) throw new ValidationError('not_found');
  return mapCustomRow(rows[0]);
}

export async function archiveCustomFood(nutriId: number, id: number): Promise<void> {
  await requireOwnedCustomFood(nutriId, id);
  await pool.query(
    `UPDATE nutrition_custom_foods SET status = 'archived', updated_at = NOW()
      WHERE id = $1 AND owner_nutri_id = $2`,
    [id, nutriId],
  );
  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: nutriId,
    eventType: 'nutri.custom_food.archived',
    eventPayload: { customFoodId: id },
  });
}

export async function addCustomFoodMeasure(nutriId: number, customFoodId: number, name: string, grams: number): Promise<FoodMeasure> {
  await requireOwnedCustomFood(nutriId, customFoodId);
  if (!name.trim()) throw new ValidationError('name_required');
  if (!(grams > 0)) throw new ValidationError('invalid_grams');
  const { rows } = await pool.query(
    `INSERT INTO nutrition_custom_food_measures (custom_food_id, name, grams) VALUES ($1,$2,$3) RETURNING id, name, grams`,
    [customFoodId, name.trim(), grams],
  );
  return { id: rows[0].id, name: rows[0].name, grams: Number(rows[0].grams) };
}

export async function listCustomFoodMeasures(customFoodId: number): Promise<FoodMeasure[]> {
  const { rows } = await pool.query(
    `SELECT id, name, grams FROM nutrition_custom_food_measures WHERE custom_food_id = $1 ORDER BY grams`,
    [customFoodId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, grams: Number(r.grams) }));
}

/** Usado internamente pela reconciliação de itens de refeição — valida ownership antes de confiar na composição. */
export async function getOwnedCustomFoodNutrients(nutriId: number, id: number): Promise<NutrientInput & { name: string }> {
  const row = await requireOwnedCustomFood(nutriId, id);
  const { rows } = await pool.query(
    `SELECT name, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg FROM nutrition_custom_foods WHERE id = $1`,
    [row.id],
  );
  const r = rows[0];
  return {
    name: r.name,
    energyKcal: Number(r.energy_kcal),
    proteinG: Number(r.protein_g),
    carbohydrateG: Number(r.carbohydrate_g),
    fatG: Number(r.fat_g),
    fiberG: r.fiber_g == null ? null : Number(r.fiber_g),
    sodiumMg: r.sodium_mg == null ? null : Number(r.sodium_mg),
  };
}
