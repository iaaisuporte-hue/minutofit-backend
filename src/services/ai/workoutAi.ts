/**
 * Geração de planos de treino semanais via OpenAI Responses API.
 * Retorna plano com dias (Dia A, Dia B…) e suporte a técnicas avançadas.
 * Os exercícios usam exercise_id UUID da biblioteca MetaCore — validados na resposta.
 */

import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import { WORKOUT_SYSTEM_PROMPT } from './prompts';
import { getExerciseCatalogForAI, findExerciseByName } from '../exerciseLibraryService';
import logger from '../../lib/logger';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type GeneratedExercise = {
  exercise_id: string;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida e resolve exercícios retornados pela IA.
 * - Se exercise_id é UUID válido → usa direto.
 * - Senão → tenta match por nome via findExerciseByName.
 * - Se não achar → marca como legacy (não rejeita para não quebrar o fluxo do Personal).
 */
async function resolveExercises(
  exercises: Array<{ exercise_id?: string; name?: string; [key: string]: unknown }>,
  validIds: Set<string>
): Promise<GeneratedExercise[]> {
  const resolved: GeneratedExercise[] = [];

  for (const ex of exercises) {
    const exerciseId = String(ex.exercise_id ?? '');
    const name = String(ex.name ?? '');

    if (UUID_RE.test(exerciseId) && validIds.has(exerciseId)) {
      resolved.push({
        exercise_id: exerciseId,
        name,
        sets: String(ex.sets ?? '4'),
        reps: String(ex.reps ?? '10-12'),
        rest: String(ex.rest ?? '60s'),
        note: ex.note != null ? String(ex.note) : null,
      });
      continue;
    }

    // Fallback: match por nome
    const match = await findExerciseByName(name);
    if (match) {
      resolved.push({
        exercise_id: match.id,
        name: match.name,
        sets: String(ex.sets ?? '4'),
        reps: String(ex.reps ?? '10-12'),
        rest: String(ex.rest ?? '60s'),
        note: ex.note != null ? String(ex.note) : null,
      });
      logger.warn({ exerciseId, name, resolvedId: match.id }, '[AI] exercise_id inválido — resolvido por nome');
    } else {
      logger.warn({ exerciseId, name }, '[AI] Exercício não resolvido — omitido');
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Geração principal
// ---------------------------------------------------------------------------

/**
 * Gera um plano de treino semanal (ABC, ABCD, etc.) a partir de um prompt.
 * Passa o catálogo com UUIDs para a IA e valida os IDs retornados.
 */
export async function generateWorkout(
  prompt: string,
  _catalogNames: string[],
  userId: string,
): Promise<GeneratedWeeklyPlan> {
  // Busca catálogo atual com IDs para injetar no prompt
  const catalog = await getExerciseCatalogForAI();
  const validIds = new Set(catalog.map((e) => e.id));

  // Formato compacto para o prompt (ID — Nome — equipamento)
  const catalogSection =
    catalog.length > 0
      ? `Catálogo disponível (exercise_id — nome — equipamento):\n${catalog
          .slice(0, 120) // Token budget: ~120 exercícios no prompt
          .map((e) => `${e.id} — ${e.name} — ${e.equipment}`)
          .join('\n')}\n\n`
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
    logger.error({ rawLength: text.length, rawSample: text.slice(0, 300), rawTail: text.slice(-150) }, '[AI] JSON parse failed');
    throw new Error('Resposta da IA inválida. Tente com um prompt mais específico.');
  }

  if (parsed.error) throw new Error(parsed.error);

  if (!Array.isArray(parsed.days) || parsed.days.length === 0) {
    logger.error({ rawLength: text.length, rawSample: text.slice(0, 300) }, '[AI] No days in response');
    throw new Error('A IA não retornou dias de treino. Reformule o prompt.');
  }

  // Resolve e valida exercise_id em cada dia
  const resolvedDays: GeneratedDay[] = [];
  for (const day of parsed.days) {
    if (!Array.isArray(day.exercises) || day.exercises.length === 0) {
      logger.warn({ day: day.name }, '[AI] Day with no exercises — skipping');
      continue;
    }
    const resolvedExercises = await resolveExercises(
      day.exercises as Array<{ exercise_id?: string; name?: string; [key: string]: unknown }>,
      validIds
    );
    if (resolvedExercises.length === 0) {
      logger.warn({ day: day.name }, '[AI] Day with no resolvable exercises — skipping');
      continue;
    }
    resolvedDays.push({ name: day.name, focus: day.focus, exercises: resolvedExercises });
  }

  if (resolvedDays.length === 0) {
    throw new Error('Nenhum exercício válido encontrado na resposta da IA. Reformule o prompt.');
  }

  return { ...parsed, days: resolvedDays };
}
