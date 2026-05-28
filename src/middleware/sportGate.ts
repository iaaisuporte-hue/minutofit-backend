import { type Request, type Response, type NextFunction } from 'express';
import pool from '../config/database';

export async function requireSportActive(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM user_sport_profile WHERE user_id = $1 AND active = true LIMIT 1`,
    [req.user.id],
  );
  if (rows.length === 0) {
    res.status(403).json({ success: false, error: 'Sport profile not active', code: 'SPORT_NOT_ACTIVE' });
    return;
  }
  next();
}
