import pool from '../config/database';
import logger from '../lib/logger';
import { runNutritionFoodsSeed } from './seedNutritionFoods.core';

/**
 * Popula o catálogo de alimentos (TACO) no boot, só quando a tabela está
 * vazia. Diferente do seed de exercícios (que também re-roda pra preencher
 * gaps de mídia), o catálogo TACO não tem gap parcial esperado — ou está
 * vazio (primeiro boot) ou já foi semeado.
 */
export async function seedNutritionFoodsIfEmpty(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM nutrition_foods`);
  if (parseInt(rows[0].count, 10) > 0) {
    logger.info('[seed:nutrition-foods] Catálogo já populado — pulando seed automático.');
    return;
  }

  logger.info('[seed:nutrition-foods] Tabela vazia — executando seed completo (TACO)...');
  const result = await runNutritionFoodsSeed(pool);
  if (result.errors > 0) {
    logger.warn(result, '[seed:nutrition-foods] Seed concluído com erros parciais');
  } else {
    logger.info(result, '[seed:nutrition-foods] Seed concluído com sucesso');
  }
}
