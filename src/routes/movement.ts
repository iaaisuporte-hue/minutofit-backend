import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireFeature } from '../middleware/featureGate';
import { requirePhysicalActivityClearance } from '../middleware/requirePhysicalActivityClearance';
import logger from '../lib/logger';

const router = Router();
// requireAcademyContext removido: standalone user pode usar Movement Lab.
// GET filtra por user_id sem tenant; POST stamp academy_id=NULL.
//
// `requireFeature('movement_lab')` no roteador inteiro: enquanto o Lab esteve
// liberado no Free a ausência de gate não tinha efeito prático, mas o recurso
// virou pago em ago/2026 e a API continuava aberta — o SPA escondia a entrada e
// o endpoint aceitava. Mesma classe do buraco inverso do Tracker (feature off,
// rota aberta), só que agora custando assinatura. Vem depois de `requireProduct`
// para que o erro de produto apareça antes do de plano.
router.use(authMiddleware, requireProduct('app'), requireFeature('movement_lab'));

/**
 * Os 5 exercícios que o Lab sabe analisar — espelha `ExerciseId` em
 * `pages/user/lib/exerciseRules.ts` no SPA. Ampliar o Lab exige atualizar os dois.
 */
const LAB_EXERCISE_IDS = new Set(['biceps_curl', 'squat', 'push_up', 'lunge', 'lateral_raise']);

// POST /api/movement/sessions — save a completed movement lab session
router.post('/sessions', requirePhysicalActivityClearance(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const {
      exerciseId,
      exerciseLabel,
      repCount,
      avgFormScore,
      bestRepScore,
      worstRepScore,
      avgSymmetry,
      insight,
    } = req.body;

    if (!exerciseId) {
      return res.status(400).json({ success: false, error: 'exerciseId é obrigatório.' });
    }

    // O Lab analisa 5 exercícios. `exerciseId` era texto livre e os scores não
    // tinham faixa, então um payload errado gravava uma sessão de zeros com
    // rótulo arbitrário — histórico poluído sem ninguém perceber.
    if (!LAB_EXERCISE_IDS.has(String(exerciseId))) {
      return res.status(400).json({ success: false, error: 'invalid_exercise_id' });
    }
    const scores = { repCount, avgFormScore, bestRepScore, worstRepScore, avgSymmetry };
    for (const [field, value] of Object.entries(scores)) {
      if (value == null) continue;
      const n = Number(value);
      const max = field === 'repCount' ? 1000 : 100;
      if (!Number.isFinite(n) || n < 0 || n > max) {
        return res.status(400).json({ success: false, error: `invalid_${field}` });
      }
    }

    const result = await pool.query(
      `INSERT INTO movement_sessions
         (user_id, academy_id, exercise_id, exercise_label, rep_count, avg_form_score,
          best_rep_score, worst_rep_score, avg_symmetry, insight)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [
        userId,
        academyId,
        String(exerciseId),
        String(exerciseLabel ?? exerciseId),
        Number(repCount) || 0,
        Number(avgFormScore) || 0,
        Number(bestRepScore) || 0,
        Number(worstRepScore) || 0,
        Number(avgSymmetry) || 0,
        insight ?? null,
      ]
    );

    return res.status(201).json({ success: true, data: { id: result.rows[0].id, createdAt: result.rows[0].created_at } });
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/movement/sessions error');
    return res.status(500).json({ success: false, error: 'Não foi possível salvar a sessão.' });
  }
});

// GET /api/movement/sessions — list authenticated user's movement sessions (last 30)
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

    const result = academyId
      ? await pool.query(
          `SELECT id, exercise_id, exercise_label, rep_count, avg_form_score,
                  best_rep_score, worst_rep_score, avg_symmetry, insight, created_at
           FROM movement_sessions
           WHERE user_id = $1 AND academy_id = $2
           ORDER BY created_at DESC
           LIMIT 30`,
          [userId, academyId]
        )
      : await pool.query(
          `SELECT id, exercise_id, exercise_label, rep_count, avg_form_score,
                  best_rep_score, worst_rep_score, avg_symmetry, insight, created_at
           FROM movement_sessions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 30`,
          [userId]
        );
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    logger.error({ err: error }, 'GET /api/movement/sessions error');
    return res.status(500).json({ success: false, error: 'Não foi possível carregar as sessões.' });
  }
});

export default router;
