import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/jwt';

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.slice(7);

    const payload = verifyAccessToken(token);
    req.user = payload;

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired' });
    }

    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

export function roleCheckMiddleware(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }

    next();
  };
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  next();
}

export function blockAccessProfilesMiddleware(...blockedProfiles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (req.user.accessProfile && blockedProfiles.includes(req.user.accessProfile)) {
      return res.status(403).json({ success: false, error: 'Access restricted for this profile' });
    }

    next();
  };
}
