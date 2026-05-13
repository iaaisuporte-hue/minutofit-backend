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

      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId;
      if (!academyId) {
        return res.status(400).json({ success: false, error: 'Academy context required to create a workout plan' });
      }

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
      const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId;
      if (!academyId) {
        return res.status(400).json({ success: false, error: 'Academy context required to create a review' });
      }

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

export default router;
