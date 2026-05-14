/**
 * Geração de planos de treino semanais via OpenAI Responses API.
 * Retorna plano com dias (Dia A, Dia B…) e suporte a técnicas avançadas.
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
  note?: string | null;
};

export type GeneratedDay = {
  name: string;
  focus: string;
  exercises: GeneratedExercise[];
};

export type GeneratedWeeklyPlan = {
  title: string;
  weekPreset: string;
  split: string;
  days: GeneratedDay[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extrai JSON de uma string que pode conter markdown ou texto prefixado.
 * Estratégias (em ordem):
 *  1. Parse direto (resposta limpa)
 *  2. Strip de blocos markdown ```json ... ```
 *  3. Extração do primeiro { até o último }
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;

  const mdMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) return mdMatch[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

// ---------------------------------------------------------------------------
// Geração principal
// ---------------------------------------------------------------------------

/**
 * Gera um plano de treino semanal (ABC, ABCD, etc.) a partir de um prompt.
 * Retorna `GeneratedWeeklyPlan` com `days[]`, cada dia com seus exercícios.
 */
export async function generateWorkout(
  prompt: string,
  catalogNames: string[],
  userId: string,
): Promise<GeneratedWeeklyPlan> {
  const catalogSection =
    catalogNames.length > 0
      ? `Catálogo disponível:\n${catalogNames.join(', ')}\n\n`
      : '';

  const { text } = await aiCall({
    userId,
    instructions: WORKOUT_SYSTEM_PROMPT,
    input: `${catalogSection}Pedido: ${prompt}`,
    maxOutputTokens: TOKEN_BUDGET.WORKOUT_PLAN,
    jsonOutput: true,
    reasoningEffort: 'minimal',
  });

  const jsonStr = extractJson(text);

  let parsed: GeneratedWeeklyPlan & { error?: string };
  try {
    parsed = JSON.parse(jsonStr) as GeneratedWeeklyPlan & { error?: string };
  } catch {
    console.error('[AI] JSON parse failed', {
      rawLength: text.length,
      rawSample: text.slice(0, 300),
      rawTail: text.slice(-150),
    });
    throw new Error('Resposta da IA inválida. Tente com um prompt mais específico.');
  }

  if (parsed.error) throw new Error(parsed.error);

  if (!Array.isArray(parsed.days) || parsed.days.length === 0) {
    console.error('[AI] No days in response', {
      rawLength: text.length,
      rawSample: text.slice(0, 300),
    });
    throw new Error('A IA não retornou dias de treino. Reformule o prompt.');
  }

  // Garante que cada dia tem exercícios válidos
  for (const day of parsed.days) {
    if (!Array.isArray(day.exercises) || day.exercises.length === 0) {
      console.error('[AI] Day with no exercises', { day: day.name });
      throw new Error(`Dia "${day.name}" sem exercícios. Reformule o prompt.`);
    }
  }

  return parsed;
}
