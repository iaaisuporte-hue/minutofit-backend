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

/**
 * Limites de sanidade do servidor. Não substituem a heurística fina do cliente
 * (`SPEED_THRESHOLDS` por modalidade, detecção de veículo) — são o piso que
 * impede dado fisicamente impossível de entrar no score metabólico vindo de um
 * cliente que não é o nosso app.
 */
const VALID_ACTIVITY_TYPES = new Set(['walk', 'run', 'cycling', 'cardio']);
const MAX_DURATION_SECONDS = 24 * 3600; // uma sessão não passa de 24h
const MAX_DISTANCE_KM = 1000;
const MAX_SPEED_KMH = 60; // acima disso não é caminhada, corrida nem bicicleta
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // folga p/ relógio dessincronizado

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

    // Validação server-side (QA ago/2026): a heurística de velocidade existia só
    // no cliente, então a API aceitava 200 km em 30 min, `endedAt` antes de
    // `startedAt` e duração negativa — tudo isso alimenta o score metabólico.
    if (!VALID_ACTIVITY_TYPES.has(String(activityType))) {
      return res.status(400).json({ success: false, error: 'invalid_activity_type' });
    }

    const start = new Date(startedAt);
    const end = new Date(endedAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ success: false, error: 'invalid_dates' });
    }
    if (end.getTime() < start.getTime()) {
      return res.status(400).json({ success: false, error: 'ended_before_started' });
    }
    if (start.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      return res.status(400).json({ success: false, error: 'started_at_in_future' });
    }

    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_SECONDS) {
      return res.status(400).json({ success: false, error: 'invalid_duration' });
    }
    const distance = Number(distanceKm);
    if (!Number.isFinite(distance) || distance < 0 || distance > MAX_DISTANCE_KM) {
      return res.status(400).json({ success: false, error: 'invalid_distance' });
    }

    // Velocidade média impossível: acima de 60 km/h nenhuma das modalidades
    // suportadas é plausível (o recorde de ciclismo em pista fica bem abaixo).
    // Só checamos quando há duração — sem ela a razão é indefinida.
    if (duration > 0 && distance > 0) {
      const kmh = distance / (duration / 3600);
      if (kmh > MAX_SPEED_KMH) {
        return res.status(400).json({ success: false, error: 'implausible_speed' });
      }
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
