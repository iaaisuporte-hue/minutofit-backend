import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import logger from '../lib/logger';
import { createMetabolicCheckin, listMetabolicCheckins } from '../services/metabolicCheckinService';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit != null ? Number(req.query.limit) : 50;
    const records = await listMetabolicCheckins(req.user!.id, limit);
    return res.json({ success: true, data: { records } });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'GET /api/metabolic-checkins error');
    return res.status(500).json({ success: false, error: 'Não conseguimos carregar suas atualizações.' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const record = await createMetabolicCheckin(req.user!.id, academyId, {
      ...req.body,
      source: 'self_report',
    });
    return res.status(201).json({ success: true, data: { record } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Não conseguimos salvar sua atualização.';
    logger.warn({ err, userId: req.user?.id }, 'POST /api/metabolic-checkins rejected');
    return res.status(400).json({ success: false, error: message });
  }
});

export default router;
