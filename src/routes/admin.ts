import { Router, Request, Response } from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import pool from '../config/database';
import * as subscriptionService from '../services/subscriptionService';

const router = Router();

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
      query += ` AND (u.email ILIKE $${params.length + 1} OR u.name ILIKE $${params.length + 1})`;
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
      countQuery += ` AND (email ILIKE $${countParams.length + 1} OR name ILIKE $${countParams.length + 1})`;
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

export default router;
