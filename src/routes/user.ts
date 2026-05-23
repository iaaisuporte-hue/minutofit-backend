import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getProfessionalContextForStudent } from '../services/professionalContextService';
import { abandonWorkoutPlan } from '../services/personalWorkoutPlanService';
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

export default router;
