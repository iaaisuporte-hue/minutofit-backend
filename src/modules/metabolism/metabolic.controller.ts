import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireProduct } from '../../middleware/productGate';
import { getMetabolismForUser, getMetabolismHistoryForUser } from './metabolic.service';
import logger from '../../lib/logger';

const router = Router();

// P0-4 da auditoria: o cálculo de metabolismo aciona IA (getMetabolicHint via
// interpretation) — exigir o produto 'app' para não expor custo de IA a
// qualquer autenticado. Freio anterior era só o rate limit por usuário.
router.use(authMiddleware, requireProduct('app'));

router.get('/me/metabolism', async (req: Request, res: Response) => {
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

router.get('/me/metabolism/history', async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const data = await getMetabolismHistoryForUser(req.user.id, days);

    return res.json(data);
  } catch (error) {
    logger.error({ err: error }, '[metabolism] error fetching history');
    return res.status(500).json({ error: 'Falha ao buscar histórico metabólico' });
  }
});

export default router;
