/**
 * Resumo IA do aluno para o personal trainer.
 * Síntese contextual de evolução, aderência, sono e metabolismo.
 *
 * REGRAS:
 *  - Usa o wrapper central aiCall() — nunca o SDK diretamente.
 *  - Input: snapshot compacto dos dados já computados (sem nova query).
 *  - Output: texto curto (máx 4 frases), tom cuidado/clareza (Seção 16 do manifesto).
 *  - SEMPRE inclui disclaimer: decisão final é do profissional.
 *  - Sujeito ao rate limit de 10 chamadas IA/usuário/hora.
 */

import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import { SCOPE_GUARD } from './prompts';

const STUDENT_SUMMARY_SYSTEM_PROMPT = `${SCOPE_GUARD}

Você é um assistente do MetaCore que ajuda personal trainers a entender rapidamente a evolução de seus alunos.

REGRAS:
- Resuma em no máximo 4 frases curtas o estado atual do aluno.
- Tom: cuidado, clareza, sem julgamento. Nunca use linguagem de culpa ou pressão.
- Foque em padrões e tendências, não em números isolados.
- Finalize SEMPRE com: "Ação final é sua como profissional."
- Nunca faça diagnóstico médico ou clínico.
- Se dados forem insuficientes, diga isso claramente.`;

export type StudentSummaryInput = {
  name: string;
  streakDays: number;
  adherencePct: number;
  workouts7d: number;
  workouts30d: number;
  metabolismScore: number | null;
  metabolismTrend: 'up' | 'down' | 'stable' | 'unknown';
  metabolismDelta7d: number | null;
  latestSleptWell: boolean | null;
  engagementStatus: string;
  riskScore: number;
  engagementScore: number;
  assignedWeeks: number;
};

export type StudentSummaryResult = {
  summary: string;
  disclaimer: string;
};

export async function generateStudentSummary(
  personalId: number,
  input: StudentSummaryInput
): Promise<StudentSummaryResult> {
  const assignedContext = input.assignedWeeks > 0
    ? `Acompanhado há ${input.assignedWeeks} semanas.`
    : 'Aluno recém-atribuído.';

  const metabolismContext = input.metabolismScore !== null
    ? `Score metabólico: ${input.metabolismScore} (${input.metabolismTrend === 'up' ? 'subindo' : input.metabolismTrend === 'down' ? 'caindo' : 'estável'}).`
    : 'Sem snapshot metabólico registrado.';

  const sleepContext = input.latestSleptWell === null
    ? 'Sono: sem dado recente.'
    : input.latestSleptWell
    ? 'Último sono: positivo.'
    : 'Último sono: negativo (dormiu mal).';

  const userInput = `Aluno: ${input.name}.
${assignedContext}
Sequência atual: ${input.streakDays} dias.
Aderência mensal: ${input.adherencePct}%.
Treinos nesta semana: ${input.workouts7d}. Treinos nos últimos 30 dias: ${input.workouts30d}.
${metabolismContext}
${sleepContext}
Estado de engajamento: ${input.engagementStatus}. Score de risco: ${input.riskScore}/100.

Gere um resumo breve e contextual sobre a evolução deste aluno.`;

  const result = await aiCall({
    userId: String(personalId),
    instructions: STUDENT_SUMMARY_SYSTEM_PROMPT,
    input: userInput,
    maxOutputTokens: TOKEN_BUDGET.STUDENT_SUMMARY,
    reasoningEffort: 'minimal',
  });

  return {
    summary: result.text.trim(),
    disclaimer: 'Resumo gerado com base nos dados disponíveis. A decisão final é sempre do profissional.',
  };
}
