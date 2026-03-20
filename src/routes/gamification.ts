import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getGamificationSummary, recordGamificationCheckin } from '../services/gamificationService';

const router = Router();

router.get('/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const data = await getGamificationSummary(req.user!.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load gamification summary' });
  }
});

router.post('/checkins', authMiddleware, async (req: Request, res: Response) => {
  try {
    const source = req.body.source;
    const xp = Number(req.body.xp || 0);

    if (source !== 'workout' && source !== 'activity') {
      return res.status(400).json({ success: false, error: 'Invalid check-in source' });
    }

    const data = await recordGamificationCheckin({
      userId: req.user!.id,
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
