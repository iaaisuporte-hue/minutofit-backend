/**
 * Geração de fichas de treino via OpenAI Responses API.
 * Usa a camada centralizada — sem parâmetros deprecated (temperature, max_tokens).
 */

import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import { WORKOUT_SYSTEM_PROMPT } from './prompts';

export type GeneratedExercise = {
  name: string;
  sets: string;
  reps: string;
  rest: string;
};

export type GeneratedWorkout = {
  title: string;
  weekPreset: string;
  exercises: GeneratedExercise[];
};

/**
 * Extrai JSON de uma string que pode conter markdown ou texto prefixado.
 * Estratégias (em ordem):
 *  1. Parse direto (resposta limpa)
 *  2. Strip de blocos markdown ```json ... ```
 *  3. Extração do primeiro { até o último }
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // 1. Direto
  if (trimmed.startsWith('{')) return trimmed;

  // 2. Bloco markdown
  const mdMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) return mdMatch[1].trim();

  // 3. Extração por delimitador
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/**
 * Adapta/gera uma ficha de treino a partir de um prompt do personal.
 * max_output_tokens: 500 — garante JSON completo para até 5 exercícios.
 */
export async function generateWorkout(
  prompt: string,
  catalogNames: string[],
  userId: string,
): Promise<GeneratedWorkout> {
  const catalogSection =
    catalogNames.length > 0
      ? `Catálogo:\n${catalogNames.join(', ')}\n\n`
      : '';

  const { text } = await aiCall({
    userId,
    instructions: WORKOUT_SYSTEM_PROMPT,
    input: `${catalogSection}Pedido: ${prompt}`,
    maxOutputTokens: TOKEN_BUDGET.WORKOUT_PLAN,
  });

  const jsonStr = extractJson(text);

  let parsed: GeneratedWorkout & { error?: string };
  try {
    parsed = JSON.parse(jsonStr) as GeneratedWorkout & { error?: string };
  } catch {
    console.error('[AI] JSON parse failed. raw text:', text);
    throw new Error('Resposta da IA inválida. Tente com um prompt mais específico.');
  }

  if (parsed.error) throw new Error(parsed.error);

  if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    console.error('[AI] No exercises in response. raw text:', text);
    throw new Error('A IA não retornou exercícios. Reformule o prompt.');
  }

  return parsed;
}
