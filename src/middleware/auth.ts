import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/jwt';
import pool from '../config/database';
import { STUDENT_BILLING_ENABLED } from '../config/features';

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

// Permissões por sub-role de admin.
// super_admin: tudo.
// support: leitura + ações reversíveis (reset/grant/reconcile) — sem delete, sem set-password direta, sem alterar plano.
const ADMIN_PERMISSION_MATRIX: Record<string, string[]> = {
  super_admin: [
    'admin.dashboard', 'admin.users', 'admin.users.detail', 'admin.users.write',
    'admin.users.delete', 'admin.users.set-password',
    'admin.personals', 'admin.personals.detail',
    'admin.nutris', 'admin.nutris.detail',
    'admin.professionals.create', 'admin.professionals.review',
    'admin.finance', 'admin.billing.reconcile',
    'admin.accessProfiles', 'admin.academies', 'admin.academies.write',
    'admin.audit',
  ],
  support: [
    'admin.dashboard', 'admin.users', 'admin.users.detail',
    'admin.personals', 'admin.personals.detail',
    'admin.nutris', 'admin.nutris.detail',
    'admin.finance',
    'admin.billing.reconcile',
    'admin.audit',
  ],
};

export type AdminSubRole = 'super_admin' | 'support';

declare module 'express-serve-static-core' {
  interface Request {
    adminSubRole?: AdminSubRole;
  }
}

export async function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  // Verify is_corefit_admin flag and read sub_role for permission granularity
  try {
    const result = await pool.query(
      'SELECT is_corefit_admin, admin_sub_role FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0 || !result.rows[0].is_corefit_admin) {
      return res.status(403).json({ success: false, error: 'S2Core admin access required' });
    }
    // Attach sub_role to request for downstream permission checks
    const sub = result.rows[0].admin_sub_role as string | null;
    req.adminSubRole = (sub === 'support' ? 'support' : 'super_admin') as AdminSubRole;
  } catch {
    // Fail closed: if we can't verify is_corefit_admin / sub_role (DB error),
    // deny rather than granting super_admin. A privilege check must never fail open.
    return res.status(503).json({ success: false, error: 'Unable to verify admin privileges' });
  }

  next();
}

/**
 * Middleware de permissão granular para rotas admin.
 * Aplica DEPOIS de adminMiddleware (que define req.adminSubRole).
 */
export function requireAdminPermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const subRole = req.adminSubRole ?? 'super_admin';
    const allowed = ADMIN_PERMISSION_MATRIX[subRole] ?? [];
    if (!allowed.includes(permission)) {
      return res.status(403).json({
        success: false,
        error: 'Permissão insuficiente para esta ação.',
        required: permission,
        yourRole: subRole,
      });
    }
    next();
  };
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

/**
 * Bloqueia as rotas que MOVEM dinheiro aluno↔profissional pela plataforma
 * enquanto a cobrança aluno↔personal estiver congelada na V1 (ver
 * `config/features.ts` → STUDENT_BILLING_ENABLED). Aplicar aos checkouts e à
 * criação de planos/ofertas com preço — não aos reads nem aos cancelamentos.
 */
export function requireStudentBillingEnabled(req: Request, res: Response, next: NextFunction) {
  if (!STUDENT_BILLING_ENABLED) {
    return res.status(403).json({
      success: false,
      error: 'Cobrança pela plataforma indisponível nesta versão.',
      code: 'STUDENT_BILLING_FROZEN',
    });
  }
  next();
}
