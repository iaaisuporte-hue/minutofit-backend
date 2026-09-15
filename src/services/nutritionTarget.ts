/**
 * PLAN_NUTRITION_QUICK_MACROS (P1A) — meta diária de macros do aluno.
 *
 * Módulo PURO (sem acesso a banco), mesmo padrão de `nutriAdherence.ts` e
 * `nutritionCalculation.ts`: fácil de testar, e única fonte da fórmula —
 * nunca reimplementar no frontend nem em outra rota.
 *
 * `formula_version = 1` (kcal/kg + % de objetivo). Decisão consciente do
 * usuário: evitar Mifflin-St Jeor (exigiria novo campo `sexo` no perfil,
 * fricção que o P1 não paga) em troca de uma heurística simples que já usa
 * dado existente (`weight_kg`).
 */

export type NutritionObjective = 'weight_loss' | 'maintenance' | 'muscle_gain';
export type ActivityLevel = 'low' | 'moderate' | 'high';

const KCAL_PER_KG_BY_ACTIVITY: Record<ActivityLevel, number> = {
  low: 28,
  moderate: 32,
  high: 36,
};

const OBJECTIVE_KCAL_MULTIPLIER: Record<NutritionObjective, number> = {
  weight_loss: 0.85,
  maintenance: 1,
  muscle_gain: 1.1,
};

const PROTEIN_G_PER_KG: Record<NutritionObjective, number> = {
  weight_loss: 2.0,
  maintenance: 1.6,
  muscle_gain: 2.2,
};

const FAT_G_PER_KG = 0.9;
const FAT_MIN_KCAL_SHARE = 0.2;

const KCAL_FLOOR = 1200;
const KCAL_CEILING = 4500;

export interface EstimateTargetInput {
  weightKg: number;
  objective: NutritionObjective;
  activity: ActivityLevel;
  mealsPerDay: number;
}

export interface MealSplit {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
}

export interface EstimatedTarget {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  mealsPerDay: number;
  formulaVersion: number;
  meals: MealSplit[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Estimativa kcal/kg/objetivo → macros. Piso 1.200 / teto 4.500 kcal.
 * Gordura tem piso próprio de 20% das kcal (evita dieta hiperproteica que
 * zeraria gordura de objetivos agressivos de emagrecimento).
 */
export function estimateNutritionTarget(input: EstimateTargetInput): EstimatedTarget {
  const { weightKg, objective, activity, mealsPerDay } = input;
  if (!Number.isFinite(weightKg) || weightKg <= 0) throw new Error('weight_kg_required');
  if (!Number.isInteger(mealsPerDay) || mealsPerDay < 3 || mealsPerDay > 6) {
    throw new Error('meals_per_day_out_of_range');
  }

  const maintenanceKcal = weightKg * KCAL_PER_KG_BY_ACTIVITY[activity];
  const rawKcal = maintenanceKcal * OBJECTIVE_KCAL_MULTIPLIER[objective];
  const energyKcal = Math.min(Math.max(rawKcal, KCAL_FLOOR), KCAL_CEILING);

  const proteinG = weightKg * PROTEIN_G_PER_KG[objective];
  let fatG = Math.max(weightKg * FAT_G_PER_KG, (energyKcal * FAT_MIN_KCAL_SHARE) / 9);

  const kcalFromProteinAndFat = proteinG * 4 + fatG * 9;
  let carbohydrateG = (energyKcal - kcalFromProteinAndFat) / 4;
  if (carbohydrateG < 0) {
    // Combinação extrema (peso baixo + objetivo agressivo): absorve o
    // excesso na gordura antes de deixar carboidrato negativo.
    carbohydrateG = 0;
    fatG = Math.max(0, (energyKcal - proteinG * 4) / 9);
  }

  const target: EstimatedTarget = {
    energyKcal: round1(energyKcal),
    proteinG: round1(proteinG),
    carbohydrateG: round1(carbohydrateG),
    fatG: round1(fatG),
    mealsPerDay,
    formulaVersion: 1,
    meals: [],
  };
  target.meals = splitTargetByMeals(target, mealsPerDay);
  return target;
}

/**
 * Divide os totais igualmente pelas refeições, arredondado a 5g/10kcal; a
 * última refeição absorve o resto para que a soma volte exatamente ao
 * total (nunca "quase bate" por erro de arredondamento).
 */
export function splitTargetByMeals(
  totals: { energyKcal: number; proteinG: number; carbohydrateG: number; fatG: number },
  mealsPerDay: number
): MealSplit[] {
  if (!Number.isInteger(mealsPerDay) || mealsPerDay < 1) throw new Error('meals_per_day_out_of_range');

  const roundTo = (n: number, step: number) => Math.round(n / step) * step;

  const perMeal = {
    energyKcal: roundTo(totals.energyKcal / mealsPerDay, 10),
    proteinG: roundTo(totals.proteinG / mealsPerDay, 5),
    carbohydrateG: roundTo(totals.carbohydrateG / mealsPerDay, 5),
    fatG: roundTo(totals.fatG / mealsPerDay, 5),
  };

  const meals: MealSplit[] = [];
  for (let i = 0; i < mealsPerDay; i++) {
    meals.push({ ...perMeal });
  }

  const lastIndex = mealsPerDay - 1;
  meals[lastIndex] = {
    energyKcal: round1(totals.energyKcal - perMeal.energyKcal * lastIndex),
    proteinG: round1(totals.proteinG - perMeal.proteinG * lastIndex),
    carbohydrateG: round1(totals.carbohydrateG - perMeal.carbohydrateG * lastIndex),
    fatG: round1(totals.fatG - perMeal.fatG * lastIndex),
  };
  return meals;
}

export type NutritionTargetSource = 'plan_items' | 'self_estimate';

export interface ResolvedNutritionTarget {
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  mealsPerDay: number;
  source: NutritionTargetSource;
}

/**
 * O plano do nutri vence quando existe (decisão do usuário, P1A). Um plano
 * só-texto (sem itens estruturados da SPEC 038) tem `dayTotals.energyKcal
 * === 0` — isso é lido como "sem meta do plano", NUNCA como "meta zero".
 */
export function resolveNutritionTarget(input: {
  planDayTotals?: { energyKcal: number; proteinG: number; carbohydrateG: number; fatG: number } | null;
  planMealsCount?: number | null;
  selfTarget?: {
    energyKcal: number;
    proteinG: number;
    carbohydrateG: number;
    fatG: number;
    mealsPerDay: number;
  } | null;
}): ResolvedNutritionTarget | null {
  const { planDayTotals, planMealsCount, selfTarget } = input;

  if (planDayTotals && planDayTotals.energyKcal > 0) {
    return {
      energyKcal: planDayTotals.energyKcal,
      proteinG: planDayTotals.proteinG,
      carbohydrateG: planDayTotals.carbohydrateG,
      fatG: planDayTotals.fatG,
      mealsPerDay: planMealsCount && planMealsCount > 0 ? planMealsCount : 3,
      source: 'plan_items',
    };
  }

  if (selfTarget) {
    return {
      energyKcal: selfTarget.energyKcal,
      proteinG: selfTarget.proteinG,
      carbohydrateG: selfTarget.carbohydrateG,
      fatG: selfTarget.fatG,
      mealsPerDay: selfTarget.mealsPerDay,
      source: 'self_estimate',
    };
  }

  return null;
}
