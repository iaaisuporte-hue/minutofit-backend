import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { getPersonalConsulting, getPersonalDashboard, getPersonalStudentSnapshot } from '../services/personalDashboardService';
import {
  createPersonalWorkoutPlan,
  listPersonalWorkoutPlans,
  listWorkoutPlansForStudent,
} from '../services/personalWorkoutPlanService';

const router = Router();

router.get('/dashboard', authMiddleware, roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const data = await getPersonalDashboard(req.user!.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal dashboard' });
  }
});

router.get('/consulting/students', authMiddleware, roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const data = await getPersonalConsulting(req.user!.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal consulting students' });
  }
});

router.get(
  '/students/:studentId/snapshot',
  authMiddleware,
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const data = await getPersonalStudentSnapshot(req.user!.id, studentId);
      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to load student snapshot' });
    }
  }
);

router.get(
  '/students/:studentId/workout-plans',
  authMiddleware,
  roleCheckMiddleware('personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const limitRaw = Number(req.query.limit);
      const rows = await listPersonalWorkoutPlans(req.user!.id, studentId, Number.isFinite(limitRaw) ? limitRaw : 50);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to list workout plans' });
    }
  }
);

router.post(
  '/students/:studentId/workout-plans',
  authMiddleware,
  roleCheckMiddleware('personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title : '';
      const weekPreset = typeof body.weekPreset === 'string' ? body.weekPreset : String(body.weekPreset ?? '5');
      const selectedGroup =
        body.selectedGroup === null || body.selectedGroup === undefined
          ? null
          : String(body.selectedGroup);
      const items = Array.isArray(body.items) ? body.items : [];

      const row = await createPersonalWorkoutPlan(req.user!.id, studentId, {
        title,
        weekPreset,
        selectedGroup,
        items,
      });

      res.status(201).json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to save workout plan' });
    }
  }
);

router.get(
  '/my/workout-plans',
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'nutri', 'admin'),
  async (req: Request, res: Response) => {
  try {
    const limitRaw = Number(req.query.limit);
    const rows = await listWorkoutPlansForStudent(req.user!.id, Number.isFinite(limitRaw) ? limitRaw : 20);
    res.json({ success: true, data: rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list my workout plans' });
  }
  }
);

export default router;
