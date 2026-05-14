import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { getMetabolismForUser, getMetabolismHistoryForUser } from './metabolic.service';
import logger from '../../lib/logger';

const router = Router();

router.get('/me/metabolism', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const data = await getMetabolismForUser(req.user.id);

    return res.json(data);
  } catch (error) {
    logger.error({ err: error }, '[metabolism] error computing score');
    return res.status(500).json({ error: 'Falha ao calcular metabolismo' });
  }
});

router.get('/me/metabolism/history', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const data = await getMetabolismHistoryForUser(req.user.id);

    return res.json(data);
  } catch (error) {
    logger.error({ err: error }, '[metabolism] error fetching history');
    return res.status(500).json({ error: 'Falha ao buscar histórico metabólico' });
  }
});

export default router;
