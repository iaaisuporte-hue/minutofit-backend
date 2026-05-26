import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireActiveConsent } from '../middleware/requireActiveConsent';
import pool from '../config/database';
import logger from '../lib/logger';
import {
  createPlan,
  getActivePlan,
  getPlanHistory,
  endPlan,
  updatePlan,
  getAdherenceForPeriod,
  createObservation,
  getObservations,
  getPatientContext,
  getPatientsWithSummary,
} from '../services/nutriService';

const router = Router();

const INVITE_EXPIRY_DAYS = 14;

// All nutri routes require authentication + nutri product gate
router.use(authMiddleware, requireProduct('nutri'));

// Defesa em profundidade: qualquer rota futura sob /patients/:patientId
// (detalhes, plano alimentar, evolução, métricas) exige consentimento ativo
// do paciente para `profile`. Handlers individuais devem adicionar escopos
// mais específicos (nutrition, body_metrics, etc.) conforme cada endpoint.
router.use(
  '/patients/:patientId',
  roleCheckMiddleware('nutri'),
  requireActiveConsent('profile'),
);

// ===========================================================================
// Direct Invites — nutri autônoma convida paciente direto
// ===========================================================================

router.post('/direct-invites', roleCheckMiddleware('nutri'), async (req: Request, res: Response) => {
  try {
    const nutriId = req.user!.id;
    const invitedEmail = typeof req.body.invitedEmail === 'string'
      ? req.body.invitedEmail.trim().toLowerCase() || null : null;
    const invitedName = typeof req.body.invitedName === 'string'
      ? req.body.invitedName.trim().slice(0, 255) || null : null;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO nutri_direct_invites (nutri_id, token, invited_email, invited_name, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, token, invited_email, invited_name, status, expires_at, created_at`,
      [nutriId, token, invitedEmail, invitedName, expiresAt]
    );

    const row = result.rows[0];
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.minutofit.com.br';
    const inviteUrl = `${frontendUrl}/convite-nutri/${token}`;

    res.status(201).json({ success: true, data: { ...row, inviteUrl } });
  } catch (err: any) {
    logger.error({ err }, '[nutri] create direct-invite error');
    res.status(500).json({ success: false, error: err.message || 'Failed to create invite' });
  }
});

router.get('/direct-invites', roleCheckMiddleware('nutri'), async (req: Request, res: Response) => {
  try {
    const nutriId = req.user!.id;
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.minutofit.com.br';

    await pool.query(
      `UPDATE nutri_direct_invites
       SET status = 'expired'
       WHERE nutri_id = $1 AND status = 'pending' AND expires_at < NOW()`,
      [nutriId]
    );

    const result = await pool.query(
      `SELECT ndi.id, ndi.token, ndi.invited_email, ndi.invited_name,
              ndi.status, ndi.expires_at, ndi.created_at, ndi.accepted_at,
              u.name AS accepted_user_name
       FROM nutri_direct_invites ndi
       LEFT JOIN users u ON u.id = ndi.accepted_user_id
       WHERE ndi.nutri_id = $1
       ORDER BY ndi.created_at DESC
       LIMIT 100`,
      [nutriId]
    );

    const rows = result.rows.map((r) => ({
      ...r,
      inviteUrl: `${frontendUrl}/convite-nutri/${r.token}`,
    }));

    res.json({ success: true, data: rows });
  } catch (err: any) {
    logger.error({ err }, '[nutri] list direct-invites error');
    res.status(500).json({ success: false, error: err.message || 'Failed to list invites' });
  }
});

router.delete('/direct-invites/:id', roleCheckMiddleware('nutri'), async (req: Request, res: Response) => {
  try {
    const nutriId = req.user!.id;
    const inviteId = Number(req.params.id);
    if (!Number.isFinite(inviteId)) {
      return res.status(400).json({ success: false, error: 'Invalid invite id' });
    }

    const result = await pool.query(
      `UPDATE nutri_direct_invites
       SET status = 'revoked'
       WHERE id = $1 AND nutri_id = $2 AND status = 'pending'
       RETURNING id`,
      [inviteId, nutriId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invite not found or already used/expired' });
    }

    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, '[nutri] revoke direct-invite error');
    res.status(500).json({ success: false, error: err.message || 'Failed to revoke invite' });
  }
});

// ===========================================================================
// Patients list (enriched with plan summary + adherence + riskFlag)
// ===========================================================================

router.get('/patients', async (req: Request, res: Response) => {
  try {
    const nutriId = req.user!.id;
    const data = await getPatientsWithSummary(nutriId);
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error({ err }, '[nutri] list patients error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===========================================================================
// Nutrition Plans — /patients/:patientId/nutrition-plans
// (profile consent already enforced at router level; nutrition consent here)
// ===========================================================================

router.post(
  '/patients/:patientId/nutrition-plans',
  requireActiveConsent('nutrition'),
  async (req: Request, res: Response) => {
    try {
      const nutriId    = req.user!.id;
      const patientId  = Number(req.params.patientId);
      const academyId  = (req.user as any).activeAcademyId ?? null;

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const { title, objective, general_notes, meals } = req.body;

      if (!title || typeof title !== 'string') {
        return res.status(400).json({ success: false, error: 'title is required' });
      }
      const validObjectives = ['weight_loss', 'muscle_gain', 'metabolic_health', 'performance', 'maintenance'];
      if (!validObjectives.includes(objective)) {
        return res.status(400).json({ success: false, error: 'Invalid objective' });
      }
      if (!Array.isArray(meals) || meals.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one meal is required' });
      }
      if (meals.length > 6) {
        return res.status(400).json({ success: false, error: 'Maximum 6 meals per plan' });
      }
      for (const m of meals) {
        if (!m.name || !m.orientation) {
          return res.status(400).json({ success: false, error: 'Each meal must have name and orientation' });
        }
      }

      const plan = await createPlan(nutriId, patientId, academyId, {
        title, objective, general_notes, meals,
      });
      res.status(201).json({ success: true, data: plan });
    } catch (err: any) {
      logger.error({ err }, '[nutri] create plan error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.get(
  '/patients/:patientId/nutrition-plans',
  requireActiveConsent('nutrition'),
  async (req: Request, res: Response) => {
    try {
      const nutriId   = req.user!.id;
      const patientId = Number(req.params.patientId);

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const [active, history] = await Promise.all([
        getActivePlan(nutriId, patientId),
        getPlanHistory(nutriId, patientId),
      ]);
      res.json({ success: true, data: { active, history } });
    } catch (err: any) {
      logger.error({ err }, '[nutri] get plans error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.patch(
  '/patients/:patientId/nutrition-plans/:planId',
  requireActiveConsent('nutrition'),
  async (req: Request, res: Response) => {
    try {
      const nutriId = req.user!.id;
      const planId  = Number(req.params.planId);

      if (!Number.isFinite(planId)) {
        return res.status(400).json({ success: false, error: 'Invalid planId' });
      }

      const { title, objective, general_notes, meals } = req.body;

      const validObjectives = ['weight_loss', 'muscle_gain', 'metabolic_health', 'performance', 'maintenance'];
      if (objective && !validObjectives.includes(objective)) {
        return res.status(400).json({ success: false, error: 'Invalid objective' });
      }

      if (meals !== undefined) {
        if (!Array.isArray(meals) || meals.length === 0 || meals.length > 6) {
          return res.status(400).json({ success: false, error: 'meals must be an array of 1–6 items' });
        }
        if (meals.some((m: any) => !m.name?.trim() || !m.orientation?.trim())) {
          return res.status(400).json({ success: false, error: 'Each meal requires name and orientation' });
        }
      }

      const plan = await updatePlan(nutriId, planId, { title, objective, general_notes, meals });
      if (!plan) {
        return res.status(404).json({ success: false, error: 'Active plan not found or not owned by this nutritionist' });
      }
      res.json({ success: true, data: plan });
    } catch (err: any) {
      logger.error({ err }, '[nutri] update plan error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.delete(
  '/patients/:patientId/nutrition-plans/:planId',
  requireActiveConsent('nutrition'),
  async (req: Request, res: Response) => {
    try {
      const nutriId = req.user!.id;
      const planId  = Number(req.params.planId);

      if (!Number.isFinite(planId)) {
        return res.status(400).json({ success: false, error: 'Invalid planId' });
      }

      const plan = await endPlan(nutriId, planId);
      if (!plan) {
        return res.status(404).json({ success: false, error: 'Plan not found or already ended' });
      }
      res.json({ success: true, data: plan });
    } catch (err: any) {
      logger.error({ err }, '[nutri] end plan error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ===========================================================================
// Adherence — /patients/:patientId/adherence  (requires daily_checkins consent)
// ===========================================================================

router.get(
  '/patients/:patientId/adherence',
  requireActiveConsent('daily_checkins'),
  async (req: Request, res: Response) => {
    try {
      const nutriId   = req.user!.id;
      const patientId = Number(req.params.patientId);
      const days      = Math.min(Number(req.query.days) || 7, 90);

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const plan = await getActivePlan(nutriId, patientId);
      if (!plan) {
        return res.json({ success: true, data: { plan: null, checkins: [] } });
      }

      const checkins = await getAdherenceForPeriod(patientId, plan.id, days);
      res.json({ success: true, data: { plan: { id: plan.id, title: plan.title }, checkins } });
    } catch (err: any) {
      logger.error({ err }, '[nutri] get adherence error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ===========================================================================
// Context — /patients/:patientId/context  (programmatic consent check per scope)
// ===========================================================================

router.get(
  '/patients/:patientId/context',
  async (req: Request, res: Response) => {
    try {
      const nutriId   = req.user!.id;
      const patientId = Number(req.params.patientId);

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const context = await getPatientContext(nutriId, patientId);
      res.json({ success: true, data: context });
    } catch (err: any) {
      logger.error({ err }, '[nutri] get context error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ===========================================================================
// Observations — /patients/:patientId/observations
// ===========================================================================

router.post(
  '/patients/:patientId/observations',
  async (req: Request, res: Response) => {
    try {
      const nutriId   = req.user!.id;
      const patientId = Number(req.params.patientId);

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!body || body.length < 2) {
        return res.status(400).json({ success: false, error: 'body is required' });
      }
      if (body.length > 5000) {
        return res.status(400).json({ success: false, error: 'body too long (max 5000 chars)' });
      }

      const obs = await createObservation(nutriId, patientId, body);
      res.status(201).json({ success: true, data: obs });
    } catch (err: any) {
      logger.error({ err }, '[nutri] create observation error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.get(
  '/patients/:patientId/observations',
  async (req: Request, res: Response) => {
    try {
      const nutriId   = req.user!.id;
      const patientId = Number(req.params.patientId);
      const limit     = Math.min(Number(req.query.limit)  || 10, 50);
      const offset    = Math.max(Number(req.query.offset) || 0,  0);

      if (!Number.isFinite(patientId)) {
        return res.status(400).json({ success: false, error: 'Invalid patientId' });
      }

      const result = await getObservations(nutriId, patientId, limit, offset);
      res.json({ success: true, data: result.rows, meta: { total: result.total, limit, offset } });
    } catch (err: any) {
      logger.error({ err }, '[nutri] list observations error');
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;
