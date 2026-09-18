import { Router, type Request, type Response } from 'express';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { getProfessionalContextForStudent } from '../services/professionalContextService';
import { abandonWorkoutPlan } from '../services/personalWorkoutPlanService';
import {
  getUserActivePlan,
  createAdherenceCheckin,
  listAdherenceHistory,
  getMealTimeline,
  createMealCheckin,
  deletePatientNutritionData,
  type MealCheckinStatus,
} from '../services/nutriService';
import { getProfileForUser } from '../services/dietaryProfileService';
import { saveSubscription, removeSubscription, getVapidPublicKey } from '../services/pushService';
import { logDataAccessEvent, type DataAccessEventType } from '../services/dataAccessAuditService';
import {
  createUploadTarget,
  registerPhoto,
  listPhotosForUser,
  deletePhoto,
  type ProgressPose,
} from '../services/progressPhotoService';
import { StorageNotConfiguredError } from '../lib/storage';
import { deleteUserAccount, exportUserData } from '../services/accountDeletionService';
import bcryptjs from 'bcryptjs';
import pool from '../config/database';
import { registerNumericParams } from '../middleware/numericParam';
import { parseLimit } from '../utils/parseId';
import { listReviewsForStudent } from '../services/workoutReviewsService';
import { requireFeature } from '../middleware/featureGate';
import {
  estimateNutritionTarget,
  resolveNutritionTarget,
  type NutritionObjective,
  type ActivityLevel,
} from '../services/nutritionTarget';
import {
  parseAndResolve,
  persistIntakeLog,
  updateIntakeLog,
  getDayLogs,
  groupLogsIntoMeals,
  softDeleteLog,
  setFavorite,
  getShortcuts,
  classifyDayCoverage,
  ValidationError as IntakeValidationError,
  EditWindowError,
  type IntakeItemRequest,
} from '../services/nutritionIntakeService';
import { dayKey } from '../utils/appDay';
import { searchCatalogFoods } from '../services/nutritionFoodService';
import { sumNutrients } from '../services/nutritionCalculation';

const router = Router();
registerNumericParams(router, ['planId', 'mealId', 'id']);

// Eventos de UX do frontend do aluno — allow-list; actorId = subjectUserId = self.
// Mede percepção real do aluno (card renderizado), não só fetch. Espelha POST /training/events.
// Os eventos `movement_lab.*` instrumentam o beta do Lab de Movimento (validação).
const ALLOWED_FRONTEND_EVENTS = new Set<DataAccessEventType>([
  'student.session_touchpoint.viewed',
  'movement_lab.opened',
  'movement_lab.camera_error',
  'movement_lab.session_completed',
  'movement_lab.feedback_submitted',
  'retro_workout.opened',
  'retro_workout.date_selected',
  'retro_workout.submitted',
  'retro_workout.blocked_over_limit',
  // Spec 033 P1. Os eventos de PR, meta e upgrade entram com as ondas que os
  // produzem — allow-list só aceita o que já existe de verdade.
  'performance.opened',
  'performance.tab_viewed',
  'performance.progression_viewed',
  'performance.exercise_selected',
  'performance.prs_viewed',
  'performance.pr_celebrated',
  'performance.upgrade_cta_clicked',
  'performance.score_viewed',
  'performance.score_component_opened',
  'performance.score_history_viewed',
  'performance.goal_created',
  'performance.goal_viewed',
  'performance.goal_completed',
  'performance.goal_cancelled',
  'personal.performance_opened',
  'personal.performance_insight_opened',
  'personal.performance_ai_summary_requested',
  'personal.performance_ai_summary_shown',
  'community.milestone_share_changed',
  // Execução do treino no mobile (SPEC P1 §51). Emitidos pela tela de sessão.
  'workout.started',
  'workout.completed',
  'workout.abandoned',
  'workout.resumed',
  'workout.set_completed',
  'workout.exercise_skipped',
  'workout.exercise_reordered',
  'workout.repeat_set',
  'workout.rpe_selected',
  'workout.rpe_skipped',
  // Execução dinâmica — o aluno troca, desfaz, acrescenta e remove exercício
  // durante a sessão.
  'workout.exercise_substituted',
  'workout.substitution_undone',
  'workout.exercise_added',
  'workout.exercise_removed',
  // Lembrete de treino não finalizado (notificação local do app empacotado).
  'workout.reminder_scheduled',
  'workout.reminder_opened',
  'workout.free_started',
  'workout.repeat_started',
  'workout.share_opened',
  // Camada de atividade e dispositivos (SPEC Mobile P2 §70).
  'activity.started',
  'activity.paused',
  'activity.resumed',
  'activity.completed',
  'activity.abandoned',
  'activity.recovered',
  'activity.discarded',
  'activity.gps_denied',
  'activity.share_opened',
  'health_connect.connected',
  'apple_health.connected',
  'widget.workout_started',
  // Prontidão (SPEC Mobile P3 §71).
  'readiness_viewed',
  'readiness_details_opened',
  'daily_checkin_started',
  'daily_checkin_completed',
  'recommendation_accepted',
  'recommendation_ignored',
  'workout_adjustment_opened',
  // Biblioteca de Exercícios Personalizados do Personal (Sprint P1). Emitidos
  // pela tela "Meus Exercícios" e pelo builder de ficha — o personal também
  // autentica contra `authMiddleware` e cai neste endpoint genérico (não há
  // rota de eventos própria do módulo Personal).
  'personal_custom_exercise_create_started',
  'personal_custom_exercise_created',
  'personal_custom_exercise_edited',
  'personal_custom_exercise_archived',
  'personal_custom_exercise_added_to_plan',
  // Motor de Substituições Inteligentes (Sprint P2A). Emitidos pela folha de
  // sugestões que abre ANTES da busca manual, durante a execução do treino.
  'replacement_suggestions_opened',
  'replacement_suggestion_impression',
  'replacement_suggestion_selected',
  'replacement_suggestion_ignored',
  'replacement_manual_search_selected',
  'replacement_suggestions_empty',
  'replacement_suggestions_error',
  // Aderência, Recorrência e Insights do Personal (Sprint P2B). Emitidos pela
  // aba Performance (Insights) do cockpit do personal — mesmo endpoint
  // genérico de auto-relato dos demais eventos `personal_*` acima
  // (`personal_custom_exercise_*`): não existe rota de eventos própria do
  // módulo Personal.
  'personal_adherence_viewed',
  'personal_exercise_insight_viewed',
  'personal_recurring_replacement_viewed',
  'personal_plan_review_started',
  'personal_plan_review_cancelled',
  'personal_plan_updated_from_insight',
  // Denúncia de conversa no chat (compliance de loja). Chega pelos dois papéis:
  // o personal também autentica aqui, como nos demais eventos `personal_*`.
  'chat.conversation_reported',
  // Voice Workout (P5A) — só metadados de uso do loop, nunca transcript/carga/
  // reps/nome de exercício.
  'voice.activated',
  'voice.deactivated',
  'voice.listen_started',
  'voice.stt_success',
  'voice.stt_failure',
  'voice.command_success',
  'voice.command_failure',
  // P5B — máquina de confirmação, desfazer e substituição por voz.
  'voice.confirmation_requested',
  'voice.confirmation_accepted',
  'voice.confirmation_rejected',
  'voice.undo_used',
  'voice.substitution_requested',
  // P5C — spike técnico de wake word (sem fornecedor definitivo).
  'voice.wake_started',
  'voice.wake_detected',
  'voice.wake_error',
]);

router.post('/events', authMiddleware, (req: Request, res: Response) => {
  const { eventType, payload = {} } = req.body ?? {};
  if (typeof eventType !== 'string' || !ALLOWED_FRONTEND_EVENTS.has(eventType as DataAccessEventType)) {
    return res.status(400).json({ success: false, error: 'unknown_event' });
  }
  void logDataAccessEvent({
    actorId: req.user!.id,
    subjectUserId: req.user!.id,
    eventType: eventType as DataAccessEventType,
    eventPayload: typeof payload === 'object' && payload !== null ? payload : {},
    ip: req.ip,
  }).catch(() => {});
  return res.json({ success: true });
});

router.get('/professional-context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const studentId = req.user!.id;
    const context = await getProfessionalContextForStudent(studentId);
    res.json(context);
  } catch (err) {
    logger.error({ err: err }, '[user/professional-context]');
    res.status(500).json({ success: false, error: 'Failed to load professional context' });
  }
});

router.get('/workout-history', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

    const result = await pool.query<{
      workout_id: string;
      title: string;
      muscle_groups: string[];
      completed_at: string;
    }>(
      `SELECT workout_id, title, muscle_groups, completed_at
       FROM user_workout_logs
       WHERE user_id = $1 AND completed_at >= NOW() - ($2 || ' days')::interval
       ORDER BY completed_at ASC`,
      [userId, days],
    );

    const entries = result.rows.map((row) => ({
      workoutId: row.workout_id,
      title: row.title,
      muscleGroups: row.muscle_groups ?? [],
      date: row.completed_at,
    }));

    res.json(entries);
  } catch (err) {
    logger.error({ err: err }, '[user/workout-history]');
    res.status(500).json({ success: false, error: 'Failed to load workout history' });
  }
});

/**
 * Aluno abandona uma ficha — fica oculta na sua listagem mas continua
 * existindo. Só o personal pode reativar ou excluir.
 */
router.post('/workout-plans/:planId/abandon', authMiddleware, async (req: Request, res: Response) => {
  try {
    const studentId = req.user!.id;
    const planId = Number(req.params.planId);
    if (!Number.isFinite(planId)) {
      return res.status(400).json({ success: false, error: 'Invalid plan id' });
    }
    const ok = await abandonWorkoutPlan(studentId, planId);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Plan not found, not yours, or already abandoned' });
    }
    return res.json({ success: true, data: { abandoned: true } });
  } catch (err: any) {
    logger.error({ err: err }, '[user/workout-plans/abandon]');
    return res.status(500).json({ success: false, error: err.message || 'Failed to abandon plan' });
  }
});

/**
 * Feedback de revisão que o personal escreveu PARA o aluno (QA 02/ago/2026, P1-5).
 * Escopo garantido por `req.user.id` — o aluno só lê as próprias revisões.
 * Devolve apenas `approved` com feedback preenchido; `internalNotes` fica fora.
 */
router.get('/workout-reviews', authMiddleware, async (req: Request, res: Response) => {
  try {
    const reviews = await listReviewsForStudent(req.user!.id, parseLimit(req.query.limit, 10, 50));
    res.json({ success: true, data: reviews });
  } catch (err) {
    logger.error({ err }, '[user/workout-reviews]');
    res.status(500).json({ success: false, error: 'Failed to load workout reviews' });
  }
});

// ===========================================================================
// Nutrition — /user/nutrition-plan + /user/nutrition-adherence-checkins
// ===========================================================================

router.get('/nutrition-plan', authMiddleware, async (req: Request, res: Response) => {
  try {
    const plan = await getUserActivePlan(req.user!.id);
    res.json({ success: true, data: plan });
  } catch (err: any) {
    logger.error({ err: err }, '[user/nutrition-plan]');
    res.status(500).json({ success: false, error: 'Failed to load nutrition plan' });
  }
});

// Perfil Alimentar (Spec 019) — read-only do próprio usuário.
router.get('/dietary-profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const data = await getProfileForUser(req.user!.id);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error({ err: err }, '[user/dietary-profile]');
    res.status(500).json({ success: false, error: 'Failed to load dietary profile' });
  }
});

// ===========================================================================
// Meta diária de macros (PLAN_NUTRITION_QUICK_MACROS, P1A)
// ===========================================================================

const NUTRITION_OBJECTIVES: NutritionObjective[] = ['weight_loss', 'maintenance', 'muscle_gain'];
const ACTIVITY_LEVELS: ActivityLevel[] = ['low', 'moderate', 'high'];

function parseTargetInputs(body: any): { objective: NutritionObjective; activity: ActivityLevel; mealsPerDay: number } | null {
  const objective = body?.objective;
  const activity = body?.activity;
  const mealsPerDay = Number(body?.mealsPerDay);
  if (!NUTRITION_OBJECTIVES.includes(objective)) return null;
  if (!ACTIVITY_LEVELS.includes(activity)) return null;
  if (!Number.isInteger(mealsPerDay) || mealsPerDay < 3 || mealsPerDay > 6) return null;
  return { objective, activity, mealsPerDay };
}

/** Último peso conhecido (checkin metabólico ≤90 dias, senão o do perfil). Nunca aceita peso do cliente sem alternativa. */
async function resolveWeightKgForUser(userId: number): Promise<number | null> {
  const checkin = await pool.query(
    `SELECT weight_kg FROM user_metabolic_checkins
     WHERE user_id = $1 AND weight_kg IS NOT NULL AND recorded_at >= NOW() - INTERVAL '90 days'
     ORDER BY recorded_at DESC LIMIT 1`,
    [userId]
  );
  if (checkin.rows[0]?.weight_kg != null) return Number(checkin.rows[0].weight_kg);

  const profile = await pool.query(`SELECT weight_kg FROM users WHERE id = $1 LIMIT 1`, [userId]);
  return profile.rows[0]?.weight_kg != null ? Number(profile.rows[0].weight_kg) : null;
}

router.post('/nutrition-target/estimate', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const inputs = parseTargetInputs(req.body);
    if (!inputs) {
      return res.status(400).json({ success: false, error: 'objective, activity e mealsPerDay (3-6) são obrigatórios' });
    }

    const bodyWeight = Number(req.body?.weightKg);
    const weightKg = Number.isFinite(bodyWeight) && bodyWeight > 0 ? bodyWeight : await resolveWeightKgForUser(userId);
    if (!weightKg) {
      return res.status(400).json({ success: false, error: 'weightKg não informado e nenhum peso encontrado no perfil' });
    }

    const target = estimateNutritionTarget({ weightKg, ...inputs });
    res.json({ success: true, data: { ...target, weightKgUsed: weightKg } });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-target/estimate]');
    res.status(500).json({ success: false, error: 'Failed to estimate nutrition target' });
  }
});

router.get('/nutrition-target', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const [plan, selfRow] = await Promise.all([
      getUserActivePlan(userId),
      pool.query(
        `SELECT energy_kcal, protein_g, carbohydrate_g, fat_g, meals_per_day, inputs
         FROM user_nutrition_targets WHERE user_id = $1 LIMIT 1`,
        [userId]
      ),
    ]);

    const selfTarget = selfRow.rows[0]
      ? {
          energyKcal: Number(selfRow.rows[0].energy_kcal),
          proteinG: Number(selfRow.rows[0].protein_g),
          carbohydrateG: Number(selfRow.rows[0].carbohydrate_g),
          fatG: Number(selfRow.rows[0].fat_g),
          mealsPerDay: Number(selfRow.rows[0].meals_per_day),
        }
      : null;

    const resolved = resolveNutritionTarget({
      planDayTotals: plan?.dayTotals ?? null,
      planMealsCount: plan?.meals?.length ?? null,
      selfTarget,
    });

    res.json({
      success: true,
      data: {
        target: resolved,
        selfEstimateInputs: selfRow.rows[0]?.inputs ?? null,
        nutriName: resolved?.source === 'plan_items' ? plan?.nutri_name ?? null : null,
      },
    });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-target GET]');
    res.status(500).json({ success: false, error: 'Failed to load nutrition target' });
  }
});

router.put('/nutrition-target', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const inputs = parseTargetInputs(req.body);
    if (!inputs) {
      return res.status(400).json({ success: false, error: 'objective, activity e mealsPerDay (3-6) são obrigatórios' });
    }

    const bodyWeight = Number(req.body?.weightKg);
    const weightKg = Number.isFinite(bodyWeight) && bodyWeight > 0 ? bodyWeight : await resolveWeightKgForUser(userId);
    if (!weightKg) {
      return res.status(400).json({ success: false, error: 'weightKg não informado e nenhum peso encontrado no perfil' });
    }

    // Backend recalcula do zero a partir dos inputs — nunca aceita kcal/macro enviado pelo cliente.
    const target = estimateNutritionTarget({ weightKg, ...inputs });

    const upserted = await pool.query(
      `INSERT INTO user_nutrition_targets (user_id, source, energy_kcal, protein_g, carbohydrate_g, fat_g, meals_per_day, formula_version, inputs)
       VALUES ($1, 'self_estimate', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         source = 'self_estimate',
         energy_kcal = EXCLUDED.energy_kcal,
         protein_g = EXCLUDED.protein_g,
         carbohydrate_g = EXCLUDED.carbohydrate_g,
         fat_g = EXCLUDED.fat_g,
         meals_per_day = EXCLUDED.meals_per_day,
         formula_version = EXCLUDED.formula_version,
         inputs = EXCLUDED.inputs,
         updated_at = NOW()
       RETURNING energy_kcal, protein_g, carbohydrate_g, fat_g, meals_per_day`,
      [
        userId,
        target.energyKcal,
        target.proteinG,
        target.carbohydrateG,
        target.fatG,
        target.mealsPerDay,
        target.formulaVersion,
        JSON.stringify({ weightKg, objective: inputs.objective, activity: inputs.activity }),
      ]
    );

    const plan = await getUserActivePlan(userId);
    const row = upserted.rows[0];
    const resolved = resolveNutritionTarget({
      planDayTotals: plan?.dayTotals ?? null,
      planMealsCount: plan?.meals?.length ?? null,
      selfTarget: {
        energyKcal: Number(row.energy_kcal),
        proteinG: Number(row.protein_g),
        carbohydrateG: Number(row.carbohydrate_g),
        fatG: Number(row.fat_g),
        mealsPerDay: Number(row.meals_per_day),
      },
    });

    res.json({ success: true, data: { target: resolved } });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-target PUT]');
    res.status(500).json({ success: false, error: 'Failed to save nutrition target' });
  }
});

// ===========================================================================
// Registro rápido de refeição (PLAN_NUTRITION_QUICK_MACROS, P1B)
// ===========================================================================

// Busca no catálogo (TACO) para o aluno resolver manualmente um item "?" que
// o parser não reconheceu — mesmo dado licenciado/não sensível já exposto ao
// nutri em `/nutri/foods`, só que do lado do aluno.
router.get('/nutrition-foods/search', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number(req.query.limit) || 10;
    const foods = await searchCatalogFoods(q, limit);
    res.json({ success: true, data: foods });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-foods/search]');
    res.status(500).json({ success: false, error: 'Failed to search foods' });
  }
});

router.post('/nutrition-intake/parse', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ success: false, error: 'text é obrigatório' });
    // `userId` habilita o estágio de histórico (whey/manuais reaproveitáveis)
    // e o fallback opcional de IA quando `nutrition_intake_ai` está ligada
    // para este usuário (PLAN P1B.1) — nenhum dos dois altera o caminho
    // determinístico puro quando não se aplicam.
    const preview = await parseAndResolve(text, req.user!.id);
    res.json({ success: true, data: preview });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-intake/parse]');
    res.status(500).json({ success: false, error: 'Failed to parse intake text' });
  }
});

router.post('/nutrition-intake', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { label, rawText, mealId, items, source } = req.body ?? {};
    const validSources = ['parse', 'parse_ai', 'manual', 'repeat', 'favorite', 'plan'];
    if (!validSources.includes(source)) {
      return res.status(400).json({ success: false, error: `source deve ser um de: ${validSources.join(', ')}` });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items é obrigatório' });
    }

    const log = await persistIntakeLog({
      userId,
      label: typeof label === 'string' ? label : '',
      rawText: typeof rawText === 'string' ? rawText : null,
      // `Number(null) === 0` e `Number.isFinite(0) === true` — coagir sem
      // checar null/undefined primeiro transformava um `mealId: null`
      // explícito (refeição extra, PLAN P1B corrective §7) em `mealId: 0`,
      // que quebra a FK (nenhuma `nutrition_plan_meals.id` é 0).
      mealId: mealId != null && Number.isFinite(Number(mealId)) ? Number(mealId) : null,
      items: items as IntakeItemRequest[],
      source,
    });

    res.status(201).json({ success: true, data: log });
  } catch (err: any) {
    if (err instanceof IntakeValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    logger.error({ err }, '[user/nutrition-intake POST]');
    res.status(500).json({ success: false, error: 'Failed to save intake log' });
  }
});

router.get('/nutrition-intake', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : dayKey();

    const [logs, plan, selfRow] = await Promise.all([
      getDayLogs(userId, date),
      getUserActivePlan(userId),
      pool.query(
        `SELECT energy_kcal, protein_g, carbohydrate_g, fat_g, meals_per_day
           FROM user_nutrition_targets WHERE user_id = $1 LIMIT 1`,
        [userId]
      ),
    ]);

    const selfTarget = selfRow.rows[0]
      ? {
          energyKcal: Number(selfRow.rows[0].energy_kcal),
          proteinG: Number(selfRow.rows[0].protein_g),
          carbohydrateG: Number(selfRow.rows[0].carbohydrate_g),
          fatG: Number(selfRow.rows[0].fat_g),
          mealsPerDay: Number(selfRow.rows[0].meals_per_day),
        }
      : null;

    const target = resolveNutritionTarget({
      planDayTotals: plan?.dayTotals ?? null,
      planMealsCount: plan?.meals?.length ?? null,
      selfTarget,
    });

    const totals = sumNutrients(logs.map((l) => ({
      energyKcal: l.energyKcal, proteinG: l.proteinG, carbohydrateG: l.carbohydrateG, fatG: l.fatG,
      fiberG: l.fiberG, sodiumMg: null,
    })));
    const coverage = classifyDayCoverage(logs, target?.mealsPerDay ?? 3);

    // PLAN_NUTRITION_QUICK_MACROS (P1B — adendo "Seu dia nutricional") — a
    // curva "planejado" do gráfico de evolução só existe quando há plano
    // ESTRUTURADO (itens de refeição, não só orientação em texto). Nunca
    // reconstruída a partir da estimativa própria — aí a divisão fica
    // "distribuição orientativa" e é responsabilidade do cliente montá-la a
    // partir de `target.mealsPerDay`, sem dado novo do servidor.
    const plannedMeals = (plan?.meals ?? [])
      .filter((m: any) => Array.isArray(m.items) && m.items.length > 0 && m.totals?.energyKcal > 0)
      .map((m: any) => ({ mealId: m.id, name: m.name, orderIndex: m.order_index, energyKcal: m.totals.energyKcal }));

    // PLAN P1B corrective ("Agrupamento por Refeição") — a unidade visual é
    // a refeição, não o log; `meals` agrupa por associação persistida
    // (meal_id do plano) e nunca por horário/rótulo parecido.
    const meals = groupLogsIntoMeals(logs);

    res.json({ success: true, data: { date, logs, meals, totals, coverage, target, plannedMeals } });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-intake GET]');
    res.status(500).json({ success: false, error: 'Failed to load intake logs' });
  }
});

router.delete('/nutrition-intake/:id', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const ok = await softDeleteLog(req.user!.id, id);
    if (!ok) return res.status(404).json({ success: false, error: 'Log not found' });
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof EditWindowError) {
      return res.status(403).json({ success: false, error: 'edit_window_exceeded' });
    }
    logger.error({ err }, '[user/nutrition-intake DELETE]');
    res.status(500).json({ success: false, error: 'Failed to delete intake log' });
  }
});

// PLAN P1B corrective ("Consulta + Edição de Refeição Registrada") —
// edição de conteúdo do log. Nunca aceita `dateKey`/`loggedAt`/`mealId` do
// cliente (preserva o registro original, §9); ownership via
// `updateIntakeLog` (mesmo padrão de `softDeleteLog`/`setFavorite`).
router.patch('/nutrition-intake/:id', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

    const { label, rawText, items, source } = req.body ?? {};
    const validSources = ['parse', 'parse_ai', 'manual', 'repeat', 'favorite', 'plan'];
    if (!validSources.includes(source)) {
      return res.status(400).json({ success: false, error: `source deve ser um de: ${validSources.join(', ')}` });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items é obrigatório' });
    }

    const log = await updateIntakeLog(req.user!.id, id, {
      label: typeof label === 'string' ? label : '',
      rawText: typeof rawText === 'string' ? rawText : null,
      items: items as IntakeItemRequest[],
      source,
    });
    if (!log) return res.status(404).json({ success: false, error: 'Log not found' });
    res.json({ success: true, data: log });
  } catch (err: any) {
    if (err instanceof IntakeValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof EditWindowError) {
      return res.status(403).json({ success: false, error: 'edit_window_exceeded' });
    }
    logger.error({ err }, '[user/nutrition-intake PATCH]');
    res.status(500).json({ success: false, error: 'Failed to update intake log' });
  }
});

router.patch('/nutrition-intake/:id/favorite', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const favorite = Boolean(req.body?.favorite);
    const ok = await setFavorite(req.user!.id, id, favorite);
    if (!ok) return res.status(404).json({ success: false, error: 'Log not found' });
    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-intake/:id/favorite]');
    res.status(500).json({ success: false, error: 'Failed to update favorite' });
  }
});

router.get('/nutrition-intake/shortcuts', authMiddleware, requireFeature('nutrition_intake'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const [shortcuts, plan] = await Promise.all([getShortcuts(userId), getUserActivePlan(userId)]);
    const planMeals = (plan?.meals ?? [])
      .filter((m: any) => Array.isArray(m.items) && m.items.length > 0)
      .map((m: any) => ({ mealId: m.id, name: m.name, items: m.items }));
    res.json({ success: true, data: { ...shortcuts, planMeals } });
  } catch (err: any) {
    logger.error({ err }, '[user/nutrition-intake/shortcuts]');
    res.status(500).json({ success: false, error: 'Failed to load shortcuts' });
  }
});

router.post('/nutrition-adherence-checkins', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { adherence, note } = req.body;

    const validAdherence = ['full', 'partial', 'skipped'];
    if (!validAdherence.includes(adherence)) {
      return res.status(400).json({ success: false, error: 'adherence must be full, partial, or skipped' });
    }

    const plan = await getUserActivePlan(userId);
    if (!plan) {
      return res.status(404).json({ success: false, error: 'No active nutrition plan' });
    }

    const result = await createAdherenceCheckin(
      userId,
      plan.id,
      adherence,
      typeof note === 'string' ? note : null
    );

    if (result.error) {
      return res.status(result.status ?? 400).json({ success: false, error: result.error });
    }
    return res.status(201).json({ success: true, data: result.data });
  } catch (err: any) {
    logger.error({ err: err }, '[user/nutrition-adherence-checkins]');
    return res.status(500).json({ success: false, error: 'Failed to record checkin' });
  }
});

router.get('/nutrition-adherence-checkins', authMiddleware, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const rows = await listAdherenceHistory(req.user!.id, days);
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to load adherence history' });
  }
});

// ===========================================================================
// Meal timeline — Onda A
// ===========================================================================

router.get('/meals/today', authMiddleware, async (req: Request, res: Response) => {
  try {
    const timeline = await getMealTimeline(req.user!.id);
    res.json({ success: true, data: timeline });
  } catch (err: any) {
    logger.error({ err: err }, '[user/meals/today]');
    res.status(500).json({ success: false, error: 'Failed to load meal timeline' });
  }
});

router.post('/meals/:mealId/checkins', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const mealId = Number(req.params.mealId);
    if (!Number.isFinite(mealId)) {
      return res.status(400).json({ success: false, error: 'Invalid mealId' });
    }

    const validStatuses: MealCheckinStatus[] = ['done', 'partial', 'skipped', 'substituted', 'delayed'];
    const { status, satiety, hunger, energy, note, substitutedAlternativeId } = req.body;

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const safeInt = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
    };

    const safeAltId = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const result = await createMealCheckin(userId, mealId, {
      status,
      satiety: safeInt(satiety),
      hunger: safeInt(hunger),
      energy: safeInt(energy),
      note: typeof note === 'string' ? note : null,
      substitutedAlternativeId: safeAltId(substitutedAlternativeId),
    });

    if (result.error) {
      return res.status(result.status ?? 400).json({ success: false, error: result.error });
    }
    return res.status(result.updated ? 200 : 201).json({ success: true, data: result.data });
  } catch (err: any) {
    logger.error({ err: err }, '[user/meals/:mealId/checkins]');
    return res.status(500).json({ success: false, error: 'Failed to record meal checkin' });
  }
});

// ===========================================================================
// LGPD — exclusão de dados nutricionais (paciente solicita)
// Requer confirmação explícita no body para evitar deleção acidental.
// ===========================================================================

router.delete('/nutrition-data', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        success: false,
        error: 'confirmation_required',
        message: 'Envie { "confirm": true } no corpo da requisição para confirmar a exclusão.',
      });
    }

    const patientId = req.user!.id;
    const result = await deletePatientNutritionData(patientId);

    return res.json({
      success: true,
      message: 'Dados nutricionais excluídos conforme solicitação LGPD.',
      deleted: result,
    });
  } catch (err: any) {
    logger.error({ err: err }, '[user/nutrition-data DELETE]');
    return res.status(500).json({ success: false, error: 'Failed to delete nutrition data' });
  }
});

// ===========================================================================
// Web Push subscriptions
// ===========================================================================

router.get('/push/vapid-public-key', authMiddleware, (_req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ success: false, error: 'push_not_configured' });
  return res.json({ success: true, data: { key } });
});

router.post('/push/subscriptions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, error: 'invalid_subscription' });
    }
    await saveSubscription(userId, { endpoint, keys }, deviceLabel);
    return res.status(201).json({ success: true });
  } catch (err: any) {
    logger.error({ err: err }, '[user/push/subscriptions]');
    return res.status(500).json({ success: false, error: 'Failed to save subscription' });
  }
});

router.delete('/push/subscriptions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint_required' });
    await removeSubscription(userId, endpoint);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error({ err: err }, '[user/push/subscriptions DELETE]');
    return res.status(500).json({ success: false, error: 'Failed to remove subscription' });
  }
});

// ===========================================================================
// Fotos de progresso (Spec 020) — dado sensível do aluno. Dono = req.user.id;
// a storage_key é derivada no servidor, nunca vinda do cliente. Leitura/escrita
// sempre escopadas ao próprio usuário. (Leitura profissional fica em /personal
// e /nutri, gated por requireActiveConsent('body_photos').)
// ===========================================================================

function handleStorageError(err: any, res: Response, ctx: string): boolean {
  if (err instanceof StorageNotConfiguredError) {
    logger.error({ err }, `[user/progress-photos] ${ctx} — storage não configurado`);
    res.status(503).json({ success: false, error: 'storage_unavailable' });
    return true;
  }
  return false;
}

router.post('/progress/photos/upload-url', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { contentType, byteSize } = req.body ?? {};
    if (typeof contentType !== 'string') {
      return res.status(400).json({ success: false, error: 'content_type_required' });
    }
    const target = await createUploadTarget(userId, contentType, Number(byteSize));
    return res.json({ success: true, data: target });
  } catch (err: any) {
    if (handleStorageError(err, res, 'upload-url')) return;
    if (err?.code === 'VALIDATION') {
      return res.status(400).json({ success: false, error: err.message });
    }
    logger.error({ err }, '[user/progress-photos upload-url]');
    return res.status(500).json({ success: false, error: 'Failed to create upload url' });
  }
});

router.post('/progress/photos', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { storageKey, takenAt, pose, note } = req.body ?? {};
    if (typeof storageKey !== 'string') {
      return res.status(400).json({ success: false, error: 'storage_key_required' });
    }
    const photo = await registerPhoto(userId, {
      storageKey,
      takenAt: typeof takenAt === 'string' ? takenAt : undefined,
      pose: pose as ProgressPose | undefined,
      note: typeof note === 'string' ? note : undefined,
    });
    return res.status(201).json({ success: true, data: { photo } });
  } catch (err: any) {
    if (handleStorageError(err, res, 'register')) return;
    if (err?.code === 'FORBIDDEN') return res.status(403).json({ success: false, error: err.message });
    if (err?.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    if (err?.code === 'VALIDATION') return res.status(400).json({ success: false, error: err.message });
    logger.error({ err }, '[user/progress-photos register]');
    return res.status(500).json({ success: false, error: 'Failed to register photo' });
  }
});

router.get('/progress/photos', authMiddleware, async (req: Request, res: Response) => {
  try {
    const photos = await listPhotosForUser(req.user!.id);
    return res.json({ success: true, data: { photos } });
  } catch (err: any) {
    if (handleStorageError(err, res, 'list')) return;
    logger.error({ err }, '[user/progress-photos list]');
    return res.status(500).json({ success: false, error: 'Failed to list photos' });
  }
});

router.delete('/progress/photos/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const photoId = Number(req.params.id);
    if (!Number.isFinite(photoId)) return res.status(400).json({ success: false, error: 'invalid_id' });
    const ok = await deletePhoto(req.user!.id, photoId);
    if (!ok) return res.status(404).json({ success: false, error: 'not_found' });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, '[user/progress-photos delete]');
    return res.status(500).json({ success: false, error: 'Failed to delete photo' });
  }
});

// ===========================================================================
// Conta — Exportação e Exclusão (Spec 025 · LGPD art. 18 · blocker de loja).
// Self-service do próprio usuário; escopado 100% por req.user.id.
// ===========================================================================

router.get('/account/export', authMiddleware, async (req: Request, res: Response) => {
  try {
    const data = await exportUserData(req.user!.id);
    res.setHeader('Content-Disposition', 'attachment; filename="s2core-meus-dados.json"');
    return res.json({ success: true, data });
  } catch (err: any) {
    logger.error({ err }, '[user/account/export]');
    return res.status(500).json({ success: false, error: 'Failed to export data' });
  }
});

router.delete('/account', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { password, confirmation } = req.body ?? {};

    if (confirmation !== 'EXCLUIR') {
      return res.status(400).json({ success: false, error: 'confirmation_required' });
    }

    // Re-auth: se o usuário tem senha local (cadastro por email), exigir e validar.
    // OAuth-only (Google/Apple, sem senha) → a sessão + confirmação já bastam.
    const pwRes = await pool.query<{ password: string | null }>(
      `SELECT password FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (pwRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }
    const storedHash = pwRes.rows[0].password;
    const hasLocalPassword = typeof storedHash === 'string' && storedHash.length > 0;
    if (hasLocalPassword) {
      if (typeof password !== 'string' || !(await bcryptjs.compare(password, storedHash!))) {
        return res.status(401).json({ success: false, error: 'invalid_password' });
      }
    }

    await deleteUserAccount(userId, { requestedBy: 'self', reason: 'self_service' });
    return res.json({ success: true });
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'user_not_found' });
    logger.error({ err }, '[user/account DELETE]');
    return res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

export default router;
