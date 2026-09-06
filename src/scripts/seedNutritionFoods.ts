/**
 * Script CLI idempotente para popular nutrition_foods + nutrition_food_measures.
 * Uso: npx tsx src/scripts/seedNutritionFoods.ts
 *
 * A lógica central está em src/db/seedNutritionFoods.core.ts (reutilizada
 * também no boot automático via seedNutritionFoodsIfEmpty).
 */

import pool from '../config/database';
import logger from '../lib/logger';
import { runNutritionFoodsSeed } from '../db/seedNutritionFoods.core';

async function main() {
  try {
    const result = await runNutritionFoodsSeed(pool);
    logger.info(result, '[seed:nutrition-foods] Concluído');
  } catch (err: unknown) {
    logger.error({ err }, '[seed:nutrition-foods] Falha fatal');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
