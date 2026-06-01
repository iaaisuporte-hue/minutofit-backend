import { NextFunction, Request, Response } from 'express';
import { getClearanceForUser } from '../services/physicalActivityClearanceService';

/**
 * Blocks physical-activity writes for users (role='user') that have not
 * signed a valid, non-expired PAR-Q+.
 *
 * Professionals (personal, nutri, admin) are always passed through —
 * clearance is a student-only concept.
 *
 * Error 403 { code: 'PARQ_CLEARANCE_REQUIRED', reason, expiresAt }
 * Precedence: place this AFTER requireFeature/requireProduct so plan errors surface first.
 */
export function requirePhysicalActivityClearance() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (req.user.role !== 'user') {
      return next();
    }

    const clearance = await getClearanceForUser(req.user.id);

    if (!clearance.valid) {
      return res.status(403).json({
        success: false,
        code: 'PARQ_CLEARANCE_REQUIRED',
        reason: clearance.reason,
        expiresAt: clearance.expiresAt,
      });
    }

    return next();
  };
}
