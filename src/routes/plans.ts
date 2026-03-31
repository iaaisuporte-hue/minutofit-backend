import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import * as planFeatureService from '../services/planFeatureService';

const router = Router();

router.get('/plans', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const plans = await planFeatureService.listPlans();
    res.json({ success: true, data: { plans } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/features', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const features = await planFeatureService.listFeatures();
    res.json({ success: true, data: { features } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/plans/:id/features', authMiddleware, async (req: Request, res: Response) => {
  try {
    const planId = Number(req.params.id);
    if (!Number.isFinite(planId)) {
      return res.status(400).json({ success: false, error: 'Invalid plan id' });
    }
    const data = await planFeatureService.getPlanFeatures(planId);
    res.json({ success: true, data });
  } catch (error: any) {
    if (error.message === 'PLAN_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/plans/:id/features', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const planId = Number(req.params.id);
    if (!Number.isFinite(planId)) {
      return res.status(400).json({ success: false, error: 'Invalid plan id' });
    }

    const items = Array.isArray(req.body?.features) ? req.body.features : null;
    if (!items) {
      return res.status(400).json({ success: false, error: 'features array is required' });
    }

    const updates = items.map((item: any) => ({
      key: String(item?.key || '').trim(),
      enabled: Boolean(item?.enabled),
    }));

    if (updates.some((item) => !item.key)) {
      return res.status(400).json({ success: false, error: 'Each feature item requires key' });
    }

    const result = await planFeatureService.updatePlanFeatures(planId, updates);
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error.message === 'PLAN_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    if (String(error.message).startsWith('FEATURES_NOT_FOUND:')) {
      return res.status(400).json({ success: false, error: 'Some feature keys were not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/me/features', authMiddleware, async (req: Request, res: Response) => {
  try {
    const data = await planFeatureService.getFeatureMapForUser(req.user!.id);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
