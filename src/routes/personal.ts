import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { getPersonalConsulting, getPersonalDashboard } from '../services/personalDashboardService';

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

export default router;
