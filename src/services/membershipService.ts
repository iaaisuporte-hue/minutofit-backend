import pool from '../config/database';
import logger from '../lib/logger';
import { type ProductKey } from '../db/ensureProductsSchema';

/**
 * Valores válidos para `source` em `user_product_memberships`.
 * Manter alinhado com a CHECK constraint (migration 1747700000000).
 */
export type MembershipSource =
  | 'corefit'
  | 'academy_bootstrap'
  | 'direct_purchase'
  | 'bonus_academy'
  | 'bonus_personal'
  | 'bonus_nutri'
  | 'discount_partner'
  | 'trial'
  | 'grace_period';

export interface MembershipOptions {
  /** Origem desta concessão (define o ciclo de vida do membership). */
  source?: MembershipSource;
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

/** Produtos pai cujo cancelamento dispara grace no App bônus. */
const APP_BONUS_PARENT_PRODUCTS: ReadonlyArray<ProductKey> = ['academia', 'personal', 'nutri'];

/**
 * Mapeia produto pai → source de bônus correspondente no App.
 *
 * Exportado porque quem CONCEDE o vínculo precisa gravar exatamente este valor
 * na coluna `source` — é a chave que `enterGraceForAppBonus` usa para achar o
 * App bônus no cancelamento. Passar a origem só em `metadata` deixa a linha com
 * o default 'corefit' e o hook de graça nunca casa (QA 01/ago/2026, P1-4).
 */
export const PARENT_TO_BONUS_SOURCE: Record<string, MembershipSource> = {
  academia: 'bonus_academy',
  personal: 'bonus_personal',
  nutri:    'bonus_nutri',
};

/** `source` de bônus do App para o produto pai, ou 'corefit' se não houver. */
export function bonusSourceFor(parentProductKey: string): MembershipSource {
  return PARENT_TO_BONUS_SOURCE[parentProductKey] ?? 'corefit';
}

/** Janela padrão de graça do App bônus quando o produto pai é cancelado. */
export const APP_BONUS_GRACE_DAYS = 30;

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
 * Resolve o `source` final do membership.
 *  - Se `opts.source` foi explícito → usa.
 *  - Senão, mantém compatibilidade com o comportamento legado:
 *      sourceAcademyId presente ⇒ `academy_bootstrap`, do contrário `corefit`.
 */
function resolveSource(opts: MembershipOptions): MembershipSource {
  if (opts.source) return opts.source;
  if ((opts.sourceAcademyId ?? null) !== null) return 'academy_bootstrap';
  return 'corefit';
}

/**
 * Grants a product membership to a user (idempotent UPSERT).
 *
 * Invariants:
 *  - Calling grantMembership for product X NEVER affects memberships for other products.
 *  - Calling again re-activates a previously cancelled/paused membership.
 *  - metadata is merged (existing || new) — never overwritten wholesale.
 *  - Quando o caller informa `opts.source`, ele é gravado tal qual. Sem `source`,
 *    cai no comportamento legado (academy_bootstrap se houver sourceAcademyId).
 *  - Re-grant sempre limpa `grace_until` e `converted_from_source` (sai de graça).
 */
export async function grantMembership(
  userId: number,
  productKey: ProductKey,
  opts: MembershipOptions = {}
): Promise<void> {
  const source = resolveSource(opts);
  const meta = JSON.stringify(opts.metadata ?? {});

  await pool.query(
    `INSERT INTO user_product_memberships
       (user_id, product_key, status, source, source_academy_id, academy_id,
        professional_id, plan_id, granted_by_user_id, expires_at, notes, metadata, started_at)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
     ON CONFLICT (user_id, product_key)
     DO UPDATE SET
       status             = 'active',
       source             = EXCLUDED.source,
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
       grace_until        = NULL,
       converted_from_source = NULL,
       notes              = COALESCE(EXCLUDED.notes, user_product_memberships.notes),
       metadata           = user_product_memberships.metadata || EXCLUDED.metadata`,
    [
      userId,
      productKey,
      source,
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
    { userId, productKey, source, academyId: opts.academyId, professionalId: opts.professionalId },
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
 * Side-effect (App como bônus): se o produto cancelado for `academia | personal | nutri`
 * e o usuário tiver um App ativo com `source` correspondente ao bônus daquele pai,
 * o App entra automaticamente em `grace_period` (30 dias). Falhas no hook são
 * logadas mas não bloqueiam o cancelamento principal.
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

    if (APP_BONUS_PARENT_PRODUCTS.includes(productKey)) {
      try {
        await enterGraceForAppBonus(userId, productKey);
      } catch (err) {
        logger.error({ err, userId, productKey }, '[membership] enterGraceForAppBonus failed');
      }
    }
  }
  return affected;
}

/**
 * Coloca o App de um usuário em "período de graça" quando o produto pai
 * (Academia/Personal/Nutri) é cancelado e o App havia sido concedido como
 * bônus daquele pai.
 *
 * Idempotente:
 *  - Só atua se o App estiver ativo e com source correspondente ao bônus
 *    daquele produto pai (`bonus_academy/_personal/_nutri`).
 *  - Não age sobre App `direct_purchase`, `corefit`, `trial`, etc.
 *  - Preserva `source` original em `converted_from_source` para auditoria.
 */
export async function enterGraceForAppBonus(
  userId: number,
  parentProductKey: ProductKey,
  days: number = APP_BONUS_GRACE_DAYS
): Promise<boolean> {
  const expectedBonusSource = PARENT_TO_BONUS_SOURCE[parentProductKey];
  if (!expectedBonusSource) return false;

  const result = await pool.query(
    `UPDATE user_product_memberships
     SET
       converted_from_source = source,
       source                = 'grace_period',
       grace_until           = NOW() + ($3 || ' days')::interval,
       metadata              = metadata
                                 || jsonb_build_object(
                                      'grace_started_at', NOW()::text,
                                      'grace_parent_product', $2::text
                                    )
     WHERE user_id     = $1
       AND product_key = 'app'
       AND status      = 'active'
       AND source      = $4`,
    [userId, parentProductKey, days, expectedBonusSource]
  );
  const affected = (result.rowCount ?? 0) > 0;
  if (affected) {
    logger.info({ userId, parentProductKey, days }, '[membership] app bonus entered grace_period');
  }
  return affected;
}

/**
 * Converte o App em standalone (paid) quando o usuário decide manter o
 * acesso após a graça — antes do `grace_until` expirar.
 */
export async function convertGraceToStandalone(
  userId: number,
  ref: { paymentRef?: string | null; planId?: number | null } = {}
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_product_memberships
     SET
       source     = 'direct_purchase',
       grace_until = NULL,
       plan_id     = COALESCE($3, plan_id),
       metadata    = metadata || jsonb_build_object(
         'conversion', jsonb_build_object(
           'converted_at', NOW()::text,
           'payment_ref',  $2::text,
           'from_source',  converted_from_source
         )
       )
     WHERE user_id     = $1
       AND product_key = 'app'
       AND status      = 'active'
       AND source      = 'grace_period'
       AND (grace_until IS NULL OR grace_until > NOW())`,
    [userId, ref.paymentRef ?? null, ref.planId ?? null]
  );
  const affected = (result.rowCount ?? 0) > 0;
  if (affected) {
    logger.info({ userId, paymentRef: ref.paymentRef }, '[membership] grace converted to standalone');
  }
  return affected;
}

/**
 * Expira em lote todas as graças vencidas. Idempotente.
 * Marca `status='expired'`, `revoked_at=now`, `ended_at=now`. Não toca em outras
 * sources. Retorna a contagem de linhas afetadas — usado pelo endpoint admin
 * manual enquanto o cron real não entra no ar (Fase 2).
 */
export async function expireOverdueGraces(now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `UPDATE user_product_memberships
     SET
       status     = 'expired',
       revoked_at = NOW(),
       ended_at   = NOW(),
       metadata   = metadata || jsonb_build_object('grace_expired_at', NOW()::text)
     WHERE source      = 'grace_period'
       AND status      = 'active'
       AND grace_until IS NOT NULL
       AND grace_until < $1`,
    [now]
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.info({ count }, '[membership] expired overdue graces');
  }
  return count;
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
