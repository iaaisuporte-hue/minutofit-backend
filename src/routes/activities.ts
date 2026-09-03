import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requirePhysicalActivityClearance } from '../middleware/requirePhysicalActivityClearance';
import { withTenant, TENANT_PLACEHOLDER } from '../db/tenantQuery';
import logger from '../lib/logger';
import {
  createActivity,
  deleteActivity,
  VALID_ACTIVITY_SOURCES,
  type ActivitySource,
  type ActivityType,
} from '../services/activityService';

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

    // Procedência (SPEC P2 §6). Ausente = o próprio S2Core gravou.
    const source = req.body.source == null ? 's2core' : String(req.body.source);
    if (!VALID_ACTIVITY_SOURCES.has(source)) {
      return res.status(400).json({ success: false, error: 'invalid_source' });
    }

    // `clientKey` dá idempotência ao reenvio (§38). Limitada em tamanho para
    // não virar vetor de lixo no índice único.
    const clientKey =
      typeof req.body.clientKey === 'string' && req.body.clientKey.trim().length > 0
        ? req.body.clientKey.trim().slice(0, 128)
        : null;
    const sourceExternalId =
      typeof req.body.sourceExternalId === 'string' && req.body.sourceExternalId.trim().length > 0
        ? req.body.sourceExternalId.trim().slice(0, 256)
        : null;

    // FC e calorias só entram quando a FONTE forneceu. Fora da faixa fisiológica
    // vira null em vez de 400: um sensor ruim não deve custar a atividade toda.
    const bpm = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 25 && n <= 250 ? Math.round(n) : null;
    };

    const result = await createActivity({
      userId,
      academyId,
      activityType: String(activityType) as ActivityType,
      durationSeconds: Number(durationSeconds) || 0,
      distanceKm: Number(distanceKm) || 0,
      caloriesEstimated: Number(caloriesEstimated) || 0,
      avgPace: Number(avgPace) || 0,
      intensity: intensity ?? null,
      score: score != null ? Number(score) : null,
      routeCoordinates: routeCoordinates ?? null,
      validationFlag: Boolean(validationFlag),
      startedAt: start,
      endedAt: end,
      source: source as ActivitySource,
      sourceExternalId,
      sourceApp:
        typeof req.body.sourceApp === 'string' ? req.body.sourceApp.trim().slice(0, 120) || null : null,
      clientKey,
      avgHeartRate: bpm(req.body.avgHeartRate),
      maxHeartRate: bpm(req.body.maxHeartRate),
      calories: Number.isFinite(Number(req.body.calories)) && Number(req.body.calories) > 0
        ? Math.round(Number(req.body.calories))
        : null,
      elevationGainM: Number.isFinite(Number(req.body.elevationGainM))
        ? Number(req.body.elevationGainM)
        : null,
    });

    // 200 no replay, 201 na criação: o cliente distingue "já estava lá" de
    // "acabei de gravar" sem precisar comparar ids.
    return res.status(result.deduplicated ? 200 : 201).json({
      success: true,
      data: {
        id: result.id,
        createdAt: result.createdAt,
        deduplicated: result.deduplicated,
        ...(result.possibleDuplicateOf ? { possibleDuplicateOf: result.possibleDuplicateOf } : {}),
      },
    });
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
                  avg_pace, intensity, score, validation_flag, started_at, ended_at, created_at,
                  source, source_app, avg_heart_rate, max_heart_rate, calories, calories_source,
                  possible_duplicate_of,
                  (route_coordinates IS NOT NULL) AS route_available
           FROM activity_sessions
           WHERE user_id = $1 AND academy_id = $2
           ORDER BY created_at DESC
           LIMIT 50`,
          [userId, TENANT_PLACEHOLDER]
        )
      : await pool.query(
          `SELECT id, activity_type, duration_seconds, distance_km, calories_estimated,
                  avg_pace, intensity, score, validation_flag, started_at, ended_at, created_at,
                  source, source_app, avg_heart_rate, max_heart_rate, calories, calories_source,
                  possible_duplicate_of,
                  (route_coordinates IS NOT NULL) AS route_available
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

/**
 * DELETE /api/activities/:id — exclusão pelo titular (SPEC P2 §67).
 *
 * Remove APENAS do S2Core. A decisão e a assimetria que a sustenta estão em
 * `activityService.deleteActivity`. A rota é escopada por `user_id`, então um
 * id de outra pessoa devolve 404, nunca apaga.
 *
 * A rota some com a atividade E com a rota GPS associada (`route_coordinates` é
 * coluna da mesma linha), que é o que a §32 exige: excluir a atividade exclui
 * o percurso.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'invalid_id' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_id' });
    }
    const apagou = await deleteActivity(req.user!.id, id);
    if (!apagou) return res.status(404).json({ success: false, error: 'not_found' });
    return res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, 'DELETE /api/activities/:id error');
    return res.status(500).json({ success: false, error: 'Não foi possível excluir a atividade.' });
  }
});

export default router;
