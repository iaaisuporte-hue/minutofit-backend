/**
 * Rotas do módulo Financeiro do personal (`/api/personal/finance/*`).
 *
 * Router próprio, montado no MESMO prefixo de `personal.ts`, que já passa de 2
 * mil linhas. Os middlewares são os mesmos do router de lá, aplicados no nível
 * deste router — seguro porque o prefixo é específico (`/api/personal`), ao
 * contrário do caso de `app.use('/api', …)` que a suíte `api-mount-gate`
 * documenta.
 *
 * `personal_id` e `actor_id` saem SEMPRE de `req.user!.id`. Nada de path, query
 * ou corpo entra nessas posições.
 */
import { Router, type Request, type Response } from 'express';

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { registerNumericParams } from '../middleware/numericParam';
import { requireProduct } from '../middleware/productGate';
import {
  cancelCharge,
  createOrReplacePlan,
  endPlan,
  getEditablePlanId,
  getHistory,
  getOverview,
  getStudentFinance,
  listStudentsFinance,
  payCharge,
  revertPayment,
  updatePlan,
  waiveCharge,
  type PaymentMethod,
  type PlanInput,
  type StudentsFinanceFilter,
  type UpdatePlanInput,
} from '../services/personalFinanceService';
import { parseId, parseLimit } from '../utils/parseId';

const router = Router();

router.use(authMiddleware, requireProduct('personal'), roleCheckMiddleware('personal'));
registerNumericParams(router, ['studentId', 'chargeId', 'planId']);

/** Erros do serviço carregam `status`; o resto é 500 sem detalhe vazado. */
function sendError(res: Response, error: unknown, fallback: string): void {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
  const message = status === 500 ? fallback : (error as Error).message;
  res.status(status).json({ success: false, error: message });
}

/**
 * Corpo do acordo, sem coagir tipo: string em `priceCents` é erro do cliente.
 *
 * Nada aqui "conserta" valor fora do tipo — quem valida é
 * `normalizePlanInput`, e é ele que devolve 400 com o campo nomeado. Coagir na
 * borda (o que este ponto fazia com `autoRenew`) transformava payload errado em
 * gravação silenciosa do valor padrão.
 */
function readPlanBody(body: any): PlanInput {
  return {
    priceCents: body?.priceCents,
    period: body?.period,
    dueDay: body?.dueDay ?? null,
    packageSessions: body?.packageSessions ?? null,
    autoRenew: body?.autoRenew ?? undefined,
    paymentMethod: (body?.paymentMethod ?? null) as PaymentMethod | null,
    startsOn: body?.startsOn ?? null,
    endsOn: body?.endsOn ?? null,
    notes: body?.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Visão geral e listas
// ---------------------------------------------------------------------------

router.get('/finance/overview', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getOverview(req.user!.id) });
  } catch (error) {
    sendError(res, error, 'Falha ao carregar o financeiro.');
  }
});

const LIST_STATUSES = ['all', 'overdue', 'upcoming', 'paid', 'no_plan'] as const;

router.get('/finance/students', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (!(LIST_STATUSES as readonly string[]).includes(raw)) {
      return res.status(400).json({ success: false, error: 'invalid_status_filter' });
    }
    const filter: StudentsFinanceFilter = {
      status: raw as StudentsFinanceFilter['status'],
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined,
    };
    res.json({ success: true, data: await listStudentsFinance(req.user!.id, filter) });
  } catch (error) {
    sendError(res, error, 'Falha ao listar o financeiro dos alunos.');
  }
});

router.get('/finance/history', async (req: Request, res: Response) => {
  try {
    const months = parseLimit(req.query.months, 6, 24);
    res.json({ success: true, data: await getHistory(req.user!.id, months) });
  } catch (error) {
    sendError(res, error, 'Falha ao carregar o histórico financeiro.');
  }
});

router.get('/finance/students/:studentId', async (req: Request, res: Response) => {
  try {
    const studentId = parseId(req.params.studentId)!;
    res.json({ success: true, data: await getStudentFinance(req.user!.id, studentId) });
  } catch (error) {
    sendError(res, error, 'Falha ao carregar o financeiro do aluno.');
  }
});

// ---------------------------------------------------------------------------
// Acordo
// ---------------------------------------------------------------------------

router.post('/finance/students/:studentId/plan', async (req: Request, res: Response) => {
  try {
    const studentId = parseId(req.params.studentId)!;
    const plan = await createOrReplacePlan(req.user!.id, studentId, req.user!.id, readPlanBody(req.body));
    res.status(201).json({ success: true, data: plan });
  } catch (error) {
    sendError(res, error, 'Falha ao registrar o acordo financeiro.');
  }
});

// O `planId` não vem do cliente de propósito: "o acordo daquele aluno" é sempre
// um só, e resolvê-lo no servidor (`getEditablePlanId`, já filtrado por
// `personal_id`) elimina a classe inteira de tentativa de editar acordo alheio
// por id.
router.patch('/finance/students/:studentId/plan', async (req: Request, res: Response) => {
  try {
    const studentId = parseId(req.params.studentId)!;
    const personalId = req.user!.id;
    const planId = await getEditablePlanId(personalId, studentId);

    const body = req.body ?? {};
    const patch: UpdatePlanInput = {};
    if (body.priceCents !== undefined) patch.priceCents = body.priceCents;
    if (body.period !== undefined) patch.period = body.period;
    if (body.dueDay !== undefined) patch.dueDay = body.dueDay;
    if (body.packageSessions !== undefined) patch.packageSessions = body.packageSessions;
    if (body.autoRenew !== undefined) patch.autoRenew = body.autoRenew;
    if (body.paymentMethod !== undefined) patch.paymentMethod = body.paymentMethod;
    if (body.startsOn !== undefined) patch.startsOn = body.startsOn;
    if (body.endsOn !== undefined) patch.endsOn = body.endsOn;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.status !== undefined) patch.status = body.status;

    const plan = await updatePlan(personalId, planId, personalId, patch);
    res.json({ success: true, data: plan });
  } catch (error) {
    sendError(res, error, 'Falha ao atualizar o acordo financeiro.');
  }
});

router.post('/finance/students/:studentId/plan/end', async (req: Request, res: Response) => {
  try {
    const studentId = parseId(req.params.studentId)!;
    const personalId = req.user!.id;
    const planId = await getEditablePlanId(personalId, studentId);
    res.json({ success: true, data: await endPlan(personalId, planId, personalId) });
  } catch (error) {
    sendError(res, error, 'Falha ao encerrar o acordo financeiro.');
  }
});

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------

router.post('/finance/charges/:chargeId/pay', async (req: Request, res: Response) => {
  try {
    const chargeId = parseId(req.params.chargeId)!;
    const body = req.body ?? {};
    const charge = await payCharge(req.user!.id, chargeId, req.user!.id, {
      paidCents: body.paidCents ?? null,
      paidAt: body.paidAt ?? null,
      paidMethod: (body.paidMethod ?? null) as PaymentMethod | null,
      notes: body.notes ?? null,
    });
    res.json({ success: true, data: charge });
  } catch (error) {
    sendError(res, error, 'Falha ao registrar o pagamento.');
  }
});

router.post('/finance/charges/:chargeId/revert', async (req: Request, res: Response) => {
  try {
    const chargeId = parseId(req.params.chargeId)!;
    res.json({ success: true, data: await revertPayment(req.user!.id, chargeId, req.user!.id) });
  } catch (error) {
    sendError(res, error, 'Falha ao estornar o pagamento.');
  }
});

router.post('/finance/charges/:chargeId/waive', async (req: Request, res: Response) => {
  try {
    const chargeId = parseId(req.params.chargeId)!;
    const notes = req.body?.notes ?? null;
    res.json({ success: true, data: await waiveCharge(req.user!.id, chargeId, req.user!.id, notes) });
  } catch (error) {
    sendError(res, error, 'Falha ao isentar a cobrança.');
  }
});

router.post('/finance/charges/:chargeId/cancel', async (req: Request, res: Response) => {
  try {
    const chargeId = parseId(req.params.chargeId)!;
    res.json({ success: true, data: await cancelCharge(req.user!.id, chargeId, req.user!.id) });
  } catch (error) {
    sendError(res, error, 'Falha ao cancelar a cobrança.');
  }
});

export default router;
