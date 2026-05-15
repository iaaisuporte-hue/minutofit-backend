import pool from '../config/database';
import logger from '../lib/logger';
import { type ProductKey } from '../db/ensureProductsSchema';

export interface MembershipOptions {
  /** Academy context for ACADEMIA memberships. */
  academyId?: number | null;
  /** Professional context for PERSONAL / NUTRI memberships. */
  professionalId?: number | null;
  /** Billing plan reference (future). */
  planId?: number | null;
  /** Source academy for billing/audit purposes. */
  sourceAcademyId?: number | null;
  /** User granting the membership (admin/personal/nutri). */
  grantedByUserId?: number | null;
  /** Hard expiration date (null = no expiry). */
  expiresAt?: Date | null;
  /** Audit notes. */
  notes?: string | null;
  /** Arbitrary structured metadata (source, mp_preapproval_id, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ActiveMembership {
  product_key: ProductKey;
  status: string;
  source: string;
  granted_at: string;
  expires_at: string | null;
  ended_at: string | null;
  academy_id: number | null;
  professional_id: number | null;
  plan_id: number | null;
  metadata: Record<string, unknown>;
}

/**
 * Grants a product membership to a user (idempotent UPSERT).
 *
 * Invariants:
 *  - Calling grantMembership for product X NEVER affects memberships for other products.
 *  - Calling again re-activates a previously cancelled/paused membership.
 *  - metadata is merged (existing || new) — never overwritten wholesale.
 */
export async function grantMembership(
  userId: number,
  productKey: ProductKey,
  opts: MembershipOptions = {}
): Promise<void> {
  const meta = JSON.stringify(opts.metadata ?? {});
  await pool.query(
    `INSERT INTO user_product_memberships
       (user_id, product_key, status, source, source_academy_id, academy_id,
        professional_id, plan_id, granted_by_user_id, expires_at, notes, metadata, started_at)
     VALUES ($1, $2, 'active',
       CASE WHEN $3::integer IS NOT NULL THEN 'academy_bootstrap' ELSE 'metacore' END,
       $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (user_id, product_key)
     DO UPDATE SET
       status             = 'active',
       source             = CASE
         WHEN EXCLUDED.source_academy_id IS NOT NULL THEN 'academy_bootstrap'
         ELSE user_product_memberships.source
       END,
       source_academy_id  = COALESCE(EXCLUDED.source_academy_id, user_product_memberships.source_academy_id),
       academy_id         = COALESCE(EXCLUDED.academy_id,      user_product_memberships.academy_id),
       professional_id    = COALESCE(EXCLUDED.professional_id, user_product_memberships.professional_id),
       plan_id            = COALESCE(EXCLUDED.plan_id,         user_product_memberships.plan_id),
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       granted_at         = NOW(),
       expires_at         = EXCLUDED.expires_at,
       ended_at           = NULL,
       revoked_at         = NULL,
       revoked_by_user_id = NULL,
       notes              = COALESCE(EXCLUDED.notes, user_product_memberships.notes),
       metadata           = user_product_memberships.metadata || EXCLUDED.metadata`,
    [
      userId,
      productKey,
      opts.sourceAcademyId ?? opts.academyId ?? null,
      opts.academyId ?? null,
      opts.professionalId ?? null,
      opts.planId ?? null,
      opts.grantedByUserId ?? null,
      opts.expiresAt ?? null,
      opts.notes ?? null,
      meta,
    ]
  );

  logger.info(
    { userId, productKey, academyId: opts.academyId, professionalId: opts.professionalId },
    '[membership] granted'
  );
}

/**
 * Pauses a membership without cancelling it.
 * Paused memberships are excluded from getUserProducts (JWT) and product gates.
 *
 * Invariants: only affects the specific (userId, productKey) pair.
 */
export async function pauseMembership(userId: number, productKey: ProductKey): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_product_memberships
     SET status = 'paused'
     WHERE user_id = $1 AND product_key = $2 AND status = 'active'`,
    [userId, productKey]
  );
  const affected = (result.rowCount ?? 0) > 0;
  if (affected) {
    logger.info({ userId, productKey }, '[membership] paused');
  }
  return affected;
}

/**
 * Cancels a membership. Does NOT remove the row — history is preserved.
 * Does NOT affect any other product memberships for the same user.
 *
 * Invariants: only affects the specific (userId, productKey) pair.
 */
export async function cancelMembership(userId: number, productKey: ProductKey, opts: {
  revokedByUserId?: number | null;
  reason?: string | null;
} = {}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_product_memberships
     SET
       status             = 'cancelled',
       revoked_at         = NOW(),
       revoked_by_user_id = $3,
       ended_at           = NOW(),
       notes              = CASE
         WHEN $4::text IS NOT NULL
           THEN COALESCE(notes, '') || ' | Cancelled: ' || $4
         ELSE notes
       END
     WHERE user_id = $1 AND product_key = $2 AND status IN ('active', 'paused')`,
    [userId, productKey, opts.revokedByUserId ?? null, opts.reason ?? null]
  );
  const affected = (result.rowCount ?? 0) > 0;
  if (affected) {
    logger.info({ userId, productKey, revokedByUserId: opts.revokedByUserId }, '[membership] cancelled');
  }
  return affected;
}

/**
 * Returns all active memberships for a user with full metadata.
 */
export async function getActiveMemberships(userId: number): Promise<ActiveMembership[]> {
  try {
    const result = await pool.query<ActiveMembership>(
      `SELECT product_key, status, source, granted_at, expires_at, ended_at,
              academy_id, professional_id, plan_id, metadata
       FROM user_product_memberships
       WHERE user_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (ended_at   IS NULL OR ended_at   > NOW())
       ORDER BY granted_at ASC`,
      [userId]
    );
    return result.rows;
  } catch {
    return [];
  }
}
