import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAcademyContext } from '../middleware/tenantContext';
import { getGamificationSummary, recordGamificationCheckin } from '../services/gamificationService';
import { requireFeature } from '../middleware/featureGate';

const router = Router();
router.use(authMiddleware, requireAcademyContext);

router.get('/summary', requireFeature('workout_history'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getGamificationSummary(req.user!.id, false, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load gamification summary' });
  }
});

router.post('/checkins', requireFeature('tracker'), async (req: Request, res: Response) => {
  try {
    const source = req.body.source;
    const xp = Number(req.body.xp || 0);

    if (source !== 'workout' && source !== 'activity') {
      return res.status(400).json({ success: false, error: 'Invalid check-in source' });
    }

    if (req.user?.accessProfile === 'clientes_sb' && source === 'activity') {
      return res.status(403).json({ success: false, error: 'Activity check-ins are not available for this profile' });
    }

    const data = await recordGamificationCheckin({
      userId: req.user!.id,
      academyId: req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null,
      source,
      xp,
      workout: req.body.workout,
      activity: req.body.activity,
    });

    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message || 'Failed to persist gamification event' });
  }
});

export default router;
