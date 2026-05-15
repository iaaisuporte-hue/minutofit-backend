import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import pool from '../config/database';
import logger from '../lib/logger';

const router = Router();

const INVITE_EXPIRY_DAYS = 14;

// All nutri routes require authentication + nutri product gate
router.use(authMiddleware, requireProduct('nutri'));

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
// Patients list
// ===========================================================================

router.get('/patients', async (req: Request, res: Response) => {
  try {
    const nutriId = req.user!.id;

    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.photo_url,
              npa.status, npa.started_at, npa.academy_id
       FROM nutri_patient_assignments npa
       JOIN users u ON u.id = npa.patient_id
       WHERE npa.nutri_id = $1 AND npa.status = 'active'
       ORDER BY u.name`,
      [nutriId]
    );

    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    logger.error({ err }, '[nutri] list patients error');
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
