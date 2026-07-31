import axios from 'axios';
import pool from '../config/database';
import logger from '../lib/logger';
import { describeHttpError } from '../lib/httpError';
import { logDataAccessEvent } from './dataAccessAuditService';
import {
  grantConsents,
  revokeAllConsents,
  DEFAULT_SCOPES_PERSONAL,
  DEFAULT_SCOPES_NUTRI,
  type ConsentScope,
  type ProfessionalRole,
} from './consentService';
import { getOffering, type OfferingPeriod } from './professionalOfferingService';

const MP_API = 'https://api.mercadopago.com';
const MP_TOKEN = () => process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
const MP_EXTERNAL_REF_PREFIX = 'pro-net-sub:';

export type SubscriptionStatus =
  | 'pending_payment'
  | 'active'
  | 'paused'
  | 'cancelled'
  | 'expired';

export interface ProfessionalSubscription {
  id: string;
  studentId: number;
  professionalId: number;
  professionalRole: ProfessionalRole;
  offeringId: string;
  priceCentsSnapshot: number;
  periodSnapshot: OfferingPeriod;
  corefitFeeBpsSnapshot: number;
  status: SubscriptionStatus;
  mpPreapprovalId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function fail(status: number, error: string, details?: unknown): never {
  throw Object.assign(new Error(error), { status, details });
}

function mapRow(row: Record<string, unknown>): ProfessionalSubscription {
  return {
    id: row.id as string,
    studentId: row.student_id as number,
    professionalId: row.professional_id as number,
    professionalRole: row.professional_role as ProfessionalRole,
    offeringId: row.offering_id as string,
    priceCentsSnapshot: row.price_cents_snapshot as number,
    periodSnapshot: row.period_snapshot as OfferingPeriod,
    corefitFeeBpsSnapshot: row.corefit_fee_bps_snapshot as number,
    status: row.status as SubscriptionStatus,
    mpPreapprovalId: (row.mp_preapproval_id as string | null) ?? null,
    currentPeriodStart: row.current_period_start ? new Date(row.current_period_start as string).toISOString() : null,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end as string).toISOString() : null,
    nextChargeAt: row.next_charge_at ? new Date(row.next_charge_at as string).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at as string).toISOString() : null,
    cancelReason: (row.cancel_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function periodToFrequency(period: OfferingPeriod): { frequency: number; type: 'months' } {
  switch (period) {
    case 'monthly': return { frequency: 1, type: 'months' };
    case 'quarterly': return { frequency: 3, type: 'months' };
    case 'semiannual': return { frequency: 6, type: 'months' };
    case 'annual': return { frequency: 12, type: 'months' };
  }
}

function defaultScopesFor(role: ProfessionalRole): ConsentScope[] {
  return role === 'personal' ? DEFAULT_SCOPES_PERSONAL : DEFAULT_SCOPES_NUTRI;
}

function assignmentTableFor(role: ProfessionalRole): { table: string; proCol: string; studentCol: string } {
  return role === 'personal'
    ? { table: 'personal_student_assignments', proCol: 'personal_id', studentCol: 'student_id' }
    : { table: 'nutri_patient_assignments', proCol: 'nutri_id', studentCol: 'patient_id' };
}

// ---------------------------------------------------------------------------
// Student: create checkout
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  studentId: number;
  studentEmail: string;
  offeringId: string;
  scopes?: ConsentScope[];
  frontendUrl?: string;
  ip?: string;
}

export interface CheckoutResult {
  subscription: ProfessionalSubscription;
  redirectUrl: string;
  expiresAt: string;
}

export async function createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const offering = await getOffering(input.offeringId);
  if (!offering || offering.status !== 'active') {
    fail(404, 'offering_not_found_or_archived');
  }

  if (offering.professionalId === input.studentId) {
    fail(400, 'cannot_subscribe_to_self');
  }

  // Already has active link of same role? Block before creating a pending sub.
  const { table, studentCol } = assignmentTableFor(offering.professionalRole);
  const { rows: activeLink } = await pool.query(
    `SELECT 1 FROM ${table} WHERE ${studentCol} = $1 AND status = 'active' LIMIT 1`,
    [input.studentId]
  );
  if (activeLink.length > 0) fail(409, 'conflict_active_link');

  // Block double-pending too — one pending checkout per role for the student.
  const { rows: pending } = await pool.query(
    `SELECT 1 FROM professional_subscriptions
     WHERE student_id = $1 AND professional_role = $2 AND status = 'pending_payment'
     LIMIT 1`,
    [input.studentId, offering.professionalRole]
  );
  if (pending.length > 0) fail(409, 'conflict_pending_checkout');

  const { rows } = await pool.query(
    `INSERT INTO professional_subscriptions
       (student_id, professional_id, professional_role, offering_id,
        price_cents_snapshot, period_snapshot, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment')
     RETURNING *`,
    [
      input.studentId,
      offering.professionalId,
      offering.professionalRole,
      offering.id,
      offering.priceCents,
      offering.period,
    ]
  );
  const sub = mapRow(rows[0]);

  await logDataAccessEvent({
    actorId: input.studentId,
    subjectUserId: input.studentId,
    eventType: 'subscription.created',
    eventPayload: {
      subscriptionId: sub.id,
      professionalId: offering.professionalId,
      offeringId: offering.id,
    },
    ip: input.ip,
  });

  // MP pre-approval — gracefully degrade if token missing (sandbox/dev).
  const token = MP_TOKEN();
  if (!token) {
    logger.warn({ subId: sub.id }, '[proNetwork] MERCADOPAGO_ACCESS_TOKEN missing — checkout returned without redirectUrl');
    return {
      subscription: sub,
      redirectUrl: '',
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
  }

  try {
    const startDate = new Date();
    startDate.setMinutes(startDate.getMinutes() + 5);

    const freq = periodToFrequency(offering.period);
    const mpPayload = {
      reason: offering.title,
      auto_recurring: {
        frequency: freq.frequency,
        frequency_type: freq.type,
        transaction_amount: offering.priceCents / 100,
        currency_id: offering.currency || 'BRL',
        start_date: startDate.toISOString(),
      },
      payer_email: input.studentEmail,
      back_url: input.frontendUrl ?? process.env.FRONTEND_URL ?? '',
      external_reference: `${MP_EXTERNAL_REF_PREFIX}${sub.id}`,
      notification_url: `${process.env.BACKEND_URL ?? ''}/api/webhooks/mercadopago`,
    };

    const resp = await axios.post(`${MP_API}/preapproval`, mpPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    const mpId: string = resp.data.id;
    const initPoint: string =
      process.env.NODE_ENV === 'production' ? resp.data.init_point : resp.data.sandbox_init_point ?? resp.data.init_point;

    await pool.query(
      `UPDATE professional_subscriptions
       SET mp_preapproval_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [mpId, sub.id]
    );

    return {
      subscription: { ...sub, mpPreapprovalId: mpId },
      redirectUrl: initPoint,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
  } catch (err) {
    logger.error({ err: describeHttpError(err), subId: sub.id }, '[proNetwork] MP pre-approval failed');
    fail(502, 'mp_preapproval_failed');
  }
}

// ---------------------------------------------------------------------------
// Activation (called from webhook on MP approval)
// ---------------------------------------------------------------------------

async function activateSubscription(subId: string, mpStatus: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE professional_subscriptions
       SET status = 'active',
           current_period_start = COALESCE(current_period_start, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending_payment','paused')
       RETURNING *`,
      [subId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }
    const sub = mapRow(rows[0]);
    const { table, proCol, studentCol } = assignmentTableFor(sub.professionalRole);

    // Active link guard inside the tx — partial unique index also enforces.
    const { rows: existing } = await client.query(
      `SELECT id, status FROM ${table}
       WHERE ${studentCol} = $1
       LIMIT 1`,
      [sub.studentId]
    );

    if (existing[0] && existing[0].status === 'active') {
      // Already linked — idempotent: webhook re-delivery.
    } else if (existing[0]) {
      await client.query(
        `UPDATE ${table}
         SET ${proCol} = $1, status = 'active', initiated_by = 'student', updated_at = NOW()
         WHERE id = $2`,
        [sub.professionalId, existing[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO ${table} (${proCol}, ${studentCol}, status, initiated_by)
         VALUES ($1, $2, 'active', 'student')`,
        [sub.professionalId, sub.studentId]
      );
    }

    const scopes = defaultScopesFor(sub.professionalRole);
    await grantConsents(sub.studentId, sub.professionalId, sub.professionalRole, scopes, client as never);

    await logDataAccessEvent(
      {
        actorId: sub.studentId,
        subjectUserId: sub.studentId,
        eventType: 'subscription.activated',
        eventPayload: { subscriptionId: sub.id, mpStatus, scopes },
      },
      client as never
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

async function cancelSubscriptionTx(
  subId: string,
  cancelledBy: number,
  reason: string,
  ip?: string
): Promise<ProfessionalSubscription | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE professional_subscriptions
       SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('cancelled','expired')
       RETURNING *`,
      [subId, reason]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const sub = mapRow(rows[0]);
    const { table, studentCol } = assignmentTableFor(sub.professionalRole);

    await client.query(
      `UPDATE ${table}
       SET status = 'inactive', updated_at = NOW()
       WHERE ${studentCol} = $1 AND status = 'active'`,
      [sub.studentId]
    );

    await revokeAllConsents(
      sub.studentId,
      sub.professionalId,
      sub.professionalRole,
      cancelledBy,
      client as never,
      ip
    );

    await logDataAccessEvent(
      {
        actorId: cancelledBy,
        subjectUserId: sub.studentId,
        eventType: 'subscription.cancelled',
        eventPayload: { subscriptionId: sub.id, reason },
        ip,
      },
      client as never
    );

    await client.query('COMMIT');

    // Best-effort: tell MP to cancel the pre-approval.
    if (sub.mpPreapprovalId) {
      const token = MP_TOKEN();
      if (token) {
        axios
          .put(
            `${MP_API}/preapproval/${sub.mpPreapprovalId}`,
            { status: 'cancelled' },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
          )
          .catch((err) => logger.error({ err: describeHttpError(err), subId: sub.id }, '[proNetwork] MP cancel failed'));
      }
    }

    return sub;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelByStudent(
  subId: string,
  studentId: number,
  ip?: string
): Promise<ProfessionalSubscription> {
  const owns = await pool.query(
    `SELECT id FROM professional_subscriptions WHERE id = $1 AND student_id = $2 LIMIT 1`,
    [subId, studentId]
  );
  if (owns.rows.length === 0) fail(404, 'subscription_not_found_or_not_yours');

  const sub = await cancelSubscriptionTx(subId, studentId, 'cancelled_by_student', ip);
  if (!sub) fail(409, 'already_cancelled');
  return sub;
}

export async function cancelByProfessional(
  subId: string,
  professionalId: number,
  ip?: string
): Promise<ProfessionalSubscription> {
  const owns = await pool.query(
    `SELECT id FROM professional_subscriptions WHERE id = $1 AND professional_id = $2 LIMIT 1`,
    [subId, professionalId]
  );
  if (owns.rows.length === 0) fail(404, 'subscription_not_found_or_not_yours');

  const sub = await cancelSubscriptionTx(subId, professionalId, 'cancelled_by_professional', ip);
  if (!sub) fail(409, 'already_cancelled');
  return sub;
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

export const PRO_NETWORK_EXTERNAL_REF_PREFIX = MP_EXTERNAL_REF_PREFIX;

export async function handleMpPreapprovalWebhook(
  mpPreapprovalId: string,
  mpStatus: string,
  externalReference: string | undefined,
  _payload: Record<string, unknown>
): Promise<void> {
  let subId: string | null = null;

  if (externalReference?.startsWith(MP_EXTERNAL_REF_PREFIX)) {
    subId = externalReference.slice(MP_EXTERNAL_REF_PREFIX.length);
  } else if (mpPreapprovalId) {
    const { rows } = await pool.query(
      `SELECT id FROM professional_subscriptions WHERE mp_preapproval_id = $1 LIMIT 1`,
      [mpPreapprovalId]
    );
    if (rows[0]) subId = rows[0].id;
  }

  if (!subId) return;

  const { rows: subRows } = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE id = $1 LIMIT 1`,
    [subId]
  );
  if (subRows.length === 0) return;
  const sub = mapRow(subRows[0]);

  if (mpPreapprovalId && sub.mpPreapprovalId == null) {
    await pool.query(
      `UPDATE professional_subscriptions SET mp_preapproval_id = $1, updated_at = NOW() WHERE id = $2`,
      [mpPreapprovalId, sub.id]
    );
  }

  switch (mpStatus) {
    case 'authorized':
      await activateSubscription(sub.id, mpStatus);
      break;
    case 'paused':
      if (sub.status === 'active' || sub.status === 'pending_payment') {
        await pool.query(
          `UPDATE professional_subscriptions SET status = 'paused', updated_at = NOW() WHERE id = $1`,
          [sub.id]
        );
        await logDataAccessEvent({
          actorId: sub.studentId,
          subjectUserId: sub.studentId,
          eventType: 'subscription.paused',
          eventPayload: { subscriptionId: sub.id, mpStatus },
        });
      }
      break;
    case 'cancelled':
      await cancelSubscriptionTx(sub.id, sub.studentId, 'mp_cancelled');
      break;
    case 'expired':
      await pool.query(
        `UPDATE professional_subscriptions SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [sub.id]
      );
      await logDataAccessEvent({
        actorId: sub.studentId,
        subjectUserId: sub.studentId,
        eventType: 'subscription.expired',
        eventPayload: { subscriptionId: sub.id },
      });
      break;
    default:
      logger.info({ subId: sub.id, mpStatus }, '[proNetwork] unhandled MP status');
  }

  // Não logar o payload completo do MP (contém PII do pagador: e-mail, ids, valores).
  logger.info({ subId: sub.id, mpStatus }, '[proNetwork] webhook processed');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listStudentSubscriptions(studentId: number): Promise<ProfessionalSubscription[]> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE student_id = $1 ORDER BY created_at DESC`,
    [studentId]
  );
  return rows.map(mapRow);
}

export async function listProfessionalSubscriptions(professionalId: number): Promise<ProfessionalSubscription[]> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE professional_id = $1 ORDER BY created_at DESC`,
    [professionalId]
  );
  return rows.map(mapRow);
}

export async function getSubscription(subId: string): Promise<ProfessionalSubscription | null> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_subscriptions WHERE id = $1 LIMIT 1`,
    [subId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
