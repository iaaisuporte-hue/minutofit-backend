import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import pool from '../config/database';
import * as subscriptionService from '../services/subscriptionService';
import { ensureAcademyRoles } from '../db/academyRoles';
import { assignOwner } from '../services/academyTeamService';
import { auditLog } from '../utils/auditLog';
import {
  getUserProducts,
  PRODUCT_KEYS,
  type ProductKey,
} from '../db/ensureProductsSchema';
import { findOrCreateUserFromContext } from '../services/userIdentityService';
import { cancelMembership, expireOverdueGraces, grantMembership } from '../services/membershipService';
import { logAcademyAction } from '../services/auditService';
import {
  createPlatformProtocol,
  deletePlatformProtocol,
  listPlatformProtocols,
  updatePlatformProtocol,
} from '../services/workoutProtocolService';
import { assertStrongPassword } from '../utils/passwordPolicy';
import { reviewNetworkProfile, type CredentialStatus, type PublicationStatus } from '../services/professionalNetworkService';

const router = Router();


// PATCH /admin/professionals/:professionalId/network-review - Valida perfil na Rede de Profissionais
router.patch('/professionals/:professionalId/network-review', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  const { credentialStatus, publicationStatus, adminEnabled, reviewNotes } = req.body as {
    credentialStatus?: CredentialStatus;
    publicationStatus?: PublicationStatus;
    adminEnabled?: boolean;
    reviewNotes?: string;
  };

  if (!credentialStatus || !['pending_review', 'approved', 'rejected'].includes(credentialStatus)) {
    return res.status(400).json({ success: false, error: 'credentialStatus inválido.' });
  }
  if (!publicationStatus || !['draft', 'pending_review', 'approved', 'disabled'].includes(publicationStatus)) {
    return res.status(400).json({ success: false, error: 'publicationStatus inválido.' });
  }

  try {
    const profile = await reviewNetworkProfile({
      professionalId: parseInt(req.params.professionalId, 10),
      reviewerId: req.user!.id,
      credentialStatus,
      publicationStatus,
      adminEnabled: Boolean(adminEnabled),
      reviewNotes,
      ip: req.ip,
    });
    return res.json({ success: true, data: profile });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

// GET /admin/dashboard/metrics - Get dashboard metrics
router.get('/dashboard/metrics', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    // Get total active users
    const usersRes = await pool.query(
      `SELECT COUNT(DISTINCT id) as total FROM users`
    );
    const totalUsers = usersRes.rows[0].total;

    // Get active subscriptions
    const activeSubRes = await pool.query(
      `SELECT COUNT(DISTINCT user_id) as count FROM user_subscriptions WHERE status = 'active'`
    );
    const activeSubscriptions = activeSubRes.rows[0].count;

    // Get MRR (Monthly Recurring Revenue)
    const mrrRes = await pool.query(
      `SELECT SUM(st.price_brl) as total FROM user_subscriptions us
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.status = 'active'`
    );
    const mrr = mrrRes.rows[0].total || 0;

    // Get total payments (revenue)
    const revenueRes = await pool.query(
      `SELECT SUM(amount_brl) as total FROM payments WHERE status = 'approved'`
    );
    const revenue = revenueRes.rows[0].total || 0;

    // Get tier breakdown
    const tierRes = await pool.query(
      `SELECT st.name, COUNT(us.id) as count
       FROM user_subscriptions us
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.status = 'active'
       GROUP BY st.name`
    );

    res.json({
      success: true,
      data: {
        metrics: {
          totalUsers,
          activeSubscriptions,
          mrr: parseFloat(mrr),
          totalRevenue: parseFloat(revenue),
          tierBreakdown: tierRes.rows
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/users - List all users with pagination and filters
router.get('/users', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { limit = 20, offset = 0, role, search } = req.query;

    let query = `SELECT u.id, u.email, u.name, u.role, u.profile_completed, u.created_at, st.name as subscription_tier
                 FROM users u
                 LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
                 LEFT JOIN subscription_tiers st ON us.tier_id = st.id
                 WHERE 1=1`;

    const params: any[] = [];

    if (role) {
      query += ` AND u.role = $${params.length + 1}`;
      params.push(role);
    }

    if (search) {
      query += ` AND (u.email ILIKE $${params.length + 1} OR u.name ILIKE $${params.length + 2})`;
      params.push(`%${search}%`);
      params.push(`%${search}%`);
    }

    query += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string) || 20);
    params.push(parseInt(offset as string) || 0);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM users WHERE 1=1`;
    const countParams: any[] = [];

    if (role) {
      countQuery += ` AND role = $${countParams.length + 1}`;
      countParams.push(role);
    }

    if (search) {
      countQuery += ` AND (email ILIKE $${countParams.length + 1} OR name ILIKE $${countParams.length + 2})`;
      countParams.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      success: true,
      data: {
        users: result.rows,
        pagination: {
          total: countResult.rows[0].total,
          limit: parseInt(limit as string) || 20,
          offset: parseInt(offset as string) || 0
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/subscriptions/report - Get subscription analytics
router.get('/subscriptions/report', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    // Active subscriptions by tier
    const activeByTier = await pool.query(
      `SELECT st.name, COUNT(us.id) as count, SUM(st.price_brl) as monthly_revenue
       FROM user_subscriptions us
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.status = 'active'
       GROUP BY st.name`
    );

    // Recent subscriptions (last 30 days)
    const recentSubs = await pool.query(
      `SELECT u.email, u.name, st.name as tier, us.status, us.active_from, us.active_to
       FROM user_subscriptions us
       JOIN users u ON us.user_id = u.id
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY us.created_at DESC
       LIMIT 100`
    );

    // Churn rate (cancelled in last 30 days)
    const churnRes = await pool.query(
      `SELECT COUNT(*) as churned_count FROM user_subscriptions
       WHERE status = 'cancelled' AND active_to >= NOW() - INTERVAL '30 days'`
    );

    res.json({
      success: true,
      data: {
        activeByTier: activeByTier.rows,
        recentSubscriptions: recentSubs.rows,
        churnLastMonth: churnRes.rows[0].churned_count
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/users/:id - Single user with subscription tier
router.get('/users/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.profile_completed, u.created_at, st.name as subscription_tier
       FROM users u
       LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
       LEFT JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE u.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      data: { user: result.rows[0] }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /admin/users/:id - Update user
router.patch('/users/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, name, email } = req.body;

    const updates: string[] = [];
    const params: any[] = [];

    if (role) {
      updates.push(`role = $${params.length + 1}`);
      params.push(role);
    }

    if (name) {
      updates.push(`name = $${params.length + 1}`);
      params.push(name);
    }

    if (email) {
      updates.push(`email = $${params.length + 1}`);
      params.push(email.toLowerCase());
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
                   RETURNING id, email, name, role, profile_completed`;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      data: { user: result.rows[0] }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /admin/users/:id/subscription - Manually adjust user subscription
router.post('/users/:id/subscription', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tierId } = req.body;

    if (!tierId) {
      return res.status(400).json({ success: false, error: 'tierId is required' });
    }

    // Get active subscription
    const subRes = await pool.query(
      `SELECT id FROM user_subscriptions WHERE user_id = $1 AND status = 'active'`,
      [id]
    );

    let subscriptionId;

    if (subRes.rows.length > 0) {
      subscriptionId = subRes.rows[0].id;
      // Update existing
      await subscriptionService.updateUserSubscription(subscriptionId, tierId);
    } else {
      // Create new
      const newSub = await subscriptionService.createUserSubscription(parseInt(id), tierId);
      subscriptionId = newSub.id;
    }

    const updated = await pool.query(
      `SELECT us.id, st.name, st.price_brl, us.status, us.active_from
       FROM user_subscriptions us
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.id = $1`,
      [subscriptionId]
    );

    res.json({
      success: true,
      data: { subscription: updated.rows[0] }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/videos/analytics - Video analytics
router.get('/videos/analytics', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    // Top videos (by basic count for now)
    const topVideos = await pool.query(
      `SELECT v.id, v.title, u.name as personal_trainer, v.created_at
       FROM videos v
       JOIN users u ON v.personal_id = u.id
       ORDER BY v.created_at DESC
       LIMIT 20`
    );

    // Videos by personal trainer
    const byTrainer = await pool.query(
      `SELECT u.id, u.name, COUNT(v.id) as video_count
       FROM users u
       LEFT JOIN videos v ON u.id = v.personal_id
       WHERE u.role = 'personal'
       GROUP BY u.id, u.name
       ORDER BY video_count DESC`
    );

    res.json({
      success: true,
      data: {
        topVideos: topVideos.rows,
        trainerStats: byTrainer.rows
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/dashboard/platform-health - Aggregated metabolic signals of the platform base
router.get('/dashboard/platform-health', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    // Distribution of latest metabolic snapshots per user
    const metabolismRes = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (user_id)
          user_id,
          score,
          band
        FROM user_metabolism_snapshots
        ORDER BY user_id, created_at DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE band = 'low') AS low,
        COUNT(*) FILTER (WHERE band = 'moderate') AS moderate,
        COUNT(*) FILTER (WHERE band = 'high') AS high,
        COUNT(*) FILTER (WHERE band IS NULL OR band NOT IN ('low','moderate','high')) AS unknown
      FROM latest
    `);

    // Average adherence over last 7 days (checkins / active users)
    const adherenceRes = await pool.query(`
      SELECT
        COUNT(DISTINCT user_id)::float /
        NULLIF(
          (SELECT COUNT(id) FROM users WHERE role = 'user'),
          0
        ) * 100 AS adherence_pct
      FROM user_daily_checkins
      WHERE checked_in_at >= NOW() - INTERVAL '7 days'
    `);

    // Active users in last 7d (had checkin OR workout log)
    const activeRes = await pool.query(`
      SELECT COUNT(DISTINCT user_id) AS count
      FROM (
        SELECT user_id FROM user_daily_checkins WHERE checked_in_at >= NOW() - INTERVAL '7 days'
        UNION
        SELECT user_id FROM user_workout_logs WHERE completed_at >= NOW() - INTERVAL '7 days'
      ) t
    `);

    // Users with NO checkin in last 7 days (potential churn signal)
    const noCheckinRes = await pool.query(`
      SELECT COUNT(id) AS count
      FROM users
      WHERE role = 'user'
        AND id NOT IN (
          SELECT DISTINCT user_id FROM user_daily_checkins
          WHERE checked_in_at >= NOW() - INTERVAL '7 days'
        )
    `);

    // Personals whose assigned students have avg metabolism below 40 (fatigue cluster signal)
    const fatigueClustersRes = await pool.query(`
      WITH student_scores AS (
        SELECT DISTINCT ON (s.user_id)
          psa.personal_id,
          s.score
        FROM user_metabolism_snapshots s
        JOIN personal_student_assignments psa ON s.user_id = psa.student_id AND psa.status = 'active'
        ORDER BY s.user_id, s.created_at DESC
      )
      SELECT COUNT(DISTINCT personal_id) AS count
      FROM student_scores
      GROUP BY personal_id
      HAVING AVG(score) < 45
    `);

    // Average metabolic score from the most recent snapshot per user (last 30 days)
    const avgScoreRes = await pool.query(`
      SELECT ROUND(AVG(score)::numeric, 1) AS avg_score
      FROM (
        SELECT DISTINCT ON (user_id) score
        FROM user_metabolism_snapshots
        WHERE created_at >= NOW() - INTERVAL '30 days'
        ORDER BY user_id, created_at DESC
      ) t
      WHERE score IS NOT NULL
    `);

    const dist = metabolismRes.rows[0] || { low: 0, moderate: 0, high: 0, unknown: 0 };
    const rawAvg = avgScoreRes.rows[0]?.avg_score;

    res.json({
      success: true,
      data: {
        metabolismDistribution: {
          low: Number(dist.low),
          moderate: Number(dist.moderate),
          high: Number(dist.high),
          unknown: Number(dist.unknown),
        },
        averageScore: rawAvg !== null && rawAvg !== undefined ? Number(rawAvg) : null,
        adherenceAvg7d: adherenceRes.rows[0]?.adherence_pct
          ? Math.round(Number(adherenceRes.rows[0].adherence_pct))
          : null,
        activeUsers7d: Number(activeRes.rows[0]?.count ?? 0),
        usersWithoutCheckin7d: Number(noCheckinRes.rows[0]?.count ?? 0),
        personalsWithFatigueClusters: Number(fatigueClustersRes.rows[0]?.count ?? 0),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /admin/professionals - Create a professional user (personal or nutri)
router.post('/professionals', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, email, role, phone, cpf, registry, specialty, bio } = req.body;

    if (!name || !email || !role) {
      return res.status(400).json({ success: false, error: 'name, email e role sao obrigatorios.' });
    }

    if (!['personal', 'nutri'].includes(role)) {
      return res.status(400).json({ success: false, error: 'role deve ser personal ou nutri.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const crypto = await import('crypto');
    const tempPassword = crypto.randomBytes(6).toString('hex');

    // Roteia via serviço de identidade — dedup obrigatório (AGENTS.md).
    const identity = await findOrCreateUserFromContext({
      email: normalizedEmail,
      name: String(name).trim(),
      cpf: cpf ? String(cpf).trim() : null,
      phone: phone ? String(phone).trim() : null,
      password: tempPassword,
      skipPasswordPolicy: true,
    });

    if (!identity.isNew) {
      return res.status(409).json({ success: false, error: 'E-mail já cadastrado na plataforma.' });
    }

    const userId = identity.user.id;

    // Promove ao papel profissional, persiste campos opcionais e ativa
    // troca de senha obrigatória no primeiro acesso.
    await pool.query(
      `UPDATE users
          SET role                = $2,
              profile_completed   = TRUE,
              must_change_password = TRUE,
              registry_code       = NULLIF(TRIM($3), ''),
              specialty           = NULLIF(TRIM($4), ''),
              bio                 = NULLIF(TRIM($5), ''),
              updated_at          = NOW()
        WHERE id = $1`,
      [
        userId,
        role,
        registry  ? String(registry).trim()  : '',
        specialty ? String(specialty).trim() : '',
        bio       ? String(bio).trim()       : '',
      ]
    );

    // Concede o produto profissional correspondente via serviço centralizado.
    const adminUserId = (req as any).user?.id ?? null;
    await grantMembership(userId, role as 'personal' | 'nutri', {
      source: 'metacore',
      grantedByUserId: adminUserId,
    });

    res.status(201).json({
      success: true,
      data: {
        id: userId,
        name: identity.user.name,
        email: identity.user.email,
        role,
        tempPassword,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Academias (MetaCore Admin) ──────────────────────────────────────────────

// GET /admin/academies — lista todas as academias
router.get('/academies', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id, a.slug, a.legal_name, a.display_name, a.status, a.created_at,
         COUNT(DISTINCT au.user_id) FILTER (WHERE au.is_active = TRUE) AS member_count,
         ab.logo_url,
         ab.primary_color
       FROM academies a
       LEFT JOIN academy_users  au ON au.academy_id = a.id
       LEFT JOIN academy_branding ab ON ab.academy_id = a.id
       GROUP BY a.id, ab.logo_url, ab.primary_color
       ORDER BY a.created_at DESC`
    );
    res.json({ success: true, data: { academies: result.rows } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /admin/academies — cria nova academia (com roles e dono opcional)
router.post('/academies', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { slug, legalName, displayName, primaryColor, owner } = req.body;

    if (!slug || !legalName || !displayName) {
      return res.status(400).json({ success: false, error: 'slug, legalName e displayName são obrigatórios.' });
    }

    const slugNorm = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // BE-1.7.7: validate reserved slugs
    const { validateReservedSlug } = await import('../middleware/tenantResolver');
    const slugErr = validateReservedSlug(slugNorm);
    if (slugErr) return res.status(400).json({ success: false, error: slugErr });

    // Validate primary color if provided
    if (primaryColor) {
      const { validateBrandingColor } = await import('../utils/contrastValidator');
      const colorErr = validateBrandingColor(primaryColor, 'Cor primária', 4.5);
      if (colorErr) return res.status(400).json({ success: false, error: colorErr });
    }

    const result = await pool.query(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, slug, legal_name, display_name, status, created_at`,
      [slugNorm, String(legalName).trim(), String(displayName).trim()]
    );

    const academy = result.rows[0];
    const academyId: number = academy.id;

    // Always create system roles for the new academy
    await ensureAcademyRoles(pool, academyId);

    // Create initial branding row with primary color (and derived tokens if provided)
    if (primaryColor) {
      const { calcPrimaryHover, calcPrimarySoft, calcCtaTextColor } = await import('../utils/colorContrast');
      await pool.query(
        `INSERT INTO academy_branding (academy_id, primary_color, primary_hover, primary_soft, cta_text_color)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (academy_id) DO UPDATE
           SET primary_color   = EXCLUDED.primary_color,
               primary_hover   = EXCLUDED.primary_hover,
               primary_soft    = EXCLUDED.primary_soft,
               cta_text_color  = EXCLUDED.cta_text_color,
               updated_at      = NOW()`,
        [academyId, primaryColor, calcPrimaryHover(primaryColor), calcPrimarySoft(primaryColor), calcCtaTextColor(primaryColor)]
      );
    }

    await auditLog(pool, {
      academyId,
      userId: req.user!.id,
      action: 'academy.created',
      entityType: 'academy',
      entityId: academyId,
    });

    let ownerResult: { ownerId: number; ownerName: string; ownerEmail: string; tempPassword?: string } | null = null;

    if (owner && owner.mode) {
      ownerResult = await assignOwner(academyId, req.user!.id, owner);
    }

    res.status(201).json({
      success: true,
      data: {
        academy,
        owner: ownerResult
          ? {
              id: ownerResult.ownerId,
              name: ownerResult.ownerName,
              email: ownerResult.ownerEmail,
              tempPassword: ownerResult.tempPassword,
            }
          : null,
      },
    });
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.includes('unique') || (error as any)?.code === '23505') {
      return res.status(409).json({ success: false, error: 'Slug já utilizado por outra academia.' });
    }
    res.status(500).json({ success: false, error: msg });
  }
});

// PATCH /admin/academies/:id/branding — atualiza branding de qualquer academia (admin)
router.patch('/academies/:id/branding', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const academyId = Number(req.params.id);
    if (!academyId) return res.status(400).json({ success: false, error: 'academyId inválido.' });

    const { primaryColor } = req.body;
    if (!primaryColor) return res.status(400).json({ success: false, error: 'primaryColor é obrigatório.' });

    const { validateBrandingColor } = await import('../utils/contrastValidator');
    const colorErr = validateBrandingColor(primaryColor, 'Cor primária', 4.5);
    if (colorErr) return res.status(400).json({ success: false, error: colorErr });

    const { calcPrimaryHover, calcPrimarySoft, calcCtaTextColor } = await import('../utils/colorContrast');
    await pool.query(
      `INSERT INTO academy_branding (academy_id, primary_color, primary_hover, primary_soft, cta_text_color)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (academy_id) DO UPDATE
         SET primary_color  = EXCLUDED.primary_color,
             primary_hover  = EXCLUDED.primary_hover,
             primary_soft   = EXCLUDED.primary_soft,
             cta_text_color = EXCLUDED.cta_text_color,
             updated_at     = NOW()`,
      [academyId, primaryColor, calcPrimaryHover(primaryColor), calcPrimarySoft(primaryColor), calcCtaTextColor(primaryColor)]
    );

    const { invalidateTenantCache } = await import('../middleware/tenantResolver');
    const slugRes = await pool.query(`SELECT slug FROM academies WHERE id = $1 LIMIT 1`, [academyId]);
    if (slugRes.rows.length > 0) invalidateTenantCache(slugRes.rows[0].slug);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/academies/:id/assign-owner — atribui/troca dono de academia já criada
router.post('/academies/:id/assign-owner', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const academyId = Number(req.params.id);
    if (!academyId) return res.status(400).json({ success: false, error: 'academyId inválido.' });

    const ownerResult = await assignOwner(academyId, req.user!.id, req.body);
    res.json({
      success: true,
      data: {
        id: ownerResult.ownerId,
        name: ownerResult.ownerName,
        email: ownerResult.ownerEmail,
        tempPassword: ownerResult.tempPassword,
      },
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /admin/users/search — busca usuários por email/CPF/nome (para seletor de dono)
router.get('/users/search', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: { users: [] } });

    const pattern = `%${q}%`;
    const result = await pool.query(
      `SELECT id, name, email, role FROM users
       WHERE email ILIKE $1 OR name ILIKE $1 OR cpf LIKE $1
       LIMIT 10`,
      [pattern]
    );
    res.json({ success: true, data: { users: result.rows } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /admin/academies/:id — detalhes de uma academia (owner + equipe)
router.get('/academies/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const academyId = Number(req.params.id);
    if (!academyId) return res.status(400).json({ success: false, error: 'academyId inválido.' });

    const [acResult, teamResult, brandingResult] = await Promise.all([
      pool.query(
        `SELECT
           a.id, a.slug, a.legal_name, a.display_name, a.status, a.created_at, a.owner_user_id,
           u.name  AS owner_name,
           u.email AS owner_email,
           u.phone AS owner_phone
         FROM academies a
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.id = $1`,
        [academyId]
      ),
      pool.query(
        `SELECT
           u.id AS user_id, u.name, u.email, u.phone,
           ar.slug AS role_slug, ar.label AS role_label,
           au.is_active, au.status, au.joined_at
         FROM academy_users au
         JOIN users         u  ON u.id  = au.user_id
         JOIN academy_roles ar ON ar.id = au.role_id
         WHERE au.academy_id = $1
         ORDER BY ar.slug, u.name`,
        [academyId]
      ),
      pool.query(
        `SELECT logo_url, display_name, primary_color, accent_color FROM academy_branding WHERE academy_id = $1`,
        [academyId]
      ),
    ]);

    if (acResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Academia não encontrada.' });
    }

    res.json({
      success: true,
      data: {
        academy: acResult.rows[0],
        team: teamResult.rows,
        branding: brandingResult.rows[0] ?? null,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /admin/users/:id/reset-password — gera nova senha temporária para qualquer usuário
router.post('/users/:id/reset-password', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) return res.status(400).json({ success: false, error: 'userId inválido.' });

    const userCheck = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }

    const crypto = await import('crypto');
    const bcrypt = await import('bcryptjs');
    const tempPassword = crypto.randomBytes(6).toString('hex');
    const hash = await bcrypt.hash(tempPassword, 12);

    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);

    res.json({
      success: true,
      data: {
        userId,
        name:  userCheck.rows[0].name,
        email: userCheck.rows[0].email,
        tempPassword,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /admin/users/:id/set-password — admin define a senha do usuário (sem gerar aleatório)
router.post('/users/:id/set-password', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ success: false, error: 'userId inválido.' });
    }

    const userCheck = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }

    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Campo password obrigatório.' });
    }

    try {
      assertStrongPassword(password);
    } catch (policyErr: unknown) {
      const msg = policyErr instanceof Error ? policyErr.message : 'Senha inválida.';
      return res.status(400).json({ success: false, error: msg });
    }

    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(password, 12);

    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);

    logAcademyAction({
      academyId: null,
      userId: (req.user as { id: number }).id,
      action: 'admin.password_set',
      entityType: 'user',
      entityId: userId,
      meta: { adminId: (req.user as { id: number }).id, targetUserId: userId },
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      data: {
        userId,
        name: userCheck.rows[0].name,
        email: userCheck.rows[0].email,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /admin/academies/:id/status — ativa / suspende / cancela academia
router.patch('/academies/:id/status', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const academyId = Number(req.params.id);
    const { status } = req.body;
    const allowed = ['active', 'suspended', 'cancelled', 'trial'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: `Status inválido. Permitidos: ${allowed.join(', ')}.` });
    }

    const result = await pool.query(
      `UPDATE academies SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, slug, display_name, status`,
      [status, academyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Academia não encontrada.' });
    }

    res.json({ success: true, data: { academy: result.rows[0] } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Product management (MetaCore admin only)
// ──────────────────────────────────────────────────────────────────────────────

// GET /admin/users/:userId/products — list user's active products
router.get('/users/:userId/products', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });

    const activeKeys = await getUserProducts(userId);

    const result = await pool.query(
      `SELECT up.id, up.product_key, up.status, up.source, up.source_academy_id,
              up.granted_by_user_id, up.granted_at, up.expires_at, up.revoked_at,
              up.notes, up.grace_until, up.converted_from_source,
              u.name AS granted_by_name,
              a.display_name AS source_academy_name
       FROM user_product_memberships up
       LEFT JOIN users u ON u.id = up.granted_by_user_id
       LEFT JOIN academies a ON a.id = up.source_academy_id
       WHERE up.user_id = $1
       ORDER BY up.granted_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        activeKeys,
        allProducts: PRODUCT_KEYS.map((key) => ({
          key,
          active: activeKeys.includes(key),
        })),
        history: result.rows,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/users/:userId/products/grant — grant product to user
router.post('/users/:userId/products/grant', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });

    const { productKey, expiresAt, notes } = req.body;
    if (!PRODUCT_KEYS.includes(productKey as ProductKey)) {
      return res.status(400).json({ success: false, error: `Invalid productKey. Valid: ${PRODUCT_KEYS.join(', ')}` });
    }

    await grantMembership(userId, productKey as ProductKey, {
      source: 'metacore',
      grantedByUserId: req.user!.id,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      notes: notes ?? null,
      metadata: { channel: 'admin_grant' },
    });

    logAcademyAction({
      academyId: null,
      userId: req.user!.id,
      action: 'product.grant',
      entityType: 'user',
      entityId: userId,
      meta: { productKey, expiresAt: expiresAt ?? null },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/users/:userId/products/revoke — revoke product from user
router.post('/users/:userId/products/revoke', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });

    const { productKey } = req.body;
    if (!PRODUCT_KEYS.includes(productKey as ProductKey)) {
      return res.status(400).json({ success: false, error: `Invalid productKey. Valid: ${PRODUCT_KEYS.join(', ')}` });
    }

    const revoked = await cancelMembership(userId, productKey as ProductKey, {
      revokedByUserId: req.user!.id,
      reason: 'revoked_by_admin',
    });

    if (!revoked) {
      return res.status(404).json({ success: false, error: 'Produto não está ativo para este usuário.' });
    }

    logAcademyAction({
      academyId: null,
      userId: req.user!.id,
      action: 'product.revoke',
      entityType: 'user',
      entityId: userId,
      meta: { productKey },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/memberships/expire-graces — varre e expira graças vencidas.
// Operação manual até o cron real entrar no ar (Fase 2 do roadmap multi-product).
// Idempotente: rows com `source = 'grace_period'` e `grace_until < NOW()` viram `expired`.
router.post('/memberships/expire-graces', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const expired = await expireOverdueGraces();
    logAcademyAction({
      academyId: null,
      userId: req.user!.id,
      action: 'membership.expire_graces',
      entityType: 'membership',
      entityId: null,
      meta: { expired },
      ipAddress: req.ip,
    });
    res.json({ success: true, data: { expired } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/workout-protocols/platform', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const limitRaw = Number(req.query.limit);
    const rows = await listPlatformProtocols(Number.isFinite(limitRaw) ? limitRaw : 100);
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/workout-protocols/platform', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title : '';
    const description = body.description;
    const tags = body.tags;
    const weekPreset = typeof body.weekPreset === 'string' ? body.weekPreset : String(body.weekPreset ?? '5');
    const selectedGroup =
      body.selectedGroup === null || body.selectedGroup === undefined
        ? null
        : String(body.selectedGroup);
    const items = Array.isArray(body.items) ? body.items : [];
    const row = await createPlatformProtocol({
      title,
      description,
      tags,
      weekPreset,
      selectedGroup,
      items,
    });
    res.status(201).json({ success: true, data: row });
  } catch (err: any) {
    if (err?.message?.includes('required') || err?.message?.includes('At least')) {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch(
  '/workout-protocols/platform/:protocolId',
  authMiddleware,
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const protocolId = Number(req.params.protocolId);
      if (!Number.isFinite(protocolId)) {
        return res.status(400).json({ success: false, error: 'Invalid protocol id' });
      }
      const body = req.body || {};
      const row = await updatePlatformProtocol(protocolId, {
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
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'Protocol not found' });
      }
      if (err?.message?.includes('required')) {
        return res.status(400).json({ success: false, error: err.message });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/**
 * DELETE /admin/users/:id
 *
 * Hard-deletes a user. The row is physically removed from the users table.
 *
 * "Physical" content tables (personal_workout_plans, student_exercise_notes,
 * workout_reviews) have ON DELETE SET NULL FKs (see migration
 * 1790200000000_relax-physical-content-fks.js), so the artifacts survive the
 * deletion as orphan rows for historical reference.
 *
 * All other user-related tables either have ON DELETE CASCADE (gamification,
 * checkins, logs, chat, memberships, etc.) or are explicitly cleaned up below.
 *
 * Guards: cannot delete self, cannot delete another admin.
 */
router.delete('/users/:id', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }
    if (targetId === req.user!.id) {
      return res.status(400).json({ success: false, error: 'Não é possível excluir a própria conta.' });
    }

    const userRes = await pool.query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [targetId]);
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }
    const target = userRes.rows[0];
    if (target.role === 'admin') {
      return res.status(403).json({ success: false, error: 'Não é possível excluir outro admin.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Tables without CASCADE that reference the user — clean up explicitly.
      await client.query(`DELETE FROM personal_direct_invites       WHERE accepted_user_id = $1`, [targetId]);

      // Hard delete the user. Physical content tables (personal_workout_plans,
      // student_exercise_notes, workout_reviews) have ON DELETE SET NULL — they
      // survive as orphans. Everything else CASCADEs away.
      await client.query(`DELETE FROM users WHERE id = $1`, [targetId]);

      await client.query('COMMIT');
      return res.json({ success: true, data: { deleted: true, userId: targetId } });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete(
  '/workout-protocols/platform/:protocolId',
  authMiddleware,
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const protocolId = Number(req.params.protocolId);
      if (!Number.isFinite(protocolId)) {
        return res.status(400).json({ success: false, error: 'Invalid protocol id' });
      }
      const ok = await deletePlatformProtocol(protocolId);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Protocol not found' });
      }
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// Workout plans (admin troubleshoot)
// Permite ao admin listar/excluir fichas (personal_workout_plans) — usado para
// limpar fichas órfãs depois que o protocolo de origem foi removido da biblioteca
// antes do fix de cascata atômica entrar em produção.
// ──────────────────────────────────────────────────────────────────────────

router.get(
  '/users/:userId/workout-plans',
  authMiddleware,
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user id' });
      }
      const result = await pool.query(
        `SELECT p.id, p.title, p.personal_id, p.student_id, p.source_protocol_id,
                p.created_at, p.updated_at,
                pu.email AS personal_email, pu.name AS personal_name,
                su.email AS student_email, su.name AS student_name
         FROM personal_workout_plans p
         LEFT JOIN users pu ON pu.id = p.personal_id
         LEFT JOIN users su ON su.id = p.student_id
         WHERE p.student_id = $1 OR p.personal_id = $1
         ORDER BY p.created_at DESC`,
        [userId]
      );
      return res.json({
        success: true,
        data: result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          personalId: r.personal_id,
          personalEmail: r.personal_email,
          personalName: r.personal_name,
          studentId: r.student_id,
          studentEmail: r.student_email,
          studentName: r.student_name,
          sourceProtocolId: r.source_protocol_id,
          isOrphan: r.source_protocol_id === null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.delete(
  '/workout-plans/:planId',
  authMiddleware,
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const planId = Number(req.params.planId);
      if (!Number.isFinite(planId)) {
        return res.status(400).json({ success: false, error: 'Invalid plan id' });
      }
      const result = await pool.query(
        `DELETE FROM personal_workout_plans WHERE id = $1 RETURNING id, title, student_id`,
        [planId]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ success: false, error: 'Plan not found' });
      }
      return res.json({ success: true, data: { deleted: true, plan: result.rows[0] } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/** Bulk cleanup: deleta todas as fichas órfãs (source_protocol_id IS NULL)
 *  criadas há mais de 1 hora (margem de segurança contra deletes recém-criados). */
router.post(
  '/workout-plans/cleanup-orphans',
  authMiddleware,
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `DELETE FROM personal_workout_plans
         WHERE source_protocol_id IS NULL
           AND created_at < NOW() - INTERVAL '1 hour'
         RETURNING id, title, student_id, personal_id`
      );
      return res.json({
        success: true,
        data: {
          deletedCount: result.rowCount,
          plans: result.rows,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;
