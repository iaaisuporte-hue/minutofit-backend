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
