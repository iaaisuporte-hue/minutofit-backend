/**
 * Rotas do módulo Performance (Spec 033, Onda P1).
 *
 * Escopo até aqui: overview, calendário, progressão, recordes, score e metas.
 * O insight do personal é P5 e não tem rota aqui ainda.
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
import { GOAL_KINDS, type GoalKind } from './goals.engine';
import {
  READINESS_STATE_BY_LEVEL,
  READINESS_VERSION,
} from '../readiness/readiness.engine';
import { getReadinessLensToday } from '../readiness/readiness.service';
import {
  GoalError,
  abandonGoalForUser,
  createGoal,
  getGoalDetail,
  getGoalsForUser,
} from './goals.service';

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

/**
 * Erro de meta → resposta HTTP.
 *
 * Cada `GoalError` carrega o próprio status e um código estável; o cliente
 * decide o que dizer a partir do código, não da frase. Qualquer outra exceção
 * vira 500 sem detalhe — mensagem crua de Postgres na tela do aluno já foi
 * achado de QA neste repo.
 */
function sendGoalError(res: Response, err: unknown, where: string) {
  if (err instanceof GoalError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  logger.error({ err }, `[performance] ${where} error`);
  return res.status(500).json({ success: false, error: 'Failed to process goal' });
}

/** O id vem da URL como texto e só é aceito se for inteiro positivo. */
function parseGoalId(raw: unknown): string | null {
  return typeof raw === 'string' && /^[1-9]\d{0,18}$/.test(raw) ? raw : null;
}

// GET /api/performance/goals — metas do aluno. Premium; Free recebe `gated`.
router.get('/goals', async (req: Request, res: Response) => {
  try {
    const data = await getGoalsForUser(req.user!.id);
    return res.json({ success: true, data });
  } catch (err) {
    return sendGoalError(res, err, 'GET /goals');
  }
});

// GET /api/performance/goals/:id — detalhe. 404 quando não é do requisitante.
router.get('/goals/:id', async (req: Request, res: Response) => {
  const id = parseGoalId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Meta não encontrada.' });
  try {
    const data = await getGoalDetail(req.user!.id, id);
    return res.json({ success: true, data });
  } catch (err) {
    return sendGoalError(res, err, 'GET /goals/:id');
  }
});

/**
 * POST /api/performance/goals
 *
 * Body: `{ kind, exerciseId?, targetValue, targetReps?, dueOn? }`. Nada mais é
 * lido — em especial, o cliente NÃO envia baseline, unidade nem status: os três
 * são derivados no servidor, e aceitá-los do cliente permitiria uma meta que
 * nasce a 90% de progresso.
 */
router.post('/goals', async (req: Request, res: Response) => {
  const kind = req.body?.kind;
  if (typeof kind !== 'string' || !GOAL_KINDS.includes(kind as GoalKind)) {
    return res.status(400).json({ success: false, error: 'Tipo de meta inválido.', code: 'INVALID_KIND' });
  }
  try {
    const data = await createGoal(req.user!.id, {
      kind: kind as GoalKind,
      exerciseId: typeof req.body?.exerciseId === 'string' ? req.body.exerciseId : null,
      targetValue: Number(req.body?.targetValue),
      targetReps: req.body?.targetReps == null ? null : Number(req.body.targetReps),
      dueOn: typeof req.body?.dueOn === 'string' && req.body.dueOn ? req.body.dueOn : null,
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return sendGoalError(res, err, 'POST /goals');
  }
});

/**
 * PATCH /api/performance/goals/:id — só `active → abandoned`.
 *
 * Abandonar preserva a linha (`status = 'abandoned'`), não apaga: a meta que o
 * aluno desistiu faz parte da história dele, e some da lista ativa sem sumir do
 * histórico. Não existe rota de exclusão física, de propósito.
 */
router.patch('/goals/:id', async (req: Request, res: Response) => {
  const id = parseGoalId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Meta não encontrada.' });
  if (req.body?.status !== 'abandoned') {
    return res
      .status(400)
      .json({ success: false, error: 'Só é possível abandonar uma meta.', code: 'INVALID_TRANSITION' });
  }
  try {
    const data = await abandonGoalForUser(req.user!.id, id);
    return res.json({ success: true, data });
  } catch (err) {
    return sendGoalError(res, err, 'PATCH /goals/:id');
  }
});

/**
 * GET /api/performance/readiness — como o aluno está para treinar HOJE.
 *
 * Prontidão não é o Progress Score, e a resposta deixa isso explícito no
 * formato: aqui não existe número. O Progress Score responde "estou
 * evoluindo?"; este endpoint responde "posso puxar forte hoje?" — e a segunda
 * pergunta é qualitativa por decisão de produto registrada na spec, que barra
 * um readiness 0-100 geral. Um número aqui daria ao aluno a impressão de
 * medição fisiológica que este produto não faz.
 *
 * NÃO é gated: o Lens vale para todo aluno. Interpretar evolução é o que o
 * Premium vende; saber se hoje dá para treinar não se cobra de ninguém.
 *
 * Sem check-in do dia a resposta é `insufficient_data` — e não um estado
 * "verde" por omissão. Afirmar que alguém está pronto sem ter perguntado nada
 * é a forma mais barata de perder a confiança de quem não estava.
 */
router.get('/readiness', async (req: Request, res: Response) => {
  try {
    const lens = await getReadinessLensToday(req.user!.id);
    const generatedAt = new Date().toISOString();

    if (!lens) {
      return res.json({
        success: true,
        data: {
          state: 'insufficient_data',
          level: null,
          factors: [],
          headline: 'Ainda estamos construindo seu dia',
          microcopy: 'Faça o check-in de hoje para o S2Core ler sua prontidão.',
          confidence: 'low',
          version: READINESS_VERSION,
          generatedAt,
        },
      });
    }

    // Cobertura de dados, não probabilidade: diz o quanto do quadro está
    // preenchido, e nunca "chance de X%". `info` são fatores informativos
    // (nutrição boa, estado nominal) — presença deles não é sinal de risco.
    const sinais = lens.factors.filter((f) => f.severity !== 'info').length;
    const confidence = sinais >= 3 ? 'high' : sinais >= 1 ? 'medium' : 'low';

    return res.json({
      success: true,
      data: {
        state: READINESS_STATE_BY_LEVEL[lens.level],
        level: lens.level,
        factors: lens.factors,
        headline: lens.headline,
        microcopy: lens.microcopy,
        confidence,
        version: READINESS_VERSION,
        generatedAt,
      },
    });
  } catch (err) {
    logger.error({ err }, '[performance] GET /readiness error');
    return res.status(500).json({ success: false, error: 'Falha ao carregar sua prontidão.' });
  }
});

export default router;
