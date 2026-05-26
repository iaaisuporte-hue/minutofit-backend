import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getProfessionalContextForStudent } from '../services/professionalContextService';
import { abandonWorkoutPlan } from '../services/personalWorkoutPlanService';
import { getUserActivePlan, createAdherenceCheckin, listAdherenceHistory } from '../services/nutriService';
import pool from '../config/database';

const router = Router();

router.get('/professional-context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const studentId = req.user!.id;
    const context = await getProfessionalContextForStudent(studentId);
    res.json(context);
  } catch (err) {
    console.error('[user/professional-context]', err);
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
    console.error('[user/workout-history]', err);
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
    console.error('[user/workout-plans/abandon]', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to abandon plan' });
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
    console.error('[user/nutrition-plan]', err);
    res.status(500).json({ success: false, error: 'Failed to load nutrition plan' });
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
    console.error('[user/nutrition-adherence-checkins]', err);
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

export default router;
