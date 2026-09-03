/**
 * Rotas de Aderência, Recorrência e Insights do Personal (Sprint P2B),
 * `/api/personal/students/:studentId/{adherence,exercise-insights}*`.
 *
 * Router próprio, montado no MESMO prefixo de `personal.ts` — mesmo motivo já
 * documentado em `personalFinance.ts`/`personalExercises.ts` (`personal.ts` já
 * passa de 2 mil linhas). `personal_id` sai SEMPRE de `req.user!.id`.
 *
 * Leitura de dados de execução exige consent `workouts` do aluno (mesmo
 * escopo de `/students/:studentId/training-summary` em `personal.ts` — é a
 * mesma classe de dado, granularidade diferente) + vínculo ATIVO
 * personal↔aluno, checado dentro de cada serviço chamado aqui (mesmo padrão
 * de `getStudentExecutionSummary`).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireActiveConsent } from '../middleware/requireActiveConsent';
import { registerNumericParams } from '../middleware/numericParam';
import { parseLimit } from '../utils/parseId';
import { getAdherenceSummaryForPersonal } from '../services/executionClassificationService';
import { getExerciseInsightDetail, listExerciseInsightsForPersonal } from '../services/exerciseInsightService';
import { applyAssistedPlanReview } from '../services/assistedPlanReviewService';

const router = Router();

router.use(authMiddleware, requireProduct('personal'));
registerNumericParams(router, ['studentId']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('exerciseId', (_req: Request, res: Response, next: NextFunction, value: string) => {
  if (!UUID_RE.test(value)) return res.status(400).json({ success: false, error: 'invalid_exerciseId' });
  return next();
});

/** Erros de leitura: `code: 'ASSIGNMENT_REQUIRED'` (vínculo inativo/inexistente) é o único caso especial. */
function sendReadError(res: Response, error: unknown, fallback: string): void {
  const err = error as { code?: string; message?: string };
  if (err.code === 'ASSIGNMENT_REQUIRED') {
    return void res.status(403).json({ success: false, error: err.message });
  }
  res.status(500).json({ success: false, error: err.message || fallback });
}

// ---------------------------------------------------------------------------
// Aderência por exercício (ADHERENCE_DEFINITION — "Como a ficha foi seguida")
// ---------------------------------------------------------------------------

router.get(
  '/students/:studentId/adherence',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const windowDays = parseLimit(req.query.window, 30, 180);
      const data = await getAdherenceSummaryForPersonal(req.user!.id, studentId, windowDays);
      res.json({ success: true, data });
    } catch (error) {
      sendReadError(res, error, 'Falha ao calcular a aderência à ficha.');
    }
  },
);

// ---------------------------------------------------------------------------
// Insights (recorrência de substituição + padrão de desconforto)
// ---------------------------------------------------------------------------

router.get(
  '/students/:studentId/exercise-insights',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const data = await listExerciseInsightsForPersonal(req.user!.id, studentId);
      res.json({ success: true, data });
    } catch (error) {
      sendReadError(res, error, 'Falha ao carregar os insights de execução.');
    }
  },
);

router.get(
  '/students/:studentId/exercise-insights/:exerciseId',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const data = await getExerciseInsightDetail(req.user!.id, studentId, req.params.exerciseId);
      if (!data) {
        return res.status(404).json({ success: false, error: 'Exercício não foi prescrito na janela analisada.' });
      }
      res.json({ success: true, data });
    } catch (error) {
      sendReadError(res, error, 'Falha ao carregar o detalhe do insight.');
    }
  },
);

// ---------------------------------------------------------------------------
// Revisão assistida — decisão explícita do Personal, nunca automática
// ---------------------------------------------------------------------------

router.post(
  '/students/:studentId/exercise-insights/:exerciseId/review',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const action = req.body?.action;

      if (action === 'dismiss') {
        // Sem estado persistido (FUTURE_WORK do harness — "ignorar" como
        // estado permanente ficou fora desta sprint): a rota só confirma a
        // ação para a telemetria do frontend disparar `personal_plan_review_cancelled`.
        return res.json({ success: true, data: { applied: false, dismissed: true } });
      }
      if (action !== 'apply') {
        return res.status(400).json({ success: false, error: 'invalid_action' });
      }

      const targetExerciseId = req.body?.targetExerciseId;
      if (typeof targetExerciseId !== 'string' || !UUID_RE.test(targetExerciseId)) {
        return res.status(400).json({ success: false, error: 'invalid_target_exercise_id' });
      }

      const result = await applyAssistedPlanReview(req.user!.id, studentId, req.params.exerciseId, targetExerciseId);
      res.json({ success: true, data: result });
    } catch (error) {
      const err = error as { status?: number; code?: string; message?: string; details?: string[] };
      if (typeof err.status === 'number') {
        return void res.status(err.status).json({ success: false, error: err.message, code: err.code });
      }
      if (err.code === 'PLAN_NOT_FOUND') {
        return void res.status(404).json({ success: false, error: 'Plan not found or access denied' });
      }
      if (err.code === 'INVALID_EXERCISES') {
        return void res.status(400).json({ success: false, error: err.message, details: err.details });
      }
      res.status(500).json({ success: false, error: err.message || 'Falha ao revisar a ficha.' });
    }
  },
);

export default router;
