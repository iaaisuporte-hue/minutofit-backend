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
