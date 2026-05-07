import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// POST /api/activities — save a completed activity session
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      activityType,
      durationSeconds,
      distanceKm,
      caloriesEstimated,
      avgPace,
      intensity,
      score,
      routeCoordinates,
      validationFlag,
      startedAt,
      endedAt,
    } = req.body;

    if (!activityType || !startedAt || !endedAt) {
      return res.status(400).json({ success: false, error: 'activityType, startedAt e endedAt são obrigatórios.' });
    }

    const result = await pool.query(
      `INSERT INTO activity_sessions
         (user_id, activity_type, duration_seconds, distance_km, calories_estimated,
          avg_pace, intensity, score, route_coordinates, validation_flag, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, created_at`,
      [
        userId,
        String(activityType),
        Number(durationSeconds) || 0,
        Number(distanceKm) || 0,
        Number(caloriesEstimated) || 0,
        Number(avgPace) || 0,
        intensity ?? null,
        score != null ? Number(score) : null,
        routeCoordinates ? JSON.stringify(routeCoordinates) : null,
        Boolean(validationFlag),
        new Date(startedAt),
        new Date(endedAt),
      ]
    );

    return res.status(201).json({ success: true, data: { id: result.rows[0].id, createdAt: result.rows[0].created_at } });
  } catch (error: any) {
    console.error('POST /api/activities error:', error);
    return res.status(500).json({ success: false, error: 'Não foi possível salvar a sessão.' });
  }
});

// GET /api/activities — list authenticated user's sessions (last 50)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await pool.query(
      `SELECT id, activity_type, duration_seconds, distance_km, calories_estimated,
              avg_pace, intensity, score, validation_flag, started_at, ended_at, created_at
       FROM activity_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('GET /api/activities error:', error);
    return res.status(500).json({ success: false, error: 'Não foi possível carregar as sessões.' });
  }
});

export default router;
