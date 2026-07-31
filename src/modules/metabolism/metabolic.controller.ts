import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireProduct } from '../../middleware/productGate';
import { getMetabolismForUser, getMetabolismHistoryForUser } from './metabolic.service';
import logger from '../../lib/logger';

const router = Router();

/**
 * P0-4 da auditoria: o cálculo de metabolismo aciona IA (getMetabolicHint via
 * interpretation) — exigir o produto 'app' para não expor custo de IA a
 * qualquer autenticado. Freio anterior era só o rate limit por usuário.
 *
 * ⚠️ Aplicado POR ROTA, nunca com `router.use()`.
 *
 * Este router é montado no prefixo `/api` INTEIRO (`app.use('/api', metabolismRoutes)`),
 * porque suas rotas são `/me/metabolism*`. Com `router.use(requireProduct('app'))`,
 * o gate rodava em TODA requisição a `/api/*` que chegasse até aqui — e derrubava
 * com 403 tudo que estivesse montado DEPOIS no index.ts.
 *
 * Efeito observado em produção (31/07/2026): todo personal criado pelo cadastro
 * público (Spec 026) recebia 403 em `/api/professional/*`, `/api/sport/*`,
 * `/api/training/*` e `/api/waitlist` — porque o cadastro de personal concede
 * apenas o produto `personal`, e não `app` (que é do aluno), por design.
 * Passou despercebido porque as contas legadas de teste tinham `app` por seed,
 * e porque `/api/personal` está montado ANTES desta linha.
 */
const gate = [authMiddleware, requireProduct('app')];

router.get('/me/metabolism', ...gate, async (req: Request, res: Response) => {
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

router.get('/me/metabolism/history', ...gate, async (req: Request, res: Response) => {
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
