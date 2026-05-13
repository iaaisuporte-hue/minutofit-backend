/**
 * @deprecated Use src/services/ai/workoutAi.ts diretamente.
 * Este arquivo mantém compatibilidade com imports existentes.
 */
export type { GeneratedExercise, GeneratedWorkout } from './ai/workoutAi';

import { generateWorkout } from './ai/workoutAi';

/**
 * @deprecated Prefira generateWorkout() de ./ai/workoutAi que exige userId para rate limit.
 * Esta assinatura legada injeta userId='system' — sem rate limit de usuário.
 */
export async function generateWorkoutFromPrompt(
  prompt: string,
  catalogNames: string[],
): Promise<import('./ai/workoutAi').GeneratedWorkout> {
  return generateWorkout(prompt, catalogNames, 'system');
}
