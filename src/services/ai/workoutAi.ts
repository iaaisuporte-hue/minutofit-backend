/**
 * Geração de fichas de treino via OpenAI Responses API.
 *
 * Usa a camada centralizada em /lib/ai/openai.ts — nunca acessa o
 * cliente OpenAI diretamente.
 */

import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import { WORKOUT_SYSTEM_PROMPT } from './prompts';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Geração de ficha
// ---------------------------------------------------------------------------

/**
 * Gera uma ficha de treino a partir de um prompt livre do personal.
 *
 * @param prompt   - Solicitação em linguagem natural
 * @param catalogNames - Nomes dos exercícios disponíveis no catálogo
 * @param userId   - ID do usuário para rate limit
 */
export async function generateWorkout(
  prompt: string,
  catalogNames: string[],
  userId: string,
): Promise<GeneratedWorkout> {
  const catalogSection =
    catalogNames.length > 0
      ? `Catálogo disponível (use estes nomes preferencialmente):\n${catalogNames.join(', ')}\n\n`
      : '';

  const { text } = await aiCall({
    userId,
    instructions: WORKOUT_SYSTEM_PROMPT,
    input: `${catalogSection}Solicitação: ${prompt}`,
    maxOutputTokens: TOKEN_BUDGET.WORKOUT_PLAN,
    temperature: 0.4,
    jsonOutput: true,
  });

  let parsed: GeneratedWorkout & { error?: string };
  try {
    parsed = JSON.parse(text) as GeneratedWorkout & { error?: string };
  } catch {
    throw new Error('Resposta da IA inválida. Tente novamente com um prompt mais específico.');
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) {
    throw new Error('A IA não retornou exercícios. Tente reformular o prompt.');
  }

  return parsed;
}
