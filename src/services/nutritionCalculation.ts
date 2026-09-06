/**
 * SPEC 038 (P3A) — cálculo nutricional puro. Função central e única: nunca
 * duplicar esta fórmula em outro lugar do backend (nem, é claro, confiar em
 * valores de kcal/macro vindos do cliente — o backend sempre recalcula a
 * partir da composição oficial do alimento).
 */

export interface NutrientsPer100g {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
  sodiumMg: number | null;
}

export interface CalculatedNutrients {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
  sodiumMg: number | null;
}

/** Arredonda para 2 casas — mesma precisão de armazenamento do catálogo. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve a quantidade prescrita para gramas. `unitType: 'grams'` já É a
 * gramagem; `'measure'` multiplica a quantidade de medidas pelo peso de UMA
 * medida (ex.: 2 colheres de sopa × 25g/colher = 50g).
 */
export function resolveGrams(
  quantity: number,
  unitType: 'grams' | 'measure',
  measureGrams?: number | null,
): number {
  if (quantity <= 0) throw new Error('quantity_must_be_positive');
  if (unitType === 'grams') return round2(quantity);
  if (measureGrams == null || measureGrams <= 0) throw new Error('measure_grams_required');
  return round2(quantity * measureGrams);
}

/**
 * Nutrientes por 100g × (gramas / 100). Fibra e sódio propagam `null`
 * quando a fonte não os mediu — NUNCA viram 0, que seria uma afirmação
 * falsa ("medimos e é zero" ≠ "não medimos").
 */
export function calculateNutrition(per100g: NutrientsPer100g, grams: number): CalculatedNutrients {
  if (grams <= 0) throw new Error('grams_must_be_positive');
  const factor = grams / 100;
  return {
    energyKcal: round2(per100g.energyKcal * factor),
    proteinG: round2(per100g.proteinG * factor),
    carbohydrateG: round2(per100g.carbohydrateG * factor),
    fatG: round2(per100g.fatG * factor),
    fiberG: per100g.fiberG == null ? null : round2(per100g.fiberG * factor),
    sodiumMg: per100g.sodiumMg == null ? null : round2(per100g.sodiumMg * factor),
  };
}

export interface NutrientTotals {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  /** null quando NENHUM item da soma tinha fibra medida. */
  fiberG: number | null;
  /** true quando ao menos um item somado não tinha fibra medida — o total é parcial, não "zero de verdade". */
  fiberPartial: boolean;
  sodiumMg: number | null;
  sodiumPartial: boolean;
}

/** Soma um conjunto de itens já calculados (snapshot) — usado para total de refeição e de dia. */
export function sumNutrients(items: CalculatedNutrients[]): NutrientTotals {
  let energyKcal = 0, proteinG = 0, carbohydrateG = 0, fatG = 0;
  let fiberG = 0, hasFiber = false, fiberPartial = false;
  let sodiumMg = 0, hasSodium = false, sodiumPartial = false;

  for (const it of items) {
    energyKcal += it.energyKcal;
    proteinG += it.proteinG;
    carbohydrateG += it.carbohydrateG;
    fatG += it.fatG;
    if (it.fiberG != null) { fiberG += it.fiberG; hasFiber = true; } else { fiberPartial = true; }
    if (it.sodiumMg != null) { sodiumMg += it.sodiumMg; hasSodium = true; } else { sodiumPartial = true; }
  }

  return {
    energyKcal: round2(energyKcal),
    proteinG: round2(proteinG),
    carbohydrateG: round2(carbohydrateG),
    fatG: round2(fatG),
    fiberG: hasFiber ? round2(fiberG) : null,
    fiberPartial: hasFiber && fiberPartial,
    sodiumMg: hasSodium ? round2(sodiumMg) : null,
    sodiumPartial: hasSodium && sodiumPartial,
  };
}
