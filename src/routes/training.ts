import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { getReadinessLensToday } from '../modules/readiness/readiness.service';
import { PersonalPrescriptionSource } from '../modules/training/adaptive/personal.source';
import { adaptWorkoutDay, assertSafeAdaptation } from '../modules/training/adaptive/adaptation.transformer';
import type { AdaptationPolicy } from '../modules/training/adaptive/types';
import { DEFAULT_POLICY } from '../modules/training/adaptive/types';
import pool from '../config/database';
import logger from '../lib/logger';
import { logDataAccessEvent } from '../services/dataAccessAuditService';
import { createSession, listSessions, getSession, getWorkoutStats } from '../services/workoutSessionService';

const router = Router();
router.use(authMiddleware, requireProduct('app'));

const personalSource = new PersonalPrescriptionSource();

router.get('/today', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const planId = req.query.planId ? parseInt(req.query.planId as string, 10) : undefined;
    const dayIndex = req.query.dayIndex ? parseInt(req.query.dayIndex as string, 10) : undefined;

    // Load today's prescribed plan day
    const day = await personalSource.loadTodayDay(userId, planId, dayIndex);
    if (!day) {
      return res.status(404).json({ success: false, error: 'no_active_plan' });
    }

    // Load readiness lens (null = no check-in today)
    const readiness = await getReadinessLensToday(userId);

    // Resolve adaptation policy
    const policy = await personalSource.resolvePolicy(day, userId);

    let adaptedItems = day.items;
    let changes: ReturnType<typeof adaptWorkoutDay>['changes'] = [];
    let recoverySuggestion: ReturnType<typeof adaptWorkoutDay>['recoverySuggestion'] = null;
    let policyVersion = policy.version;
    let adaptationEnabled = policy.masterEnabled && readiness !== null;

    if (readiness && policy.masterEnabled) {
      try {
        const result = adaptWorkoutDay(day.items, readiness.level, policy);
        assertSafeAdaptation(day.items, result.adaptedItems);
        adaptedItems = result.adaptedItems;
        changes = result.changes;
        recoverySuggestion = result.recoverySuggestion;
        policyVersion = result.policyVersion;

        // Persist adaptation log (upsert — idempotent for the day)
        if (day.sourceRef.planId && day.responsibleParty.kind === 'personal') {
          void upsertAdaptationLog({
            studentId: userId,
            personalId: day.responsibleParty.personalId,
            academyId: day.academyId,
            planId: day.sourceRef.planId,
            dayIndex: day.sourceRef.dayIndex,
            readinessLevel: readiness.level,
            readinessFactors: readiness.factors,
            policy,
            originalItems: day.items,
            adaptedItems: result.adaptedItems,
            changes: result.changes,
          }).catch(err => logger.error({ err }, '[adaptive] upsert log error'));

          // Audit event (fire-and-forget)
          if (changes.length > 0) {
            void logDataAccessEvent({
              actorId: userId,
              subjectUserId: userId,
              eventType: 'training.adaptation.applied',
              eventPayload: {
                planId: day.sourceRef.planId,
                dayIndex: day.sourceRef.dayIndex,
                level: readiness.level,
                changesCount: changes.length,
                policyVersion,
              },
            }).catch(() => {});
          }
        }
      } catch (err) {
        // Safety guard tripped — serve original, log error
        logger.error({ err }, '[adaptive] assertSafeAdaptation failed — serving original plan');
        adaptedItems = day.items;
        changes = [];
        recoverySuggestion = null;
        adaptationEnabled = false;
      }
    }

    const originalPlanDay = { index: day.sourceRef.dayIndex, name: day.name, focus: day.focus, items: day.items };
    const adaptedPlanDay = { index: day.sourceRef.dayIndex, name: day.name, focus: day.focus, items: adaptedItems };

    return res.json({
      success: true,
      data: {
        readiness,
        adaptationEnabled,
        originalPlanDay,
        adaptedPlanDay,
        changes,
        recoverySuggestion,
        policyVersion,
      },
    });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /today error');
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// Frontend UX events — allow-list only, actorId = subjectUserId = self
const ALLOWED_FRONTEND_EVENTS = new Set<string>(['training.adaptation.viewed']);

router.post('/events', async (req: Request, res: Response) => {
  const { eventType, payload = {} } = req.body ?? {};
  if (typeof eventType !== 'string' || !ALLOWED_FRONTEND_EVENTS.has(eventType)) {
    return res.status(400).json({ success: false, error: 'unknown_event' });
  }
  void logDataAccessEvent({
    actorId: req.user!.id,
    subjectUserId: req.user!.id,
    eventType: eventType as 'training.adaptation.viewed',
    eventPayload: typeof payload === 'object' && payload !== null ? payload : {},
    ip: req.ip,
  }).catch(() => {});
  return res.json({ success: true });
});

// ── Execução real do treino (Spec 010) ──────────────────────────────────────
const VALID_SOURCES = new Set(['personal', 'suggested', 'academy', 'free']);
const VALID_STATUS = new Set(['started', 'completed', 'partial', 'abandoned']);

// POST /api/training/sessions — registra a sessão executada (caminho rápido:
// só prescribed + status; ou detalhado: sets com carga/reps reais).
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const body = req.body ?? {};

    if (!VALID_SOURCES.has(body.source)) {
      return res.status(400).json({ success: false, error: 'invalid_source' });
    }
    if (!VALID_STATUS.has(body.status)) {
      return res.status(400).json({ success: false, error: 'invalid_status' });
    }

    const result = await createSession(userId, academyId, {
      source: body.source,
      status: body.status,
      title: typeof body.title === 'string' ? body.title.slice(0, 200) : null,
      planId: Number.isFinite(Number(body.planId)) ? Number(body.planId) : null,
      dayIndex: Number.isFinite(Number(body.dayIndex)) ? Number(body.dayIndex) : null,
      sessionRpe: body.sessionRpe ?? null,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null,
      prescribed: Array.isArray(body.prescribed) ? body.prescribed : [],
      sets: Array.isArray(body.sets) ? body.sets : undefined,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    logger.error({ err }, '[training] POST /sessions error');
    return res.status(500).json({ success: false, error: 'Failed to register session' });
  }
});

// GET /api/training/sessions — histórico do aluno
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const rows = await listSessions(req.user!.id, limit);
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /sessions error');
    return res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
});

// GET /api/training/stats — frequência + progressão de carga por exercício
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getWorkoutStats(req.user!.id);
    return res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /stats error');
    return res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// GET /api/training/sessions/:id — detalhe (séries)
router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid_id' });
    const session = await getSession(req.user!.id, id);
    if (!session) return res.status(404).json({ success: false, error: 'not_found' });
    return res.json({ success: true, data: session });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /sessions/:id error');
    return res.status(500).json({ success: false, error: 'Failed to load session' });
  }
});

async function upsertAdaptationLog(params: {
  studentId: number;
  personalId: number;
  academyId: number | null;
  planId: number;
  dayIndex: number;
  readinessLevel: string;
  readinessFactors: unknown[];
  policy: AdaptationPolicy;
  originalItems: unknown[];
  adaptedItems: unknown[];
  changes: unknown[];
}): Promise<void> {
  const policySnapshot = {
    version: params.policy.version,
    masterEnabled: params.policy.masterEnabled,
    allowVolumeReduction: params.policy.allowVolumeReduction,
    allowRestIncrease: params.policy.allowRestIncrease,
    allowIntensityReduction: params.policy.allowIntensityReduction,
    allowActiveRecoverySubstitution: params.policy.allowActiveRecoverySubstitution,
    allowMobilitySuggestion: params.policy.allowMobilitySuggestion,
    maxSetReductionPct: params.policy.maxSetReductionPct,
    maxRestIncreasePct: params.policy.maxRestIncreasePct,
    minIntensityPct: params.policy.minIntensityPct,
  };

  await pool.query(
    `INSERT INTO workout_adaptation_log
       (student_id, personal_id, academy_id, plan_id, day_index, snapshot_date,
        readiness_level, readiness_factors, policy_version, policy_snapshot,
        original_payload, adapted_payload, changes)
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (student_id, plan_id, day_index, snapshot_date)
     DO UPDATE SET
       readiness_level   = EXCLUDED.readiness_level,
       readiness_factors = EXCLUDED.readiness_factors,
       policy_version    = EXCLUDED.policy_version,
       policy_snapshot   = EXCLUDED.policy_snapshot,
       adapted_payload   = EXCLUDED.adapted_payload,
       changes           = EXCLUDED.changes`,
    [
      params.studentId,
      params.personalId,
      params.academyId,
      params.planId,
      params.dayIndex,
      params.readinessLevel,
      JSON.stringify(params.readinessFactors),
      params.policy.version,
      JSON.stringify(policySnapshot),
      JSON.stringify(params.originalItems),
      JSON.stringify(params.adaptedItems),
      JSON.stringify(params.changes),
    ],
  );
}

export default router;
