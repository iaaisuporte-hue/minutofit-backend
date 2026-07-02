import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireActiveConsent } from '../middleware/requireActiveConsent';
import { listActiveConsentScopes } from '../services/consentService';
import { listMetabolicCheckins } from '../services/metabolicCheckinService';
import { getWorkoutStats } from '../services/workoutSessionService';
import logger from '../lib/logger';
import {
  getPersonalConsulting,
  getPersonalDashboard,
  getPersonalStudentSnapshot,
  listPersonalStudentActivities,
} from '../services/personalDashboardService';
import { generateStudentSummary } from '../services/ai/studentSummaryAi';
import {
  createStudentExerciseNote,
  deleteStudentExerciseNote,
  listStudentExerciseNotes,
  updateStudentExerciseNote,
} from '../services/studentExerciseNotesService';
import { logAcademyAction } from '../services/auditService';
import {
  createPersonalWorkoutPlan,
  createPersonalWorkoutPlanWithDays,
  updatePersonalWorkoutPlanWithDays,
  listPersonalWorkoutPlans,
  listWorkoutPlansForStudent,
  reactivateWorkoutPlan,
  assertStudentAssignedToPersonal,
} from '../services/personalWorkoutPlanService';
import { listPhotosForProfessional } from '../services/progressPhotoService';
import { StorageNotConfiguredError } from '../lib/storage';
import {
  approveWorkoutReview,
  archiveWorkoutReview,
  createWorkoutReview,
  listWorkoutReviews,
  requestChangesWorkoutReview,
  updateWorkoutReview,
  type ReviewPriority,
  type ReviewRisk,
} from '../services/workoutReviewsService';
import {
  createWorkoutProtocol,
  deleteProtocolUsage,
  deleteWorkoutProtocol,
  getWorkoutProtocolById,
  listProtocolUsages,
  listWorkoutProtocolsForPersonal,
  setProtocolFavorite,
  suggestProtocolsForStudent,
  updateWorkoutProtocol,
  type ProtocolScope,
} from '../services/workoutProtocolService';
import { generateWorkout } from '../services/ai/workoutAi';
import { getMetabolicHint } from '../services/ai/metabolicHint';
import pool from '../config/database';
import { logDataAccessEvent } from '../services/dataAccessAuditService';
import { getSportProfile } from '../services/sportProfileService';
import { getReadinessToday } from '../services/sportReadinessService';
import { getStudentExecutionSummary } from '../services/workoutSessionService';
import { listCamps } from '../services/campService';
import { getFatigue7d, getLastRecoveryGap } from '../services/postWorkoutService';
import { findOrCreateUserFromContext } from '../services/userIdentityService';
import { grantMembership } from '../services/membershipService';
import {
  checkStudentLimitGate,
  getPersonalPlan,
  createPlatformCheckout,
  type PersonalPlan,
} from '../services/personalPlanService';
import {
  createSession,
  listSessions,
  type SessionStatus,
} from '../services/personalSessionService';
import crypto from 'crypto';
import {
  createRelationshipAction,
  deleteRelationshipAction,
  listRelationshipTimeline,
  resolveRelationshipAction,
  type ActionType,
} from '../services/personalRetentionService';
import {
  createPersonalTemplate,
  deletePersonalTemplate,
  listVisibleTemplates,
  updatePersonalTemplate,
} from '../services/personalMessageTemplateService';
import {
  cancelSubscription,
  computeFinanceSummary,
  createBillingPlan,
  deleteBillingPlan,
  getBillingSettings,
  getStudentSubscription,
  listBillingPlans,
  subscribeStudent,
  updateBillingPlan,
  upsertBillingSettings,
} from '../services/personalBillingService';

const router = Router();

// ── Rota do ALUNO (precede o gate de produto) ──────────────────────────────
// O aluno lê a PRÓPRIA ficha atribuída pelo personal. Não pode exigir o produto
// 'personal' (que é do profissional / bônus do aluno) — senão o aluno novato leva
// 403 e a tela do "treino do dia" rebate para o Hoje. Registrada ANTES do
// router.use(requireProduct('personal')) para ficar isenta do gate; escopo é
// garantido por req.user.id (só a própria ficha) + roleCheckMiddleware.
router.get(
  '/my/workout-plans',
  authMiddleware,
  roleCheckMiddleware('user', 'personal', 'nutri', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const limitRaw = Number(req.query.limit);
      const rows = await listWorkoutPlansForStudent(req.user!.id, Number.isFinite(limitRaw) ? limitRaw : 20);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to list my workout plans' });
    }
  }
);

// requireAcademyContext removed from router level — personal autônomo (academy_id IS NULL)
// is a valid case; individual routes resolve academyId internally with ?? null.
router.use(authMiddleware, requireProduct('personal'));

// Defesa em profundidade: qualquer rota sob /students/:studentId requer
// consentimento ativo de `profile` do aluno. Handlers individuais ainda podem
// (e devem) adicionar escopos mais específicos (activity_logs, workouts, etc.).
// Admin bypassa via early-return no próprio middleware.
router.use(
  '/students/:studentId',
  roleCheckMiddleware('personal'),
  requireActiveConsent('profile'),
);

// Evolução metabólica do aluno (Spec 014) — read-only, consent-gated.
// `body_metrics` cobre composição/vitais; `workoutStats` só com `workouts` ativo
// (consent granular). Sem vínculo/consent, o prefixo já barra com 403.
router.get(
  '/students/:studentId/evolution',
  roleCheckMiddleware('personal'),
  requireActiveConsent('body_metrics'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const checkins = await listMetabolicCheckins(studentId, 100);
      const scopes = await listActiveConsentScopes(studentId, req.user!.id, 'personal');
      const workoutStats = scopes.has('workouts') ? await getWorkoutStats(studentId) : null;
      res.json({
        success: true,
        data: { checkins, workoutStats, scopes: { bodyMetrics: true, workouts: scopes.has('workouts') } },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to load student evolution' });
    }
  }
);

// ── Plano SaaS do Personal ─────────────────────────────────────────────────

router.get('/plan', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const config = await getPersonalPlan(req.user!.id);
    res.json({ success: true, data: config });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal plan' });
  }
});

// Checkout self-serve: personal assina um plano pago (V1: Pro) via Mercado Pago.
router.post('/plan/checkout', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const plan = String(req.body?.plan ?? '') as PersonalPlan;
    if (plan !== 'pro' && plan !== 'starter') {
      return res.status(400).json({ success: false, error: 'Plano inválido para checkout' });
    }
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.corefit.com.br';
    const { initPoint } = await createPlatformCheckout(req.user!.id, plan, {
      payerEmail: req.user!.email,
      frontendUrl: `${frontendUrl}/app/personal?upgrade=ok`,
    });
    return res.json({ success: true, data: { initPoint } });
  } catch (error: any) {
    const code = error?.code;
    if (code === 'PLAN_NOT_BILLABLE') {
      return res.status(400).json({ success: false, error: 'Plano gratuito não requer pagamento' });
    }
    if (code === 'PAYMENTS_UNAVAILABLE') {
      return res.status(503).json({ success: false, error: 'Pagamento indisponível no momento' });
    }
    return res.status(500).json({ success: false, error: error.message || 'Falha ao iniciar checkout' });
  }
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/dashboard', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getPersonalDashboard(req.user!.id, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal dashboard' });
  }
});

router.get('/consulting/students', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getPersonalConsulting(req.user!.id, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal consulting students' });
  }
});

router.get(
  '/students/:studentId/snapshot',
  roleCheckMiddleware('personal'),
  requireActiveConsent('profile'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await getPersonalStudentSnapshot(req.user!.id, studentId, academyId);

      // Consent granular (Spec 012): corta os blocos sensíveis que o aluno NÃO
      // consentiu a ESTE personal. 'profile' (já exigido) cobre o básico; os
      // dados de saúde exigem o escopo específico, e a revogação tem efeito real.
      const scopes = await listActiveConsentScopes(studentId, req.user!.id, 'personal');
      if (!scopes.has('metabolic')) {
        data.metabolismDetail = null;
        if (data.today) data.today.metabolism = null;
        if (data.history) data.history.adherence14d = [];
      }
      if (!scopes.has('daily_checkins') && !scopes.has('sleep')) {
        if (data.today) {
          data.today.wellbeing = null;
          data.today.moodAvailable = false;
          data.today.lastCheckinISO = null;
          data.today.checkedInToday = false;
        }
        if (data.history) data.history.wellbeingHistory14d = [];
      }
      if (!scopes.has('chat_history') && data.week) {
        data.week.latestMessagePreview = null;
      }

      void logDataAccessEvent({
        actorId: req.user!.id,
        subjectUserId: studentId,
        eventType: 'personal.snapshot.read',
        eventPayload: { scopes: Array.from(scopes) },
        ip: req.ip,
      }).catch(() => {});

      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to load student snapshot' });
    }
  }
);

router.get(
  '/students/:studentId/ai-summary',
  roleCheckMiddleware('personal'),
  requireActiveConsent('profile'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const planConfig = await getPersonalPlan(req.user!.id);
      if (!planConfig.aiEnabled) {
        return res.status(403).json({ success: false, code: 'AI_NOT_ENABLED', upgradeRequired: 'pro' });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ success: false, error: 'Módulo de IA não configurado.' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const dashboard = await getPersonalDashboard(req.user!.id, academyId);
      const student = dashboard.students.find((s) => s.id === String(studentId));

      if (!student) {
        return res.status(403).json({ success: false, error: 'Aluno não encontrado na sua carteira.' });
      }

      const assignedWeeks = student.assignedAtISO
        ? Math.floor((Date.now() - new Date(student.assignedAtISO).getTime()) / (1000 * 60 * 60 * 24 * 7))
        : 0;

      // Consent granular (Spec 012): a IA só recebe metabolismo/sono se o aluno
      // consentiu esses escopos a este personal.
      const scopes = await listActiveConsentScopes(studentId, req.user!.id, 'personal');
      const hasMetabolic = scopes.has('metabolic');
      const hasCheckins = scopes.has('daily_checkins') || scopes.has('sleep');

      const data = await generateStudentSummary(req.user!.id, {
        name: student.name,
        streakDays: student.streakDays,
        adherencePct: student.adherencePct,
        workouts7d: student.workouts7d,
        workouts30d: student.workouts30d,
        metabolismScore: hasMetabolic ? student.metabolismScore : null,
        metabolismTrend: hasMetabolic ? student.metabolismTrend : null,
        metabolismDelta7d: hasMetabolic ? student.metabolismDelta7d : null,
        latestSleptWell: hasCheckins ? student.latestSleptWell : null,
        engagementStatus: student.engagementStatus,
        riskScore: student.riskScore,
        engagementScore: student.engagementScore,
        assignedWeeks,
      });

      void logDataAccessEvent({
        actorId: req.user!.id,
        subjectUserId: studentId,
        eventType: 'personal.ai_summary.read',
        eventPayload: { scopes: Array.from(scopes) },
        ip: req.ip,
      }).catch(() => {});

      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.message?.includes('Limite de')) {
        return res.status(429).json({ success: false, error: error.message });
      }
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Falha ao gerar resumo IA.' });
    }
  }
);

// ── Registro de Sessão do Personal ────────────────────────────────────────

router.post(
  '/students/:studentId/sessions',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const { status, tags, note, sessionAt } = req.body;
      const validStatuses: SessionStatus[] = ['present', 'absent', 'partial'];
      if (!validStatuses.includes(status as SessionStatus)) {
        return res.status(400).json({ success: false, error: `status inválido. Use: ${validStatuses.join(', ')}` });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await createSession(req.user!.id, studentId, academyId, {
        status: status as SessionStatus,
        tags: Array.isArray(tags) ? tags : [],
        note: typeof note === 'string' ? note.slice(0, 500) || undefined : undefined,
        sessionAt: typeof sessionAt === 'string' ? sessionAt : undefined,
      });

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Falha ao registrar sessão.' });
    }
  }
);

router.get(
  '/students/:studentId/sessions',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const data = await listSessions(req.user!.id, studentId, limit);
      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Falha ao listar sessões.' });
    }
  }
);

router.get(
  '/students/:studentId/activities',
  roleCheckMiddleware('personal'),
  requireActiveConsent('activity_logs'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const limitRaw = Number(req.query.limit);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await listPersonalStudentActivities(
        req.user!.id,
        studentId,
        academyId,
        Number.isFinite(limitRaw) ? limitRaw : 10
      );
      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to list student activities' });
    }
  }
);

router.post(
  '/students/:studentId/notes',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const body = req.body || {};
      const row = await createStudentExerciseNote(req.user!.id, studentId, academyId, {
        exerciseKey: body.exerciseKey,
        exerciseName: String(body.exerciseName || ''),
        kind: String(body.kind || 'general'),
        note: String(body.note || ''),
        severity: body.severity,
        loadKg: body.loadKg,
        reps: body.reps,
        sets: body.sets,
        recordedAt: body.recordedAt,
      });
      if (academyId != null) {
        logAcademyAction({
          academyId,
          userId: req.user!.id,
          action: 'personal.student_note.created',
          entityType: 'student_exercise_note',
          entityId: row.id,
          meta: { studentId, kind: row.kind, exerciseName: row.exerciseName },
          ipAddress: req.ip,
        });
      }
      res.status(201).json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error?.message === 'Invalid note kind' || error?.message?.includes('required')) {
        return res.status(400).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to create note' });
    }
  }
);

// Fotos de progresso do aluno (Spec 020) — dado corporal sensível.
// Acesso SÓ com consent explícito `body_photos` (nunca em default scope) +
// vínculo ativo confirmado. Negado no backend, não escondido na UI.
router.get(
  '/students/:studentId/progress-photos',
  roleCheckMiddleware('personal'),
  requireActiveConsent('body_photos'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const assigned = await assertStudentAssignedToPersonal(req.user!.id, studentId);
      if (!assigned) {
        return res.status(403).json({ success: false, error: 'student_not_assigned' });
      }
      const photos = await listPhotosForProfessional(studentId, req.user!.id, 'personal');
      return res.json({ success: true, data: { photos } });
    } catch (error: any) {
      if (error instanceof StorageNotConfiguredError) {
        return res.status(503).json({ success: false, error: 'storage_unavailable' });
      }
      if (error?.code === 'CONSENT_REQUIRED') {
        return res.status(403).json({ success: false, error: 'consent_required', scope: 'body_photos' });
      }
      logger.error({ err: error }, '[personal/progress-photos]');
      return res.status(500).json({ success: false, error: 'Failed to list progress photos' });
    }
  },
);

router.get(
  '/students/:studentId/notes',
  roleCheckMiddleware('personal'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const exerciseKey = typeof req.query.exerciseKey === 'string' ? req.query.exerciseKey : undefined;
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const limitRaw = Number(req.query.limit);
      const rows = await listStudentExerciseNotes(req.user!.id, studentId, academyId, {
        kind,
        exerciseKey,
        since,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      });
      res.json({ success: true, data: rows });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to list notes' });
    }
  }
);

router.patch(
  '/students/:studentId/notes/:noteId',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const noteId = Number(req.params.noteId);
      if (!Number.isFinite(noteId)) {
        return res.status(400).json({ success: false, error: 'Invalid note id' });
      }
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const body = req.body || {};
      const row = await updateStudentExerciseNote(req.user!.id, Number(req.params.studentId), noteId, {
        exerciseKey: body.exerciseKey,
        exerciseName: body.exerciseName,
        kind: body.kind,
        note: body.note,
        severity: body.severity,
        loadKg: body.loadKg,
        reps: body.reps,
        sets: body.sets,
        recordedAt: body.recordedAt,
      });
      if (!row) {
        return res.status(404).json({ success: false, error: 'Note not found' });
      }
      if (academyId != null) {
        logAcademyAction({
          academyId,
          userId: req.user!.id,
          action: 'personal.student_note.updated',
          entityType: 'student_exercise_note',
          entityId: noteId,
          meta: { studentId: Number(req.params.studentId) },
          ipAddress: req.ip,
        });
      }
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.message === 'Invalid note kind' || error?.message?.includes('required')) {
        return res.status(400).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to update note' });
    }
  }
);

router.delete(
  '/students/:studentId/notes/:noteId',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const noteId = Number(req.params.noteId);
      if (!Number.isFinite(studentId) || !Number.isFinite(noteId)) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
      }
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const ok = await deleteStudentExerciseNote(req.user!.id, studentId, noteId);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Note not found' });
      }
      if (academyId != null) {
        logAcademyAction({
          academyId,
          userId: req.user!.id,
          action: 'personal.student_note.deleted',
          entityType: 'student_exercise_note',
          entityId: noteId,
          meta: { studentId },
          ipAddress: req.ip,
        });
      }
      res.json({ success: true, data: { deleted: true } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to delete note' });
    }
  }
);

router.delete(
  '/students/:studentId',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const result = await pool.query(
        `DELETE FROM personal_student_assignments
         WHERE personal_id = $1 AND student_id = $2
         RETURNING id`,
        [personalId, studentId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Aluno não encontrado na sua carteira.' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      if (academyId != null) {
        logAcademyAction({
          academyId,
          userId: personalId,
          action: 'personal.student.removed',
          entityType: 'personal_student_assignment',
          entityId: studentId,
          meta: { studentId },
          ipAddress: req.ip,
        });
      }

      res.json({ success: true, data: { removed: true } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to remove student' });
    }
  }
);

router.post('/ai/generate-workout', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ success: false, error: 'Geração com IA não configurada neste ambiente.' });
  }
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length < 5) {
    return res.status(400).json({ success: false, error: 'Prompt muito curto. Descreva o treino desejado.' });
  }
  const catalogNames = Array.isArray(req.body.catalogNames)
    ? (req.body.catalogNames as unknown[]).filter((n) => typeof n === 'string').slice(0, 150)
    : [];
  try {
    const workout = await generateWorkout(prompt, catalogNames as string[], String(req.user!.id));
    res.json({ success: true, data: workout });
  } catch (error: any) {
    const msg = String(error?.message ?? '');
    const status = msg.includes('Limite de')
      ? 429
      : msg.toLowerCase().includes('aborted') || msg.includes('demorou')
        ? 504
        : 500;
    res.status(status).json({ success: false, error: msg || 'Falha na geração com IA.' });
  }
});

router.post('/ai/metabolic-hint', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ success: false, error: 'IA não configurada neste ambiente.' });
  }
  const context = typeof req.body.context === 'string' ? req.body.context.trim() : '';
  if (!context || context.length < 5) {
    return res.status(400).json({ success: false, error: 'Contexto muito curto.' });
  }
  try {
    const hint = await getMetabolicHint(context, String(req.user!.id));
    res.json({ success: true, data: hint });
  } catch (error: any) {
    const status = error.message?.includes('Limite de') ? 429 : 500;
    res.status(status).json({ success: false, error: error.message || 'Falha na dica metabólica.' });
  }
});

router.get('/protocols', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    if (!academyId) {
      return res.status(400).json({ success: false, error: 'Academy context required' });
    }
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const scopeRaw = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const scope =
      scopeRaw === 'personal' || scopeRaw === 'academy' || scopeRaw === 'platform' || scopeRaw === 'all'
        ? (scopeRaw as ProtocolScope | 'all')
        : 'all';
    const tagGoal = typeof req.query.tagGoal === 'string' ? req.query.tagGoal : undefined;
    const limitRaw = Number(req.query.limit);
    const rows = await listWorkoutProtocolsForPersonal(req.user!.id, academyId, {
      q,
      scope,
      tagGoal,
      limit: Number.isFinite(limitRaw) ? limitRaw : 80,
    });
    res.json({ success: true, data: rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list protocols' });
  }
});


router.get('/protocols/:protocolId/usages', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const protocolId = Number(req.params.protocolId);
    if (!Number.isFinite(protocolId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol id' });
    }
    const data = await listProtocolUsages(req.user!.id, academyId, protocolId);
    res.json({ success: true, data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Protocol not found' });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to load protocol usages' });
  }
});

router.delete('/protocols/:protocolId/usages/:planId', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const protocolId = Number(req.params.protocolId);
    const planId = Number(req.params.planId);
    if (!Number.isFinite(protocolId) || !Number.isFinite(planId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol or plan id' });
    }
    const deleted = await deleteProtocolUsage(req.user!.id, academyId, protocolId, planId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Workout plan not found' });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Protocol not found' });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to remove workout plan' });
  }
});

router.get('/protocols/:protocolId', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    if (!academyId) {
      return res.status(400).json({ success: false, error: 'Academy context required' });
    }
    const protocolId = Number(req.params.protocolId);
    if (!Number.isFinite(protocolId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol id' });
    }
    const row = await getWorkoutProtocolById(req.user!.id, academyId, protocolId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Protocol not found' });
    }
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load protocol' });
  }
});

router.post('/protocols', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    if (!academyId) {
      return res.status(400).json({ success: false, error: 'Academy context required' });
    }
    const body = req.body || {};
    const scope = body.scope === 'academy' ? 'academy' : 'personal';
    const title = typeof body.title === 'string' ? body.title : '';
    const description = body.description === undefined ? undefined : body.description;
    const tags = body.tags;
    const weekPreset = typeof body.weekPreset === 'string' ? body.weekPreset : String(body.weekPreset ?? '5');
    const selectedGroup =
      body.selectedGroup === null || body.selectedGroup === undefined
        ? null
        : String(body.selectedGroup);
    const items = Array.isArray(body.items) ? body.items : [];

    const row = await createWorkoutProtocol(req.user!.id, academyId, {
      scope,
      title,
      description,
      tags,
      weekPreset,
      selectedGroup,
      items,
      days: Array.isArray(body.days) ? body.days : undefined,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    if (error?.code === 'INVALID_EXERCISES') {
      return res.status(400).json({ success: false, error: error.message, details: error.details });
    }
    if (error?.message?.includes('required') || error?.message?.includes('Invalid')) {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to create protocol' });
  }
});

router.patch('/protocols/:protocolId', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    if (!academyId) {
      return res.status(400).json({ success: false, error: 'Academy context required' });
    }
    const protocolId = Number(req.params.protocolId);
    if (!Number.isFinite(protocolId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol id' });
    }
    const body = req.body || {};
    const row = await updateWorkoutProtocol(req.user!.id, academyId, protocolId, {
      title: typeof body.title === 'string' ? body.title : undefined,
      description: body.description,
      tags: body.tags,
      weekPreset: typeof body.weekPreset === 'string' ? body.weekPreset : undefined,
      selectedGroup:
        body.selectedGroup === undefined
          ? undefined
          : body.selectedGroup === null
            ? null
            : String(body.selectedGroup),
      items: Array.isArray(body.items) ? body.items : undefined,
      days: Array.isArray(body.days) ? body.days : undefined,
    });
    res.json({ success: true, data: row });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Protocol not found' });
    }
    if (error?.code === 'FORBIDDEN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (error?.code === 'INVALID_EXERCISES') {
      return res.status(400).json({ success: false, error: error.message, details: error.details });
    }
    if (error?.message?.includes('required')) {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to update protocol' });
  }
});

router.delete('/protocols/:protocolId', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const protocolId = Number(req.params.protocolId);
    if (!Number.isFinite(protocolId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol id' });
    }
    const ok = await deleteWorkoutProtocol(req.user!.id, academyId, protocolId);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Protocol not found or not owned by you' });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete protocol' });
  }
});

router.post('/protocols/:protocolId/favorite', roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    if (!academyId) {
      return res.status(400).json({ success: false, error: 'Academy context required' });
    }
    const protocolId = Number(req.params.protocolId);
    if (!Number.isFinite(protocolId)) {
      return res.status(400).json({ success: false, error: 'Invalid protocol id' });
    }
    const favorite = Boolean((req.body || {}).favorite);
    const row = await getWorkoutProtocolById(req.user!.id, academyId, protocolId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Protocol not found' });
    }
    await setProtocolFavorite(req.user!.id, protocolId, favorite);
    res.json({ success: true, data: { favorite } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update favorite' });
  }
});

router.get(
  '/students/:studentId/protocol-suggestions',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      if (!academyId) {
        return res.status(400).json({ success: false, error: 'Academy context required' });
      }
      const rows = await suggestProtocolsForStudent(req.user!.id, studentId, academyId);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to load suggestions' });
    }
  }
);

router.get(
  '/students/:studentId/workout-plans',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const limitRaw = Number(req.query.limit);
      const rows = await listPersonalWorkoutPlans(req.user!.id, studentId, Number.isFinite(limitRaw) ? limitRaw : 50);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to list workout plans' });
    }
  }
);

// Resumo de EXECUÇÃO do aluno (Spec 010 V1.1) — aderência real (séries feitas ÷
// prescritas) + frequência. Consent 'workouts' (mesma leitura de treino).
router.get(
  '/students/:studentId/training-summary',
  roleCheckMiddleware('personal', 'admin'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }
      const data = await getStudentExecutionSummary(req.user!.id, studentId);
      res.json({ success: true, data });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: 'Failed to load training summary' });
    }
  }
);

router.post(
  '/students/:studentId/workout-plans',
  roleCheckMiddleware('personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title : '';
      const weekPreset = typeof body.weekPreset === 'string' ? body.weekPreset : String(body.weekPreset ?? '5');
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const sourceProtocolId = body.sourceProtocolId == null ? null : Number(body.sourceProtocolId);

      let row: any;

      if (Array.isArray(body.days) && body.days.length > 0) {
        // Multi-day save
        row = await createPersonalWorkoutPlanWithDays(req.user!.id, studentId, academyId, {
          title,
          weekPreset,
          days: body.days,
          sourceProtocolId: Number.isFinite(sourceProtocolId) ? sourceProtocolId : null,
        });
      } else {
        // Legacy single-list save
        const selectedGroup =
          body.selectedGroup === null || body.selectedGroup === undefined
            ? null
            : String(body.selectedGroup);
        const items = Array.isArray(body.items) ? body.items : [];
        row = await createPersonalWorkoutPlan(req.user!.id, studentId, academyId, {
          title,
          weekPreset,
          selectedGroup,
          items,
          sourceProtocolId: Number.isFinite(sourceProtocolId) ? sourceProtocolId : null,
        });
      }

      res.status(201).json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error?.code === 'INVALID_EXERCISES') {
        return res.status(400).json({ success: false, error: error.message, details: error.details });
      }
      if (error?.code === 'PROTOCOL_NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'Protocol not found' });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to save workout plan' });
    }
  }
);

router.patch(
  '/students/:studentId/workout-plans/:planId',
  roleCheckMiddleware('personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const planId = Number(req.params.planId);
      if (!Number.isFinite(studentId) || !Number.isFinite(planId)) {
        return res.status(400).json({ success: false, error: 'Invalid student or plan id' });
      }
      const body = req.body || {};
      const title = typeof body.title === 'string' ? body.title : '';
      const weekPreset = typeof body.weekPreset === 'string' ? body.weekPreset : String(body.weekPreset ?? '5');
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const days = Array.isArray(body.days) ? body.days : [];

      const row = await updatePersonalWorkoutPlanWithDays(req.user!.id, planId, studentId, academyId, {
        title,
        weekPreset,
        days,
      });
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'PLAN_NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'Plan not found or access denied' });
      }
      if (error?.code === 'INVALID_EXERCISES') {
        return res.status(400).json({ success: false, error: error.message, details: error.details });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to update workout plan' });
    }
  }
);

/**
 * Personal reativa uma ficha que o aluno havia abandonado.
 * Volta a aparecer na listagem do aluno.
 */
router.post(
  '/students/:studentId/workout-plans/:planId/reactivate',
  roleCheckMiddleware('personal', 'admin'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      const planId = Number(req.params.planId);
      if (!Number.isFinite(studentId) || !Number.isFinite(planId)) {
        return res.status(400).json({ success: false, error: 'Invalid student or plan id' });
      }
      const ok = await reactivateWorkoutPlan(req.user!.id, studentId, planId);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Plan not found, not yours, or not abandoned' });
      }
      res.json({ success: true, data: { reactivated: true } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to reactivate plan' });
    }
  }
);

router.get(
  '/reviews',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const rows = await listWorkoutReviews(req.user!.id);
      res.json({ success: true, data: rows });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to list reviews' });
    }
  }
);

router.post(
  '/reviews',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const studentId = Number(body.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid studentId' });
      }
      const workoutPlanId =
        body.workoutPlanId === undefined || body.workoutPlanId === null
          ? null
          : Number(body.workoutPlanId);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

      const row = await createWorkoutReview(req.user!.id, academyId, {
        studentId,
        title: String(body.title || ''),
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        risk: typeof body.risk === 'string' ? (body.risk as ReviewRisk) : undefined,
        priority: typeof body.priority === 'string' ? (body.priority as ReviewPriority) : undefined,
        workoutPlanId: Number.isFinite(workoutPlanId) ? workoutPlanId : null,
        internalNotes: typeof body.internalNotes === 'string' ? body.internalNotes : null,
      });
      res.status(201).json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to create review' });
    }
  }
);

router.patch(
  '/reviews/:reviewId',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const reviewId = Number(req.params.reviewId);
      if (!Number.isFinite(reviewId)) {
        return res.status(400).json({ success: false, error: 'Invalid reviewId' });
      }
      const body = req.body || {};
      const row = await updateWorkoutReview(req.user!.id, reviewId, {
        internalNotes: typeof body.internalNotes === 'string' ? body.internalNotes : undefined,
        studentFeedback: typeof body.studentFeedback === 'string' ? body.studentFeedback : undefined,
      });
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to update review' });
    }
  }
);

router.post(
  '/reviews/:reviewId/approve',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const reviewId = Number(req.params.reviewId);
      if (!Number.isFinite(reviewId)) {
        return res.status(400).json({ success: false, error: 'Invalid reviewId' });
      }
      const internalNotes =
        typeof req.body?.internalNotes === 'string' ? req.body.internalNotes : undefined;
      const row = await approveWorkoutReview(req.user!.id, reviewId, internalNotes);
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to approve review' });
    }
  }
);

router.post(
  '/reviews/:reviewId/request-changes',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const reviewId = Number(req.params.reviewId);
      if (!Number.isFinite(reviewId)) {
        return res.status(400).json({ success: false, error: 'Invalid reviewId' });
      }
      const studentFeedback = String(req.body?.studentFeedback ?? '');
      if (!studentFeedback.trim()) {
        return res
          .status(400)
          .json({ success: false, error: 'studentFeedback is required when requesting changes' });
      }
      const internalNotes =
        typeof req.body?.internalNotes === 'string' ? req.body.internalNotes : undefined;
      const row = await requestChangesWorkoutReview(
        req.user!.id,
        reviewId,
        studentFeedback,
        internalNotes
      );
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to request changes' });
    }
  }
);

router.post(
  '/reviews/:reviewId/archive',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const reviewId = Number(req.params.reviewId);
      if (!Number.isFinite(reviewId)) {
        return res.status(400).json({ success: false, error: 'Invalid reviewId' });
      }
      const row = await archiveWorkoutReview(req.user!.id, reviewId);
      res.json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to archive review' });
    }
  }
);

// ── Direct Student Registration ───────────────────────────────────────────────

router.post(
  '/students',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

      const gate = await checkStudentLimitGate(personalId);
      if (gate.over) {
        return res.status(403).json({
          success: false,
          code: 'STUDENT_LIMIT_REACHED',
          limit: gate.limit,
          current: gate.current,
        });
      }

      const name: string = (req.body.name ?? '').toString().trim();
      const email: string = (req.body.email ?? '').toString().trim().toLowerCase();
      const phone: string | null = typeof req.body.phone === 'string' ? req.body.phone.trim() || null : null;
      const cpf: string | null = typeof req.body.cpf === 'string' ? req.body.cpf.replace(/\D/g, '') || null : null;

      if (!name) return res.status(400).json({ success: false, error: 'Nome é obrigatório.' });
      if (!email) return res.status(400).json({ success: false, error: 'E-mail é obrigatório.' });

      const tempPassword = 'Mf!' + crypto.randomBytes(6).toString('base64url') + 'A1';
      const { user, isNew, matchedBy } = await findOrCreateUserFromContext({
        name, email, phone, cpf,
        password: tempPassword,
        skipPasswordPolicy: true,
      });

      if (isNew) {
        await pool.query(
          `UPDATE users
              SET must_change_password = TRUE
            WHERE id = $1`,
          [user.id]
        );
        // Assign Free subscription tier — same as the invite-accept flow
        await pool.query(
          `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
           SELECT $1, id, 'active', NOW() FROM subscription_tiers WHERE name = 'Free'
           ON CONFLICT DO NOTHING`,
          [user.id]
        );
      }

      // For existing users: persist phone if provided in the form and not yet set.
      // findOrCreateUserFromContext doesn't update existing records, so without this
      // the phone entered during direct registration would be silently ignored and
      // the WhatsApp link on MessagesPage would stay null or use a stale value.
      if (!isNew && phone && !user.phone) {
        await pool.query(
          `UPDATE users SET phone = $1 WHERE id = $2 AND phone IS NULL`,
          [phone, user.id]
        );
      }

      // Idempotent assignment
      const existing = await pool.query(
        `SELECT id FROM personal_student_assignments WHERE personal_id = $1 AND student_id = $2`,
        [personalId, user.id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'Este aluno já está na sua carteira.',
          code: 'ALREADY_ASSIGNED',
          data: { studentId: user.id, name: user.name },
        });
      }

      await pool.query(
        `INSERT INTO personal_student_assignments (personal_id, student_id, academy_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [personalId, user.id, academyId]
      );

      await grantMembership(user.id, 'personal', {
        professionalId: personalId,
        academyId: academyId ?? undefined,
        metadata: { source: 'personal_direct_add' },
      });
      await grantMembership(user.id, 'app', {
        metadata: { source: 'personal_direct_add' },
      });

      res.status(201).json({
        success: true,
        data: {
          student: { id: user.id, name: user.name, email: user.email },
          isNew,
          matchedBy: matchedBy === 'none' ? null : matchedBy,
          tempPassword: isNew ? tempPassword : undefined,
          mustChangePassword: isNew,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to add student' });
    }
  }
);

// ── Direct Invites (personal autônomo → aluno direto sem academia) ────────────

const INVITE_EXPIRY_DAYS = 14;

router.post(
  '/direct-invites',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;

      const gate = await checkStudentLimitGate(personalId);
      if (gate.over) {
        return res.status(403).json({
          success: false,
          code: 'STUDENT_LIMIT_REACHED',
          limit: gate.limit,
          current: gate.current,
        });
      }

      const invitedEmail = typeof req.body.invitedEmail === 'string' ? req.body.invitedEmail.trim().toLowerCase() || null : null;
      const invitedName = typeof req.body.invitedName === 'string' ? req.body.invitedName.trim().slice(0, 255) || null : null;

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const result = await pool.query(
        `INSERT INTO personal_direct_invites (personal_id, token, invited_email, invited_name, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, token, invited_email, invited_name, status, expires_at, created_at`,
        [personalId, token, invitedEmail, invitedName, expiresAt]
      );

      const row = result.rows[0];
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.corefit.com.br';
      const inviteUrl = `${frontendUrl}/convite-personal/${token}`;

      res.status(201).json({ success: true, data: { ...row, inviteUrl } });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to create invite' });
    }
  }
);

router.get(
  '/direct-invites',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.corefit.com.br';

      // Expire pending tokens past expiry date
      await pool.query(
        `UPDATE personal_direct_invites
         SET status = 'expired'
         WHERE personal_id = $1 AND status = 'pending' AND expires_at < NOW()`,
        [personalId]
      );

      const result = await pool.query(
        `SELECT pdi.id, pdi.token, pdi.invited_email, pdi.invited_name,
                pdi.status, pdi.expires_at, pdi.created_at, pdi.accepted_at,
                u.name AS accepted_user_name
         FROM personal_direct_invites pdi
         LEFT JOIN users u ON u.id = pdi.accepted_user_id
         WHERE pdi.personal_id = $1
         ORDER BY pdi.created_at DESC
         LIMIT 100`,
        [personalId]
      );

      const rows = result.rows.map((r) => ({
        ...r,
        inviteUrl: `${frontendUrl}/convite-personal/${r.token}`,
      }));

      res.json({ success: true, data: rows });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to list invites' });
    }
  }
);

router.delete(
  '/direct-invites/:id',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const inviteId = Number(req.params.id);
      if (!Number.isFinite(inviteId)) {
        return res.status(400).json({ success: false, error: 'Invalid invite id' });
      }

      const result = await pool.query(
        `UPDATE personal_direct_invites
         SET status = 'revoked'
         WHERE id = $1 AND personal_id = $2 AND status = 'pending'
         RETURNING id`,
        [inviteId, personalId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Invite not found or already used/expired' });
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to revoke invite' });
    }
  }
);

// ===========================================================================
// Retention Intelligence — Actions
// ===========================================================================

router.post(
  '/students/:studentId/actions',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const { actionType, payloadJson, source, dueAt, linkedSignalId } = req.body;

      if (!actionType) return res.status(400).json({ success: false, error: 'actionType required' });

      const action = await createRelationshipAction(personalId, studentId, academyId, {
        actionType: actionType as ActionType,
        payloadJson,
        source,
        dueAt,
        linkedSignalId,
      });
      res.status(201).json({ success: true, data: action });
    } catch (error: any) {
      if (error.code === 'ASSIGNMENT_REQUIRED') return res.status(403).json({ success: false, error: 'Student not assigned' });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.get(
  '/students/:studentId/timeline',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const limit = Number(req.query.limit) || 50;
      const items = await listRelationshipTimeline(personalId, studentId, academyId, { limit });
      res.json({ success: true, data: items });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.patch(
  '/actions/:actionId/resolve',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const actionId = Number(req.params.actionId);
      const action = await resolveRelationshipAction(actionId, personalId);
      res.json({ success: true, data: action });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.delete(
  '/actions/:actionId',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const actionId = Number(req.params.actionId);
      const result = await deleteRelationshipAction(actionId, personalId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ===========================================================================
// Retention Intelligence — Message Templates
// ===========================================================================

router.get(
  '/message-templates',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const templates = await listVisibleTemplates(personalId, academyId);
      res.json({ success: true, data: templates });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.post(
  '/message-templates',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const { category, title, body, isDefault } = req.body;
      if (!title || !body || !category) {
        return res.status(400).json({ success: false, error: 'category, title and body are required' });
      }
      const template = await createPersonalTemplate(personalId, academyId, { category, title, body, isDefault });
      res.status(201).json({ success: true, data: template });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.patch(
  '/message-templates/:id',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const templateId = Number(req.params.id);
      const template = await updatePersonalTemplate(templateId, personalId, req.body);
      res.json({ success: true, data: template });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.delete(
  '/message-templates/:id',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const templateId = Number(req.params.id);
      await deletePersonalTemplate(templateId, personalId);
      res.json({ success: true });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ===========================================================================
// Billing — Settings + Plans
// ===========================================================================

router.get(
  '/billing/settings',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const settings = await getBillingSettings(req.user!.id);
      res.json({ success: true, data: settings });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.patch(
  '/billing/settings',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const settings = await upsertBillingSettings(req.user!.id, req.body);
      res.json({ success: true, data: settings });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.get(
  '/billing/plans',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const plans = await listBillingPlans(personalId, academyId);
      res.json({ success: true, data: plans });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.post(
  '/billing/plans',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const { title, description, priceCents, period } = req.body;
      if (!title || priceCents == null) {
        return res.status(400).json({ success: false, error: 'title and priceCents are required' });
      }
      const plan = await createBillingPlan(personalId, academyId, { title, description, priceCents, period });
      res.status(201).json({ success: true, data: plan });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.patch(
  '/billing/plans/:id',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const planId = Number(req.params.id);
      const plan = await updateBillingPlan(planId, personalId, req.body);
      res.json({ success: true, data: plan });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.delete(
  '/billing/plans/:id',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const planId = Number(req.params.id);
      await deleteBillingPlan(planId, personalId);
      res.json({ success: true });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.get(
  '/students/:studentId/subscription',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);
      const sub = await getStudentSubscription(personalId, studentId);
      res.json({ success: true, data: sub });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.post(
  '/students/:studentId/subscribe',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const { planId, discountCents, studentEmail, studentName } = req.body;

      if (!planId || !studentEmail) {
        return res.status(400).json({ success: false, error: 'planId and studentEmail are required' });
      }

      const frontendUrl =
        (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim() || 'https://app.corefit.com.br';

      const result = await subscribeStudent(personalId, studentId, academyId, planId, {
        discountCents,
        studentEmail,
        studentName: studentName ?? '',
        frontendUrl,
      });
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.post(
  '/subscriptions/:id/cancel',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const subId = Number(req.params.id);
      const sub = await cancelSubscription(subId, personalId);
      res.json({ success: true, data: sub });
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

router.get(
  '/finance/summary',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const range = (req.query.range as '30d' | '90d' | '12m') || '30d';
      const summary = await computeFinanceSummary(personalId, academyId, range);
      res.json({ success: true, data: summary });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── Coach View: Fight Intelligence ──────────────────────────────────────────

router.get(
  '/students/:studentId/sport',
  roleCheckMiddleware('personal'),
  requireActiveConsent('sports'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);

      // Gate 2: verify active assignment between this personal and student
      const link = await pool.query(
        `SELECT id FROM personal_student_assignments
         WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
        [personalId, studentId],
      );
      if (link.rows.length === 0) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }

      const profile = await getSportProfile(studentId);
      if (!profile || !profile.active) {
        res.json({ success: true, sport: null });
        return;
      }

      const [readiness, camps, fatigueData, lastGap] = await Promise.all([
        getReadinessToday(studentId),
        listCamps(studentId, 'active'),
        getFatigue7d(studentId),
        getLastRecoveryGap(studentId),
      ]);

      const activeCamp = camps[0] ?? null;

      void logDataAccessEvent({
        actorId: personalId,
        subjectUserId: studentId,
        eventType: 'personal.sport.read',
        ip: req.ip,
      });

      res.json({
        success: true,
        sport: {
          profile: {
            primary_sport: profile.primary_sport,
            sport_level: profile.sport_level,
            weekly_frequency: profile.weekly_frequency,
            competes: profile.competes,
          },
          readiness_today: readiness
            ? {
                final_score: readiness.final_score,
                risk_level: readiness.risk_level,
                recommendation: readiness.recommendation,
                has_checkin_today: readiness.has_checkin_today,
              }
            : null,
          last_recovery_gap: lastGap,
          fatigue_7d: fatigueData.fatigue_7d,
          fatigue_level: fatigueData.level,
          active_camp: activeCamp
            ? {
                event_name: activeCamp.event_name,
                event_date: activeCamp.event_date,
                days_remaining: activeCamp.days_remaining,
                camp_phase: activeCamp.camp_phase,
                current_weight_kg: activeCamp.current_weight_kg ?? null,
                target_weight_kg: activeCamp.target_weight_kg ?? null,
              }
            : null,
        },
      });
    } catch (err) {
      logger.error({ err: err }, '[personal/students/sport GET]');
      res.status(500).json({ success: false, error: 'Failed to load sport data' });
    }
  },
);

// ── Adaptation policy — GET (read or return defaults) ──────────────────────
// Sem requireActiveConsent: policy é configuração do personal, não dado do aluno.
// Autorização real = assignment ativo (checado dentro do handler).
router.get(
  '/students/:studentId/adaptation-policy',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);

      const link = await pool.query(
        `SELECT id FROM personal_student_assignments
         WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
        [personalId, studentId],
      );
      if (link.rows.length === 0) {
        res.status(403).json({ success: false, error: 'assignment_required' });
        return;
      }

      const { rows } = await pool.query(
        `SELECT * FROM training_adaptation_policy
         WHERE personal_id = $1 AND student_id = $2 LIMIT 1`,
        [personalId, studentId],
      );

      if (!rows[0]) {
        const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
        res.json({ success: true, data: defaultPolicy(personalId, studentId, academyId) });
        return;
      }

      res.json({ success: true, data: mapPolicyRow(rows[0]) });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// ── Adaptation policy — PATCH (upsert) ─────────────────────────────────────
// Sem requireActiveConsent: policy é configuração do personal, não dado do aluno.
router.patch(
  '/students/:studentId/adaptation-policy',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);

      const link = await pool.query(
        `SELECT id FROM personal_student_assignments
         WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
        [personalId, studentId],
      );
      if (link.rows.length === 0) {
        res.status(403).json({ success: false, error: 'assignment_required' });
        return;
      }

      const b = req.body;
      const errors: string[] = [];

      if (b.maxSetReductionPct !== undefined) {
        const v = Number(b.maxSetReductionPct);
        if (!Number.isFinite(v) || v < 0 || v > 50) errors.push('maxSetReductionPct deve ser 0–50');
      }
      if (b.maxRestIncreasePct !== undefined) {
        const v = Number(b.maxRestIncreasePct);
        if (!Number.isFinite(v) || v < 0 || v > 60) errors.push('maxRestIncreasePct deve ser 0–60');
      }
      if (b.minIntensityPct !== undefined) {
        const v = Number(b.minIntensityPct);
        if (!Number.isFinite(v) || v < 50 || v > 100) errors.push('minIntensityPct deve ser 50–100');
      }
      if (errors.length) {
        res.status(400).json({ success: false, error: 'invalid_policy', details: errors });
        return;
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

      // COALESCE no VALUES também: primeiro INSERT pode receber NULL para campos
      // não enviados, mas as colunas são NOT NULL — usar defaults da tabela.
      const { rows } = await pool.query(
        `INSERT INTO training_adaptation_policy
           (personal_id, student_id, academy_id,
            master_enabled, allow_volume_reduction, allow_rest_increase,
            allow_intensity_reduction, allow_active_recovery_substitution, allow_mobility_suggestion,
            max_set_reduction_pct, max_rest_increase_pct, min_intensity_pct,
            version, updated_at)
         VALUES ($1,$2,$3,
           COALESCE($4, FALSE), COALESCE($5, FALSE), COALESCE($6, FALSE),
           COALESCE($7, FALSE), COALESCE($8, FALSE), COALESCE($9, FALSE),
           COALESCE($10, 25),   COALESCE($11, 30),   COALESCE($12, 70),
           1, now())
         ON CONFLICT (personal_id, student_id) DO UPDATE SET
           master_enabled                     = COALESCE($4, training_adaptation_policy.master_enabled),
           allow_volume_reduction             = COALESCE($5, training_adaptation_policy.allow_volume_reduction),
           allow_rest_increase                = COALESCE($6, training_adaptation_policy.allow_rest_increase),
           allow_intensity_reduction          = COALESCE($7, training_adaptation_policy.allow_intensity_reduction),
           allow_active_recovery_substitution = COALESCE($8, training_adaptation_policy.allow_active_recovery_substitution),
           allow_mobility_suggestion          = COALESCE($9, training_adaptation_policy.allow_mobility_suggestion),
           max_set_reduction_pct = COALESCE($10, training_adaptation_policy.max_set_reduction_pct),
           max_rest_increase_pct = COALESCE($11, training_adaptation_policy.max_rest_increase_pct),
           min_intensity_pct     = COALESCE($12, training_adaptation_policy.min_intensity_pct),
           version    = training_adaptation_policy.version + 1,
           updated_at = now()
         RETURNING *`,
        [
          personalId, studentId, academyId,
          b.masterEnabled !== undefined ? Boolean(b.masterEnabled) : null,
          b.allowVolumeReduction !== undefined ? Boolean(b.allowVolumeReduction) : null,
          b.allowRestIncrease !== undefined ? Boolean(b.allowRestIncrease) : null,
          b.allowIntensityReduction !== undefined ? Boolean(b.allowIntensityReduction) : null,
          b.allowActiveRecoverySubstitution !== undefined ? Boolean(b.allowActiveRecoverySubstitution) : null,
          b.allowMobilitySuggestion !== undefined ? Boolean(b.allowMobilitySuggestion) : null,
          b.maxSetReductionPct !== undefined ? Number(b.maxSetReductionPct) : null,
          b.maxRestIncreasePct !== undefined ? Number(b.maxRestIncreasePct) : null,
          b.minIntensityPct !== undefined ? Number(b.minIntensityPct) : null,
        ],
      );

      void logDataAccessEvent({
        actorId: personalId,
        subjectUserId: studentId,
        eventType: 'training.policy.updated',
        eventPayload: { policyVersion: rows[0].version, masterEnabled: rows[0].master_enabled },
        ip: req.ip,
      }).catch(() => {});

      res.json({ success: true, data: mapPolicyRow(rows[0]) });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// ── Adaptation log — GET ────────────────────────────────────────────────────
router.get(
  '/students/:studentId/adaptation-log',
  roleCheckMiddleware('personal'),
  requireActiveConsent('workouts'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
      const studentId = Number(req.params.studentId);

      const link = await pool.query(
        `SELECT id FROM personal_student_assignments
         WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
        [personalId, studentId],
      );
      if (link.rows.length === 0) {
        res.status(403).json({ success: false, error: 'assignment_required' });
        return;
      }

      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const limit = Math.min(100, parseInt((req.query.limit as string) || '30', 10));

      const { rows } = await pool.query(
        `SELECT id, snapshot_date, readiness_level, readiness_factors,
                policy_version, changes, created_at
         FROM workout_adaptation_log
         WHERE student_id = $1 AND personal_id = $2
           AND ($3::date IS NULL OR snapshot_date >= $3::date)
           AND ($4::date IS NULL OR snapshot_date <= $4::date)
         ORDER BY snapshot_date DESC, id DESC
         LIMIT $5`,
        [studentId, personalId, from ?? null, to ?? null, limit],
      );

      res.json({ success: true, data: rows.map(r => ({
        id: r.id,
        snapshotDate: r.snapshot_date,
        readinessLevel: r.readiness_level,
        readinessFactors: r.readiness_factors,
        policyVersion: r.policy_version,
        changes: r.changes,
        createdAt: r.created_at,
      })) });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

function mapPolicyRow(r: Record<string, unknown>) {
  return {
    personalId: r.personal_id,
    studentId: r.student_id,
    academyId: r.academy_id,
    version: r.version,
    masterEnabled: r.master_enabled,
    allowVolumeReduction: r.allow_volume_reduction,
    allowRestIncrease: r.allow_rest_increase,
    allowIntensityReduction: r.allow_intensity_reduction,
    allowActiveRecoverySubstitution: r.allow_active_recovery_substitution,
    allowMobilitySuggestion: r.allow_mobility_suggestion,
    maxSetReductionPct: r.max_set_reduction_pct,
    maxRestIncreasePct: r.max_rest_increase_pct,
    minIntensityPct: r.min_intensity_pct,
  };
}

function defaultPolicy(personalId: number, studentId: number, academyId: number | null) {
  return {
    personalId, studentId, academyId, version: 0,
    masterEnabled: false,
    allowVolumeReduction: false, allowRestIncrease: false,
    allowIntensityReduction: false, allowActiveRecoverySubstitution: false, allowMobilitySuggestion: false,
    maxSetReductionPct: 25, maxRestIncreasePct: 30, minIntensityPct: 70,
  };
}

export default router;
