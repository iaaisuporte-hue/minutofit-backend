import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireAcademyContext } from '../middleware/tenantContext';
import { requireProduct } from '../middleware/productGate';
import {
  getPersonalConsulting,
  getPersonalDashboard,
  getPersonalStudentSnapshot,
  listPersonalStudentActivities,
} from '../services/personalDashboardService';
import {
  createStudentExerciseNote,
  deleteStudentExerciseNote,
  listStudentExerciseNotes,
  updateStudentExerciseNote,
} from '../services/studentExerciseNotesService';
import { logAcademyAction } from '../services/auditService';
import {
  createPersonalWorkoutPlan,
  listPersonalWorkoutPlans,
  listWorkoutPlansForStudent,
} from '../services/personalWorkoutPlanService';
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
  deleteWorkoutProtocol,
  getWorkoutProtocolById,
  listWorkoutProtocolsForPersonal,
  setProtocolFavorite,
  suggestProtocolsForStudent,
  updateWorkoutProtocol,
  type ProtocolScope,
} from '../services/workoutProtocolService';
import { generateWorkout } from '../services/ai/workoutAi';
import { getMetabolicHint } from '../services/ai/metabolicHint';
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
  listBillingPlans,
  subscribeStudent,
  updateBillingPlan,
  upsertBillingSettings,
} from '../services/personalBillingService';

const router = Router();
router.use(authMiddleware, requireProduct('personal'), requireAcademyContext);

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
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
      const data = await getPersonalStudentSnapshot(req.user!.id, studentId, academyId);
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
  '/students/:studentId/activities',
  roleCheckMiddleware('personal'),
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

router.get(
  '/students/:studentId/notes',
  roleCheckMiddleware('personal'),
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
      const selectedGroup =
        body.selectedGroup === null || body.selectedGroup === undefined
          ? null
          : String(body.selectedGroup);
      const items = Array.isArray(body.items) ? body.items : [];

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

      const row = await createPersonalWorkoutPlan(req.user!.id, studentId, academyId, {
        title,
        weekPreset,
        selectedGroup,
        items,
      });

      res.status(201).json({ success: true, data: row });
    } catch (error: any) {
      if (error?.code === 'ASSIGNMENT_REQUIRED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error?.code === 'INVALID_EXERCISES') {
        return res.status(400).json({ success: false, error: error.message, details: error.details });
      }
      res.status(500).json({ success: false, error: error.message || 'Failed to save workout plan' });
    }
  }
);

router.get(
  '/my/workout-plans',
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

// ── Direct Invites (personal autônomo → aluno direto sem academia) ────────────

import crypto from 'crypto';
import pool from '../config/database';

const INVITE_EXPIRY_DAYS = 14;

router.post(
  '/direct-invites',
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const personalId = req.user!.id;
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
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.minutofit.com.br';
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
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.minutofit.com.br';

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
      const { actionType, payloadJson, source, dueAt } = req.body;

      if (!actionType) return res.status(400).json({ success: false, error: 'actionType required' });

      const action = await createRelationshipAction(personalId, studentId, academyId, {
        actionType: actionType as ActionType,
        payloadJson,
        source,
        dueAt,
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
        (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim() || 'https://app.minutofit.com.br';

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

export default router;
