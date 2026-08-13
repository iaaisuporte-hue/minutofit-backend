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
import {
  getPerformanceOverview,
  getPrRecords,
  getProgression,
  getScoreHistory,
  getTrainingCalendar,
} from './performance.service';
import { PR_KINDS, type PrKind } from './pr.engine';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtro de exercício. Entrada malformada é ignorada, não vira 500. */
function parseExerciseId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

function parseKind(raw: unknown): PrKind | null {
  return typeof raw === 'string' && (PR_KINDS as readonly string[]).includes(raw)
    ? (raw as PrKind)
    : null;
}

function parseIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// GET /api/performance/prs — recordes atuais + linha do tempo de conquistas.
// Premium: sem a feature devolve 200 com `gated: true` e listas vazias, para a
// tela mostrar o convite em vez de tratar erro. O corte é no BACKEND.
router.get('/prs', async (req: Request, res: Response) => {
  try {
    const data = await getPrRecords(req.user!.id, {
      exerciseId: parseExerciseId(req.query.exerciseId),
      kind: parseKind(req.query.kind),
      sinceDays: req.query.sinceDays === undefined
        ? null
        : parseIntInRange(req.query.sinceDays, 90, 1, 730),
      limit: parseIntInRange(req.query.limit, 20, 1, 100),
    });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, '[performance] GET /prs error');
    return res.status(500).json({ success: false, error: 'Failed to load personal records' });
  }
});

// GET /api/performance/progression — série temporal por exercício.
router.get('/progression', async (req: Request, res: Response) => {
  try {
    const data = await getProgression(
      req.user!.id,
      parseIntInRange(req.query.windowDays, 90, 30, 180),
      parseExerciseId(req.query.exerciseId),
    );
    return res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, '[performance] GET /progression error');
    return res.status(500).json({ success: false, error: 'Failed to load progression' });
  }
});

// GET /api/performance/score/history — série do Progress Score.
// Só pontos reais: dia sem snapshot não vira zero nem ponto interpolado.
router.get('/score/history', async (req: Request, res: Response) => {
  try {
    const data = await getScoreHistory(req.user!.id, parseIntInRange(req.query.days, 90, 7, 365));
    return res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, '[performance] GET /score/history error');
    return res.status(500).json({ success: false, error: 'Failed to load score history' });
  }
});

export default router;
