/**
 * Dica metabólica curta para o aluno do dia.
 *
 * Usa a camada centralizada em /lib/ai/openai.ts.
 * Resposta máxima: 200 tokens — sugestão curta, objetiva.
 */

import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import { METABOLIC_HINT_SYSTEM_PROMPT } from './prompts';

export type MetabolicHint = {
  hint: string;
  intensity: 'leve' | 'moderada' | 'alta';
  action: string;
};

/**
 * Gera uma dica metabólica personalizada com base no contexto do aluno.
 *
 * @param context - Contexto livre: energia, aderência, histórico recente, etc.
 * @param userId  - ID do usuário para rate limit
 */
export async function getMetabolicHint(
  context: string,
  userId: string,
): Promise<MetabolicHint> {
  const { text } = await aiCall({
    userId,
    instructions: METABOLIC_HINT_SYSTEM_PROMPT,
    input: context,
    maxOutputTokens: TOKEN_BUDGET.SUGGEST_SHORT,
    temperature: 0.5,
    jsonOutput: true,
  });

  let parsed: MetabolicHint & { error?: string };
  try {
    parsed = JSON.parse(text) as MetabolicHint & { error?: string };
  } catch {
    throw new Error('Resposta da IA inválida.');
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (!parsed.hint || !parsed.intensity || !parsed.action) {
    throw new Error('Resposta da IA incompleta.');
  }

  return parsed;
}
