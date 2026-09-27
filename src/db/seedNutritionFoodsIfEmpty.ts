import logger from '../lib/logger';
import pool from '../config/database';
import { runNutritionFoodsSeed } from './seedNutritionFoods.core';

/**
 * Popula/atualiza o catálogo de alimentos no boot — SEMPRE roda, não só
 * quando a tabela está vazia (correção do CANONICAL_FOOD_MODEL_SPIKE: o
 * catálogo passou a ter múltiplas fontes — PLAN §14 —, e uma linha nova de
 * uma fonte complementar, ex. USDA, só chegava a um banco JÁ seedado
 * rodando o script manual (`npx tsx src/scripts/seedNutritionFoods.ts`),
 * nunca no boot normal. Um banco de dev/staging já populado antes dessa
 * correção nunca receberia leite fluido/whey sem essa intervenção manual —
 * exatamente o bug reportado no QA). O upsert é idempotente
 * (`ON CONFLICT (source, source_id) DO UPDATE`, ver `seedNutritionFoods.core.ts`)
 * e o mesmo padrão já usado pelo seed de exercícios — reexecutar não
 * duplica, não perde dado, e é rápido o bastante (algumas centenas de
 * linhas) para rodar em todo boot sem impacto perceptível.
 */
export async function seedNutritionFoodsIfEmpty(): Promise<void> {
  const result = await runNutritionFoodsSeed(pool);
  if (result.errors > 0) {
    logger.warn(result, '[seed:nutrition-foods] Seed concluído com erros parciais');
  } else {
    logger.info(result, '[seed:nutrition-foods] Seed concluído com sucesso');
  }
}
