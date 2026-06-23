import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requirePhysicalActivityClearance } from '../middleware/requirePhysicalActivityClearance';
import { withTenant, TENANT_PLACEHOLDER } from '../db/tenantQuery';
import logger from '../lib/logger';

const router = Router();
// requireAcademyContext removido do router-level: usuários standalone (sem academia)
// usam o app legitimamente. Handlers de leitura caem em fluxo sem tenant; handlers
// de criação stamp academy_id=NULL.
router.use(authMiddleware, requireProduct('app'));

// POST /api/activities — save a completed activity session
router.post('/', requirePhysicalActivityClearance(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    // Tenant isolation: stamp academy_id from JWT if available (always present after Phase 2 backfill)
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
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
         (user_id, academy_id, activity_type, duration_seconds, distance_km, calories_estimated,
          avg_pace, intensity, score, route_coordinates, validation_flag, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, created_at`,
      [
        userId,
        academyId,
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
    logger.error({ err: error }, 'POST /api/activities error');
    return res.status(500).json({ success: false, error: 'Não foi possível salvar a sessão.' });
  }
});

// GET /api/activities — list authenticated user's sessions (last 50)
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

    // When academy context is available, use withTenant() for dev-time guard.
    // Falls back to user_id-only for CoreFit sessions without tenant context.
    const result = academyId
      ? await withTenant(
          pool,
          academyId,
          `SELECT id, activity_type, duration_seconds, distance_km, calories_estimated,
                  avg_pace, intensity, score, validation_flag, started_at, ended_at, created_at
           FROM activity_sessions
           WHERE user_id = $1 AND academy_id = $2
           ORDER BY created_at DESC
           LIMIT 50`,
          [userId, TENANT_PLACEHOLDER]
        )
      : await pool.query(
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
    logger.error({ err: error }, 'GET /api/activities error');
    return res.status(500).json({ success: false, error: 'Não foi possível carregar as sessões.' });
  }
});

export default router;
