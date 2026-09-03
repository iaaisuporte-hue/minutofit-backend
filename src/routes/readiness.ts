import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireFeature } from '../middleware/featureGate';
import logger from '../lib/logger';
import {
  obterReadinessDeHoje,
  registrarFeedbackDeEsforco,
} from '../modules/readiness/v1/readiness.service';

/**
 * S2CORE Readiness — API (SPEC Mobile P3 §57).
 *
 * `requireFeature('readiness')` em TODAS as rotas. A flag não está em nenhum
 * plano por padrão: a §74/§75 exige rollout gradual, e um motor de decisão
 * fisiológica é a última coisa a soltar sem observar comportamento antes.
 */
const router = Router();

router.use(authMiddleware, requireProduct('app'), requireFeature('readiness'));

/**
 * GET /api/readiness/today
 *
 * `?groups=chest,triceps` pondera a recuperação muscular pelos grupos do treino
 * de hoje (§29): pernas destruídas são irrelevantes num dia de peito.
 */
router.get('/today', async (req: Request, res: Response) => {
  try {
    const brutos = String(req.query.groups ?? '').trim();
    const groups = brutos
      ? brutos.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 12)
      : undefined;

    const r = await obterReadinessDeHoje(req.user!.id, { plannedMuscleGroups: groups });

    return res.json({
      success: true,
      data: {
        date: r.date,
        score: r.score,
        state: r.state,
        recommendation: r.recommendation,
        confidence: r.confidence,
        data_completeness: r.dataCompleteness,
        mode: r.mode,
        headline: r.headline,
        microcopy: r.microcopy,
        // Fatores em linguagem de produto (§32). O breakdown técnico NÃO sai
        // aqui — ele vive no snapshot, para auditoria (§33).
        reasons: r.factors,
        muscle_recovery: r.muscleRecovery,
        algorithm_version: r.algorithmVersion,
      },
    });
  } catch (err) {
    logger.error({ err }, '[readiness] GET /today');
    return res.status(500).json({ success: false, error: 'Não foi possível calcular sua prontidão agora.' });
  }
});

/**
 * GET /api/readiness/debug — breakdown técnico (§73).
 *
 * Só para admin. Devolve os componentes, os pesos aplicados e a razão de cada
 * ausência: é o que permite validar o motor sem adivinhar. Um usuário comum
 * nunca vê fórmula (§32).
 */
router.get('/debug', async (req: Request, res: Response) => {
  if (req.user!.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  try {
    const alvo = Number(req.query.userId ?? req.user!.id);
    if (!Number.isSafeInteger(alvo) || alvo <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_user_id' });
    }
    const r = await obterReadinessDeHoje(alvo, { forcarRecalculo: true });
    return res.json({ success: true, data: r });
  } catch (err) {
    logger.error({ err }, '[readiness] GET /debug');
    return res.status(500).json({ success: false, error: 'debug_failed' });
  }
});

/**
 * POST /api/readiness/effort-feedback — "como esse treino pareceu?" (§46).
 *
 * Insumo de calibração futura (§45, §47). **Não altera o modelo** — a §47 é
 * explícita sobre registrar a divergência sem ajuste automático nesta fase.
 */
router.post('/effort-feedback', async (req: Request, res: Response) => {
  const VALIDOS = ['very_light', 'light', 'adequate', 'hard', 'very_hard'];
  const perceived = String(req.body?.perceived ?? '');
  if (!VALIDOS.includes(perceived)) {
    return res.status(400).json({ success: false, error: 'invalid_perceived' });
  }
  const bruto = req.body?.sessionId;
  const sessionId = bruto == null ? null : Number(bruto);
  if (sessionId != null && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
    return res.status(400).json({ success: false, error: 'invalid_session_id' });
  }
  try {
    await registrarFeedbackDeEsforco(req.user!.id, sessionId, perceived as never);
    return res.status(201).json({ success: true });
  } catch (err) {
    logger.error({ err }, '[readiness] POST /effort-feedback');
    return res.status(500).json({ success: false, error: 'feedback_failed' });
  }
});

export default router;
