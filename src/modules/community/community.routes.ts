/**
 * Rotas de comunidade (Spec 034, Onda C1 — só marcos).
 *
 * Isolamento: o dono sai SEMPRE do JWT (`req.user!.id`). Nenhuma rota aceita
 * `userId` por param, query ou body — não existe superfície de IDOR porque não
 * existe identificador de terceiro a informar. Um aluno não tem como pedir o
 * marco de outro nem por engano.
 *
 * Marcos são **Free**: são a leitura da própria trajetória, e cobrar por ver o
 * que você mesmo fez contradiz o pacto de dados. A chave `milestones_history`
 * (Premium) existe na spec para histórico estendido, não para a aba.
 */
import { Router, Request, Response } from 'express';

import { authMiddleware } from '../../middleware/auth';
import { requireProduct } from '../../middleware/productGate';
import { createRateLimiter } from '../../lib/rateLimiter';
import logger from '../../lib/logger';
import { listMilestonesForUser, setMilestoneShared } from './milestones.service';

const router = Router();
router.use(authMiddleware, requireProduct('app'));

/**
 * A leitura parece barata e não é: cada GET reavalia os marcos (recuperação por
 * pull), o que abre transação, toma advisory lock e pode gravar. Sem limite, um
 * cliente autenticado em laço prende conexões do pool e degrada o backend
 * inteiro — não só a própria conta. 60/hora cobre com folga abrir a aba,
 * trocar de aba e voltar; abaixo disso ninguém navega.
 */
const communityLimiter = createRateLimiter({
  storeKey: 'community_read',
  keyFn: (req) => `user:${req.user!.id}`,
  limit: 60,
  windowSeconds: 3600,
  errorMessage: 'Muitas requisições. Tente novamente em instantes.',
});
router.use(communityLimiter);

// GET /api/community/milestones — catálogo com o que o titular já conquistou.
router.get('/milestones', async (req: Request, res: Response) => {
  try {
    const milestones = await listMilestonesForUser(req.user!.id);
    return res.json({ success: true, data: { milestones } });
  } catch (err) {
    logger.error({ err }, '[community] GET /milestones error');
    return res.status(500).json({ success: false, error: 'Failed to load milestones' });
  }
});

/**
 * PATCH /api/community/milestones/:code — intenção de compartilhar.
 *
 * 404 quando o código não existe OU quando o titular ainda não conquistou o
 * marco: as duas respostas são idênticas de propósito. Distinguir "não existe"
 * de "você não tem" transformaria a rota num oráculo do catálogo interno.
 */
router.patch('/milestones/:code', async (req: Request, res: Response) => {
  const shared = req.body?.shared;
  if (typeof shared !== 'boolean') {
    return res.status(422).json({ success: false, error: 'shared must be a boolean' });
  }

  try {
    const milestone = await setMilestoneShared(req.user!.id, String(req.params.code), shared);
    if (!milestone) {
      return res.status(404).json({ success: false, error: 'Milestone not found' });
    }
    return res.json({ success: true, data: { milestone } });
  } catch (err) {
    logger.error({ err }, '[community] PATCH /milestones/:code error');
    return res.status(500).json({ success: false, error: 'Failed to update milestone' });
  }
});

export default router;
