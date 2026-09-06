/**
 * SPEC 038 (P3A) — seed idempotente do catálogo de alimentos (TACO 4ª
 * edição, 2011) e das medidas caseiras curadas. Mesma estratégia de
 * `seedExercisesLibrary.core.ts`: ON CONFLICT no índice-alvo, natural key
 * = `(source, source_id)`. Reexecutar não duplica nem perde dado — só
 * atualiza a composição se a fonte/versão mudar.
 */

import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import logger from '../lib/logger';

export interface TacoFoodSeed {
  source: string;
  sourceId: string;
  sourceVersion: string;
  name: string;
  normalizedName: string;
  category: string;
  referenceAmountG: number;
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
  sodiumMg: number | null;
}

export interface TacoMeasureSeed {
  foodSourceId: string;
  foodName: string;
  name: string;
  grams: number;
}

function resolveSeedPath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, `../seeds/${filename}`),
    path.resolve(__dirname, `../../src/seeds/${filename}`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function loadJson<T>(filename: string): T[] {
  const p = resolveSeedPath(filename);
  if (!fs.existsSync(p)) {
    logger.warn({ path: p }, '[seed:nutrition-foods] Arquivo de seed não encontrado');
    return [];
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T[];
}

export interface NutritionFoodsSeedResult {
  foodsTotal: number;
  foodsCreated: number;
  foodsUpdated: number;
  measuresTotal: number;
  measuresCreated: number;
  errors: number;
}

export async function runNutritionFoodsSeed(pool: Pool): Promise<NutritionFoodsSeedResult> {
  const foods = loadJson<TacoFoodSeed>('tacoFoods.snapshot.json');
  const measures = loadJson<TacoMeasureSeed>('tacoMeasures.curated.json');

  const result: NutritionFoodsSeedResult = {
    foodsTotal: foods.length,
    foodsCreated: 0,
    foodsUpdated: 0,
    measuresTotal: measures.length,
    measuresCreated: 0,
    errors: 0,
  };

  // food.source_id (TACO) -> row id no banco, usado para resolver as medidas.
  const idBySourceId = new Map<string, number>();

  for (const f of foods) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO nutrition_foods
           (source, source_id, source_version, name, normalized_name, category,
            reference_amount_g, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, sodium_mg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (source, source_id) DO UPDATE SET
           source_version = EXCLUDED.source_version,
           name = EXCLUDED.name,
           normalized_name = EXCLUDED.normalized_name,
           category = EXCLUDED.category,
           reference_amount_g = EXCLUDED.reference_amount_g,
           energy_kcal = EXCLUDED.energy_kcal,
           protein_g = EXCLUDED.protein_g,
           carbohydrate_g = EXCLUDED.carbohydrate_g,
           fat_g = EXCLUDED.fat_g,
           fiber_g = EXCLUDED.fiber_g,
           sodium_mg = EXCLUDED.sodium_mg,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS created`,
        [
          f.source, f.sourceId, f.sourceVersion, f.name, f.normalizedName, f.category,
          f.referenceAmountG, f.energyKcal, f.proteinG, f.carbohydrateG, f.fatG, f.fiberG, f.sodiumMg,
        ],
      );
      const row = rows[0];
      idBySourceId.set(f.sourceId, row.id);
      if (row.created) result.foodsCreated += 1; else result.foodsUpdated += 1;
    } catch (err) {
      result.errors += 1;
      logger.error({ err, food: f.name }, '[seed:nutrition-foods] Falha ao gravar alimento');
    }
  }

  for (const m of measures) {
    const foodId = idBySourceId.get(m.foodSourceId);
    if (!foodId) continue; // fonte não importada (ex.: excluída por falta de macro) — medida órfã, pula
    try {
      const existing = await pool.query(
        `SELECT id FROM nutrition_food_measures WHERE food_id = $1 AND name = $2`,
        [foodId, m.name],
      );
      if (existing.rows.length > 0) continue; // já existe — idempotente sem duplicar
      await pool.query(
        `INSERT INTO nutrition_food_measures (food_id, name, grams) VALUES ($1,$2,$3)`,
        [foodId, m.name, m.grams],
      );
      result.measuresCreated += 1;
    } catch (err) {
      result.errors += 1;
      logger.error({ err, measure: m.name, food: m.foodName }, '[seed:nutrition-foods] Falha ao gravar medida');
    }
  }

  return result;
}
