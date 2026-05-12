import { Request, Response, NextFunction } from 'express';
import pool from '../config/database';

export interface TenantContext {
  academyId: number;
  roleSlug: string;
  permissions: string[];
  unitId?: number;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

/**
 * Guard de tenant — Fase 1.
 *
 * Requer que req.user esteja populado (authMiddleware antes).
 * Valida o activeAcademyId do JWT contra academy_users em tempo real
 * (defesa contra token roubado pós-revogação de acesso).
 *
 * BE-1.7.3: Se req.tenantHost está presente e differe do JWT → 403 (tenant mismatch).
 *
 * Em caso de sucesso popula req.tenant = { academyId, roleSlug, permissions, unitId? }.
 *
 * Retorna:
 *  401 — usuário não autenticado
 *  403 — sem academia ativa no token, ou vínculo revogado, ou academia suspensa, ou tenant mismatch
 */
export async function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  // Primary source: JWT. Fallback: X-Tenant-Host (sent by authFetch when on a subdomain).
  // The DB check below always validates the user actually has access to the resolved academy.
  const academyId = req.user.activeAcademyId ?? req.tenantHost?.academyId;
  if (!academyId) {
    return res.status(403).json({
      success: false,
      error: 'No active academy context. Use POST /auth/switch-academy.',
    });
  }

  // BE-1.7.3: Host-vs-token mismatch — prevents using a token from academy A on academy B's subdomain.
  // Only applies when the JWT explicitly has a different academy than the host.
  if (req.tenantHost && req.user.activeAcademyId && req.tenantHost.academyId !== req.user.activeAcademyId) {
    return res.status(403).json({
      success: false,
      error: 'Tenant mismatch: token não pertence ao subdomínio acessado.',
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         au.academy_unit_id,
         ar.slug         AS role_slug,
         ar.permissions,
         a.status        AS academy_status
       FROM academy_users au
       JOIN academy_roles ar ON ar.id = au.role_id
       JOIN academies     a  ON a.id  = au.academy_id
       WHERE au.user_id    = $1
         AND au.academy_id = $2
         AND au.is_active  = TRUE
         AND au.status     = 'active'
       LIMIT 1`,
      [req.user.id, academyId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Academy access revoked.' });
    }

    const row = result.rows[0];

    if (row.academy_status !== 'active') {
      return res.status(403).json({ success: false, error: 'Academy suspended.' });
    }

    let permissions: string[] = [];
    try {
      permissions = Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions ?? '[]');
    } catch {
      permissions = [];
    }

    req.tenant = {
      academyId,
      roleSlug: row.role_slug,
      permissions,
      unitId: row.academy_unit_id ?? undefined,
    };

    next();
  } catch (err) {
    console.error('[tenantContext] error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Verifica se o tenant tem a permissão solicitada.
 * Retorna 403 se não tiver.
 */
export function requireTenantPermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return res.status(403).json({ success: false, error: 'Tenant context required' });
    }
    if (!req.tenant.permissions.includes(permission)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    next();
  };
}
