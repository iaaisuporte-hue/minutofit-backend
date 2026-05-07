import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// POST /api/movement/sessions — save a completed movement lab session
router.post('/sessions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
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

    const result = await pool.query(
      `INSERT INTO movement_sessions
         (user_id, exercise_id, exercise_label, rep_count, avg_form_score,
          best_rep_score, worst_rep_score, avg_symmetry, insight)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [
        userId,
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
    console.error('POST /api/movement/sessions error:', error);
    return res.status(500).json({ success: false, error: 'Não foi possível salvar a sessão.' });
  }
});

// GET /api/movement/sessions — list authenticated user's movement sessions (last 30)
router.get('/sessions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await pool.query(
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
    console.error('GET /api/movement/sessions error:', error);
    return res.status(500).json({ success: false, error: 'Não foi possível carregar as sessões.' });
  }
});

export default router;
