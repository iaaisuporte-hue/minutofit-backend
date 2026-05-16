import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getProfessionalContextForStudent } from '../services/professionalContextService';

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

export default router;
