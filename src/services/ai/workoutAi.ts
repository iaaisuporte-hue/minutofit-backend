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
 * Adapta/gera uma ficha de treino a partir de um prompt do personal.
 * max_output_tokens: 250 — respostas objetivas, sem verbosidade.
 */
export async function generateWorkout(
  prompt: string,
  catalogNames: string[],
  userId: string,
): Promise<GeneratedWorkout> {
  const catalogSection =
    catalogNames.length > 0
      ? `Catálogo disponível:\n${catalogNames.join(', ')}\n\n`
      : '';

  const { text } = await aiCall({
    userId,
    instructions: WORKOUT_SYSTEM_PROMPT,
    input: `${catalogSection}Pedido: ${prompt}`,
    maxOutputTokens: TOKEN_BUDGET.WORKOUT_PLAN,
  });

  let parsed: GeneratedWorkout & { error?: string };
  try {
    parsed = JSON.parse(text) as GeneratedWorkout & { error?: string };
  } catch {
    throw new Error('Resposta da IA inválida. Tente com um prompt mais específico.');
  }

  if (parsed.error) throw new Error(parsed.error);

  if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    throw new Error('A IA não retornou exercícios. Reformule o prompt.');
  }

  return parsed;
}
