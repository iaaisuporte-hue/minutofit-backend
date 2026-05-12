import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { getPersonalConsulting, getPersonalDashboard, getPersonalStudentSnapshot } from '../services/personalDashboardService';
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

router.get('/dashboard', authMiddleware, roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getPersonalDashboard(req.user!.id, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load personal dashboard' });
  }
});

router.get('/consulting/students', authMiddleware, roleCheckMiddleware('personal'), async (req: Request, res: Response) => {
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
  authMiddleware,
  roleCheckMiddleware('personal'),
  async (req: Request, res: Response) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!Number.isFinite(studentId)) {
        return res.status(400).json({ success: false, error: 'Invalid student id' });
      }

      const data = await getPersonalStudentSnapshot(req.user!.id, studentId);
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
  '/students/:studentId/workout-plans',
  authMiddleware,
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
  authMiddleware,
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

      const row = await createPersonalWorkoutPlan(req.user!.id, studentId, {
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

router.get(
  '/reviews',
  authMiddleware,
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
  authMiddleware,
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
      const row = await createWorkoutReview(req.user!.id, {
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
  authMiddleware,
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
  authMiddleware,
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
  authMiddleware,
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
  authMiddleware,
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
