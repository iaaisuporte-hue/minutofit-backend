/**
 * Rotas do módulo Performance (Spec 033, Onda P1).
 *
 * Escopo desta onda: overview (consistência) e calendário. Progressão, recordes,
 * metas e insight do personal são P2–P5 e não têm rota aqui ainda.
 *
 * Isolamento: todo dado é do titular. O `userId` sai SEMPRE do JWT
 * (`req.user!.id`) e nunca de params ou body — não há superfície de IDOR porque
 * não há identificador de outro usuário a informar.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { requireProduct } from '../../middleware/productGate';
import logger from '../../lib/logger';
import { dayKey } from '../../utils/appDay';
import { getPerformanceOverview, getTrainingCalendar } from './performance.service';

const router = Router();
router.use(authMiddleware, requireProduct('app'));

// GET /api/performance/overview — consistência + resumo. Free nesta onda.
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const data = await getPerformanceOverview(req.user!.id);
    return res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, '[performance] GET /overview error');
    return res.status(500).json({ success: false, error: 'Failed to load performance overview' });
  }
});

/**
 * Mês pedido, aceitando só 'YYYY-MM'.
 *
 * Entrada malformada vira o mês corrente em vez de 500: um `?month=` estragado
 * já derrubou outra rota deste produto (QA 02/ago/2026, P2-7), e calendário é
 * leitura — degradar para "mês atual" serve melhor que erro.
 */
function parseMonth(raw: unknown): { year: number; month: number } {
  // O mês padrão é o do ALUNO. Com `getUTCMonth()`, um pedido malformado em 31
  // de dezembro às 21h30 (BRT) devolveria janeiro.
  const [fy, fm] = dayKey().split('-').map(Number);
  const fallback = { year: fy, month: fm };
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}$/.test(raw)) return fallback;
  const [y, m] = raw.split('-').map(Number);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return fallback;
  if (!Number.isInteger(m) || m < 1 || m > 12) return fallback;
  return { year: y, month: m };
}

// GET /api/performance/calendar?month=YYYY-MM — dias ativos do mês.
router.get('/calendar', async (req: Request, res: Response) => {
  try {
    const { year, month } = parseMonth(req.query.month);
    const data = await getTrainingCalendar(req.user!.id, year, month);
    return res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, '[performance] GET /calendar error');
    return res.status(500).json({ success: false, error: 'Failed to load training calendar' });
  }
});

export default router;
