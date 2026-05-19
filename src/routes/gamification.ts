import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import {
  getGamificationSummary,
  recordGamificationCheckin,
  type WellbeingSignals,
} from '../services/gamificationService';
import { requireFeature } from '../middleware/featureGate';

const router = Router();
// requireAcademyContext removido: standalone user tem gamification (XP, streak)
// armazenado por user_id. getGamificationSummary aceita academyId null.
router.use(authMiddleware, requireProduct('app'));

router.get('/summary', requireFeature('workout_history'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getGamificationSummary(req.user!.id, false, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load gamification summary' });
  }
});

router.post(
  '/checkins',
  (req: Request, res: Response, next: NextFunction) => {
    // wellbeing e workout são sinais essenciais de aderência — não devem
    // estar atrás do gate de Activity Tracker GPS. Só 'activity' (GPS)
    // exige o feature 'tracker'.
    const src = req.body?.source;
    if (src === 'wellbeing' || src === 'workout') return next();
    return requireFeature('tracker')(req, res, next);
  },
  async (req: Request, res: Response) => {
    try {
      const source = req.body.source;

      if (source !== 'workout' && source !== 'activity' && source !== 'wellbeing') {
        return res.status(400).json({ success: false, error: 'Invalid check-in source' });
      }

      if (source === 'wellbeing') {
        const s = req.body.signals;
        if (!s || typeof s !== 'object') {
          return res.status(400).json({ success: false, error: 'Wellbeing check-in requires signals' });
        }
        const hasSignal =
          s.feeling != null ||
          s.sleptWell != null ||
          s.inPain != null ||
          s.stressed != null ||
          s.hydrationOk != null ||
          s.nutritionLevel != null ||
          s.mentalLoadLevel != null ||
          (typeof s.notes === 'string' && s.notes.trim().length > 0);
        if (!hasSignal) {
          return res.status(400).json({ success: false, error: 'At least one wellbeing signal is required' });
        }
      }

      const xp = Number(req.body.xp || 0);

      if (source === 'workout' && !req.body.workout) {
        return res.status(400).json({ success: false, error: 'Workout payload required' });
      }

      if (req.user?.accessProfile === 'clientes_sb' && source === 'activity') {
        return res.status(403).json({ success: false, error: 'Activity check-ins are not available for this profile' });
      }

      if (source === 'activity' && !req.body.activity) {
        return res.status(400).json({ success: false, error: 'Activity payload required' });
      }

      const rawSig = req.body.signals;
      let signals: WellbeingSignals | null = null;
      if (rawSig && typeof rawSig === 'object') {
        const feelingRaw = rawSig.feeling;
        let feeling: 'tired' | 'neutral' | 'energized' | null = null;
        if (feelingRaw === 'tired' || feelingRaw === 'neutral' || feelingRaw === 'energized') {
          feeling = feelingRaw;
        } else if (feelingRaw === 'normal') {
          feeling = 'neutral';
        }
        const nutritionRaw = rawSig.nutritionLevel;
        const nutritionLevel =
          nutritionRaw === 'poor' || nutritionRaw === 'ok' || nutritionRaw === 'good' ? nutritionRaw : null;
        const mentalRaw = rawSig.mentalLoadLevel;
        const mentalLoadLevel =
          mentalRaw === 'low' || mentalRaw === 'medium' || mentalRaw === 'high' ? mentalRaw : null;
        signals = {
          feeling,
          sleptWell: rawSig.sleptWell != null ? Boolean(rawSig.sleptWell) : null,
          inPain: rawSig.inPain != null ? Boolean(rawSig.inPain) : null,
          stressed: rawSig.stressed != null ? Boolean(rawSig.stressed) : null,
          hydrationOk: rawSig.hydrationOk != null ? Boolean(rawSig.hydrationOk) : null,
          nutritionLevel,
          mentalLoadLevel,
          notes: typeof rawSig.notes === 'string' ? rawSig.notes : null,
        };
      }

      const data = await recordGamificationCheckin({
        userId: req.user!.id,
        academyId: req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null,
        source,
        xp: source === 'wellbeing' ? 0 : xp,
        workout: req.body.workout,
        activity: req.body.activity,
        signals,
      });

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message || 'Failed to persist gamification event' });
    }
  },
);

export default router;
