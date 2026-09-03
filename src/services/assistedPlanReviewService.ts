/**
 * Revisão assistida da ficha (Sprint P2B) — nunca automática (§ do harness:
 * "Observar → consolidar → sinalizar → decisão do Personal"). A partir de um
 * insight (`exerciseInsightService.ts`), o Personal decide EXPLICITAMENTE
 * trocar um exercício recorrentemente substituído por outro — este serviço
 * só monta o payload do DIA inteiro (item trocado + demais intactos) e
 * REUSA `updatePersonalWorkoutPlanWithDays` (D-WRITE-ENDPOINT): nenhuma
 * lógica de validação/escrita nova, nenhum caminho de persistência paralelo.
 *
 * D-BISET: se o item alvo pertence a um par Bi-Set ativo, a troca NÃO é
 * tentada isoladamente (quebraria `validateBiSetPairs`, 400) — a função
 * devolve `{ requiresManualEdit: true, reason: 'BI_SET_MEMBER' }` e é a
 * ROTA/UI que direciona o Personal para o `WorkoutBuilderPage` (editor
 * completo, que já valida o par). Nenhuma alteração em
 * `validateBiSetPairs` nem em `personalWorkoutPlanService.ts`.
 *
 * Ficha ATIVA = a mais recentemente atualizada, não abandonada, deste
 * personal com este aluno — mesma convenção de leitura já usada em
 * `personalDashboardService.ts` ("active_week_preset"), aqui obtida via
 * `listPersonalWorkoutPlans` (função pública já existente, sem tocar sua
 * implementação) em vez de reescrever o SELECT com dias agregados.
 *
 * Imutabilidade histórica: esta função NUNCA toca `workout_sessions` nem
 * `workout_set_logs` — só a ficha ATIVA muda; sessões já registradas mantêm
 * o `prescribed_snapshot` congelado de quando foram executadas.
 */
import { getExercisesBatch } from './exerciseLibraryService';
import {
  assertStudentAssignedToPersonal,
  isValidExerciseId,
  listPersonalWorkoutPlans,
  updatePersonalWorkoutPlanWithDays,
  type WorkoutPlanDay,
  type WorkoutPlanItemPayload,
} from './personalWorkoutPlanService';

function fail(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export type PlanReviewApplied = {
  applied: true;
  plan: Awaited<ReturnType<typeof updatePersonalWorkoutPlanWithDays>>;
};

export type PlanReviewRequiresManualEdit = {
  applied: false;
  requiresManualEdit: true;
  reason: 'BI_SET_MEMBER';
  planId: number;
  dayIndex: number;
};

export type PlanReviewResult = PlanReviewApplied | PlanReviewRequiresManualEdit;

/** Plano ATIVO = o mais recentemente atualizado que NÃO foi abandonado pelo
 * aluno. `listPersonalWorkoutPlans` (não filtra `abandoned_at` — só o aluno
 * não vê abandonada, o personal vê todas) já ordena por `updated_at DESC`;
 * um teto pequeno basta para achar a primeira ativa sem trazer o histórico
 * inteiro. */
async function loadActivePlan(personalId: number, studentId: number) {
  const plans = await listPersonalWorkoutPlans(personalId, studentId, 10);
  return plans.find((p) => p.abandoned_at == null) ?? null;
}

function findOccurrences(
  days: WorkoutPlanDay[],
  originalExerciseId: string,
): { dayIndex: number; itemIndex: number; item: WorkoutPlanItemPayload }[] {
  const occurrences: { dayIndex: number; itemIndex: number; item: WorkoutPlanItemPayload }[] = [];
  for (const day of days) {
    day.items.forEach((item, itemIndex) => {
      if (item.exerciseId === originalExerciseId) {
        occurrences.push({ dayIndex: day.index, itemIndex, item });
      }
    });
  }
  return occurrences;
}

/**
 * Aplica a troca `originalExerciseId → targetExerciseId` em TODOS os dias da
 * ficha ativa onde o original aparece (é o MESMO item de conteúdo — revisar
 * num dia e deixar inconsistente em outro seria pior do que não revisar),
 * preservando reps/séries/descanso/técnica/notas de CADA ocorrência
 * individualmente. Aborta sem tocar nada se qualquer ocorrência for membro
 * de um par Bi-Set (D-BISET).
 */
export async function applyAssistedPlanReview(
  personalId: number,
  studentId: number,
  originalExerciseId: string,
  targetExerciseId: string,
): Promise<PlanReviewResult> {
  if (!isValidExerciseId(originalExerciseId) || !isValidExerciseId(targetExerciseId)) {
    throw fail('exerciseId inválido', 400, 'INVALID_EXERCISE_ID');
  }

  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) throw fail('Student is not assigned to this personal trainer', 403, 'ASSIGNMENT_REQUIRED');

  const plan = await loadActivePlan(personalId, studentId);
  if (!plan) throw fail('Aluno não tem ficha ativa para revisar', 404, 'NO_ACTIVE_PLAN');

  const occurrences = findOccurrences(plan.days, originalExerciseId);
  if (!occurrences.length) {
    throw fail('Exercício não está na ficha ativa (pode já ter sido revisado)', 404, 'EXERCISE_NOT_IN_PLAN');
  }

  const biSetOffender = occurrences.find((o) => o.item.technique?.type === 'bi_set');
  if (biSetOffender) {
    return {
      applied: false,
      requiresManualEdit: true,
      reason: 'BI_SET_MEMBER',
      planId: plan.id,
      dayIndex: biSetOffender.dayIndex,
    };
  }

  // Nome de exibição do alvo — só para preencher o campo obrigatório do item;
  // a validação de EXISTÊNCIA/VISIBILIDADE de verdade é a de sempre, dentro de
  // `updatePersonalWorkoutPlanWithDays` (`assertExercisesExist`), não duplicada
  // aqui. Se o id não existir, o placeholder segue e o erro real (400
  // INVALID_EXERCISES) vem de lá — fonte única de validação.
  const [targetExercise] = await getExercisesBatch([targetExerciseId]);
  const targetName = targetExercise?.name ?? 'Exercício';

  const newDays = plan.days.map((day: WorkoutPlanDay) => ({
    name: day.name,
    focus: day.focus,
    items: day.items.map((item: WorkoutPlanItemPayload) =>
      item.exerciseId === originalExerciseId
        ? { ...item, exerciseId: targetExerciseId, name: targetName }
        : item,
    ),
  }));

  const updated = await updatePersonalWorkoutPlanWithDays(personalId, plan.id, studentId, plan.academy_id ?? null, {
    title: plan.title,
    weekPreset: plan.week_preset,
    days: newDays,
  });

  return { applied: true, plan: updated };
}
