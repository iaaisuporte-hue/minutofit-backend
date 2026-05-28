import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireSportActive } from '../middleware/sportGate';
import {
  getSportProfile,
  upsertSportProfile,
  deactivateSportProfile,
} from '../services/sportProfileService';
import {
  createPreWorkoutCheckin,
  listPreWorkoutCheckins,
} from '../services/sportCheckinService';
import { getReadinessToday } from '../services/sportReadinessService';
import { listCamps, createCamp, updateCamp } from '../services/campService';
import { logDataAccessEvent } from '../services/dataAccessAuditService';

const router = Router();

router.get('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const profile = await getSportProfile(req.user!.id);
    if (!profile) {
      res.status(404).json({ success: false, error: 'Sport profile not found' });
      return;
    }
    res.json({ success: true, profile });
  } catch (err) {
    console.error('[sport/profile GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load sport profile' });
  }
});

router.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const profile = await upsertSportProfile(userId, req.body);
    void logDataAccessEvent({ actorId: userId, subjectUserId: userId, eventType: 'sport.profile.upserted', ip: req.ip });
    res.json({ success: true, profile });
  } catch (err: any) {
    if (err.status === 400) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    console.error('[sport/profile PUT]', err);
    res.status(500).json({ success: false, error: 'Failed to save sport profile' });
  }
});

router.delete('/profile', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await deactivateSportProfile(userId);
    void logDataAccessEvent({ actorId: userId, subjectUserId: userId, eventType: 'sport.profile.deactivated', ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('[sport/profile DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to deactivate sport profile' });
  }
});

// ── Pre-workout check-ins ────────────────────────────────────────────────────

router.post('/checkins/pre-workout', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const checkin = await createPreWorkoutCheckin(userId, req.body);
    void logDataAccessEvent({ actorId: userId, subjectUserId: userId, eventType: 'sport.checkin.created', ip: req.ip });
    res.status(201).json({ success: true, checkin });
  } catch (err: any) {
    if (err.code === '23514') {
      res.status(400).json({ success: false, error: 'Valores fora do intervalo permitido (1-5)' });
      return;
    }
    console.error('[sport/checkins POST]', err);
    res.status(500).json({ success: false, error: 'Failed to save check-in' });
  }
});

router.get('/checkins/pre-workout', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const checkins = await listPreWorkoutCheckins(req.user!.id, from, to);
    res.json({ success: true, checkins });
  } catch (err) {
    console.error('[sport/checkins GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load check-ins' });
  }
});

// ── Readiness ────────────────────────────────────────────────────────────────

router.get('/readiness/today', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const readiness = await getReadinessToday(req.user!.id);
    if (!readiness) {
      res.status(404).json({ success: false, error: 'No check-in submitted today' });
      return;
    }
    res.json({ success: true, readiness });
  } catch (err) {
    console.error('[sport/readiness GET]', err);
    res.status(500).json({ success: false, error: 'Failed to compute readiness' });
  }
});

// ── Competition Camps ────────────────────────────────────────────────────────

router.get('/camps', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const camps = await listCamps(req.user!.id, status);
    res.json({ success: true, camps });
  } catch (err) {
    console.error('[sport/camps GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load camps' });
  }
});

router.post('/camps', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const { event_name, event_date } = req.body;
    if (!event_name || !event_date) {
      res.status(400).json({ success: false, error: 'event_name and event_date are required' });
      return;
    }
    const userId = req.user!.id;
    const camp = await createCamp(userId, req.body);
    void logDataAccessEvent({ actorId: userId, subjectUserId: userId, eventType: 'sport.camp.created', ip: req.ip });
    res.status(201).json({ success: true, camp });
  } catch (err) {
    console.error('[sport/camps POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create camp' });
  }
});

router.patch('/camps/:id', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const campId = Number(req.params.id);
    const camp = await updateCamp(req.user!.id, campId, req.body);
    if (!camp) {
      res.status(404).json({ success: false, error: 'Camp not found' });
      return;
    }
    res.json({ success: true, camp });
  } catch (err) {
    console.error('[sport/camps PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update camp' });
  }
});

// ── Dashboard aggregate ───────────────────────────────────────────────────────

router.get('/dashboard', authMiddleware, requireSportActive, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const [profile, readiness, camps, checkins] = await Promise.all([
      (await import('../services/sportProfileService')).getSportProfile(userId),
      getReadinessToday(userId),
      listCamps(userId, 'active'),
      (await import('../services/sportCheckinService')).listPreWorkoutCheckins(userId),
    ]);
    res.json({
      success: true,
      dashboard: {
        profile,
        readiness_today: readiness,
        recent_checkins: checkins.slice(0, 7),
        active_camp: camps[0] ?? null,
      },
    });
  } catch (err) {
    console.error('[sport/dashboard GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

export default router;
