import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { requireFeatureOrRoles } from '../middleware/featureGate';

const router = Router();

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

// GET /videos/search - Search videos with optional tags/accessibility filters
router.get('/search', authMiddleware, requireFeatureOrRoles('workouts', ['personal', 'admin']), async (req: Request, res: Response) => {
  try {
    const tags =
      typeof req.query.tags === 'string'
        ? req.query.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];

    const limitRaw = Number(req.query.limit || 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

    const visualSupport = parseBooleanFlag(req.query.visualSupport);
    const auditorySupport = parseBooleanFlag(req.query.auditorySupport);
    const motorSupport = parseBooleanFlag(req.query.motorSupport);

    const whereClauses: string[] = [];
    const params: any[] = [];

    if (tags.length > 0) {
      params.push(tags);
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM video_tags vt2
          INNER JOIN tags t2 ON t2.id = vt2.tag_id
          WHERE vt2.video_id = v.id
            AND t2.slug = ANY($${params.length}::text[])
        )
      `);
    }

    if (visualSupport !== null) {
      params.push(visualSupport);
      whereClauses.push(`v.has_audio_description = $${params.length}`);
    }

    if (auditorySupport !== null) {
      params.push(auditorySupport);
      whereClauses.push(`(v.has_subtitles OR v.has_libras) = $${params.length}`);
    }

    if (motorSupport !== null) {
      params.push(motorSupport);
      whereClauses.push(`v.low_impact_friendly = $${params.length}`);
    }

    params.push(limit);

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT
        v.id,
        v.title,
        v.description,
        v.url,
        v.thumbnail_url,
        v.duration_seconds,
        v.has_subtitles,
        v.has_libras,
        v.has_audio_description,
        v.low_impact_friendly,
        v.accessibility_notes,
        v.created_at,
        COALESCE(array_remove(array_agg(t.slug), NULL), '{}') AS tags
      FROM videos v
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      LEFT JOIN tags t ON t.id = vt.tag_id
      ${whereSql}
      GROUP BY v.id
      ORDER BY v.created_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to search videos',
    });
  }
});

export default router;
