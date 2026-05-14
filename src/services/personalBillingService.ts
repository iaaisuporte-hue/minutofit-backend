import pool from '../config/database';
import axios from 'axios';
import logger from '../lib/logger';

const MP_API = 'https://api.mercadopago.com';
const MP_TOKEN = () => process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingPeriod = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export type BillingSettings = {
  personalId: number;
  defaultTicketCents: number | null;
  defaultPeriod: BillingPeriod;
  metacoreFeeBps: number;
};

export type BillingPlan = {
  id: number;
  personalId: number;
  academyId: number | null;
  title: string;
  description: string | null;
  priceCents: number;
  period: BillingPeriod;
  active: boolean;
};

export type StudentSubscription = {
  id: number;
  personalId: number;
  studentId: number;
  academyId: number | null;
  planId: number | null;
  priceCents: number;
  status: 'pending' | 'active' | 'paused' | 'canceled' | 'expired';
  mpPreapprovalId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  discountCents: number;
  metaCoreFeeSnapshot: number;
};

export type FinanceSummary = {
  mrrCents: number;
  activeCount: number;
  churnRate30d: number;
  averageTicketCents: number;
  retention30d: number;
  monthlyEvolution: Array<{ month: string; mrrCents: number; activeCount: number }>;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getBillingSettings(personalId: number): Promise<BillingSettings | null> {
  const r = await pool.query(
    `SELECT * FROM personal_billing_settings WHERE personal_id = $1`,
    [personalId]
  );
  if (r.rowCount === 0) return null;
  return mapSettings(r.rows[0]);
}

export async function upsertBillingSettings(
  personalId: number,
  input: Partial<Pick<BillingSettings, 'defaultTicketCents' | 'defaultPeriod' | 'metacoreFeeBps'>>
): Promise<BillingSettings> {
  const r = await pool.query(
    `INSERT INTO personal_billing_settings
       (personal_id, default_ticket_cents, default_period, metacore_fee_bps, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (personal_id) DO UPDATE
       SET default_ticket_cents = COALESCE($2, personal_billing_settings.default_ticket_cents),
           default_period = COALESCE($3, personal_billing_settings.default_period),
           metacore_fee_bps = COALESCE($4, personal_billing_settings.metacore_fee_bps),
           updated_at = NOW()
     RETURNING *`,
    [personalId, input.defaultTicketCents ?? null, input.defaultPeriod ?? null, input.metacoreFeeBps ?? null]
  );
  return mapSettings(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function listBillingPlans(personalId: number, academyId: number | null) {
  const r = await pool.query(
    `SELECT * FROM personal_billing_plans
     WHERE personal_id = $1
       AND ($2::int IS NULL OR academy_id IS NULL OR academy_id = $2)
     ORDER BY active DESC, created_at DESC`,
    [personalId, academyId]
  );
  return r.rows.map(mapPlan);
}

export async function createBillingPlan(
  personalId: number,
  academyId: number | null,
  input: Pick<BillingPlan, 'title' | 'description' | 'priceCents' | 'period'>
): Promise<BillingPlan> {
  const r = await pool.query(
    `INSERT INTO personal_billing_plans
       (personal_id, academy_id, title, description, price_cents, period)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [personalId, academyId, input.title, input.description, input.priceCents, input.period]
  );
  return mapPlan(r.rows[0]);
}

export async function updateBillingPlan(
  id: number,
  personalId: number,
  input: Partial<Pick<BillingPlan, 'title' | 'description' | 'priceCents' | 'period' | 'active'>>
): Promise<BillingPlan> {
  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let i = 1;

  if (input.title !== undefined) { sets.push(`title = $${i++}`); values.push(input.title); }
  if (input.description !== undefined) { sets.push(`description = $${i++}`); values.push(input.description); }
  if (input.priceCents !== undefined) { sets.push(`price_cents = $${i++}`); values.push(input.priceCents); }
  if (input.period !== undefined) { sets.push(`period = $${i++}`); values.push(input.period); }
  if (input.active !== undefined) { sets.push(`active = $${i++}`); values.push(input.active); }

  values.push(id, personalId);
  const r = await pool.query(
    `UPDATE personal_billing_plans SET ${sets.join(', ')}
     WHERE id = $${i++} AND personal_id = $${i++}
     RETURNING *`,
    values
  );
  if (r.rowCount === 0) { const e = new Error('Plan not found'); (e as any).code = 'NOT_FOUND'; throw e; }
  return mapPlan(r.rows[0]);
}

export async function deleteBillingPlan(id: number, personalId: number): Promise<void> {
  const r = await pool.query(
    `UPDATE personal_billing_plans SET active = FALSE, updated_at = NOW()
     WHERE id = $1 AND personal_id = $2`,
    [id, personalId]
  );
  if (r.rowCount === 0) { const e = new Error('Plan not found'); (e as any).code = 'NOT_FOUND'; throw e; }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function subscribeStudent(
  personalId: number,
  studentId: number,
  academyId: number | null,
  planId: number,
  opts: { discountCents?: number; studentEmail: string; studentName: string; frontendUrl: string }
): Promise<{ subscription: StudentSubscription; initPoint: string }> {
  const planRow = await pool.query(
    `SELECT * FROM personal_billing_plans WHERE id = $1 AND personal_id = $2 AND active = TRUE`,
    [planId, personalId]
  );
  if (planRow.rowCount === 0) {
    const e = new Error('Plan not found or inactive'); (e as any).code = 'NOT_FOUND'; throw e;
  }
  const plan = mapPlan(planRow.rows[0]);

  const settings = await getBillingSettings(personalId);
  const feeBps = settings?.metacoreFeeBps ?? 0;
  const finalCents = Math.max(0, plan.priceCents - (opts.discountCents ?? 0));
  const amountBrl = finalCents / 100;

  // Create subscription row (pending)
  const subRow = await pool.query(
    `INSERT INTO personal_student_subscriptions
       (personal_id, student_id, academy_id, plan_id, price_cents, status, discount_cents, metacore_fee_bps_snapshot)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
     RETURNING *`,
    [personalId, studentId, academyId, planId, finalCents, opts.discountCents ?? 0, feeBps]
  );
  const sub = mapSubscription(subRow.rows[0]);

  // Create Mercado Pago pre-approval
  const token = MP_TOKEN();
  if (!token) {
    logger.warn('[personalBilling] MERCADOPAGO_ACCESS_TOKEN not set — returning pending without initPoint');
    return { subscription: sub, initPoint: '' };
  }

  try {
    const startDate = new Date();
    startDate.setMinutes(startDate.getMinutes() + 5);

    const mpPayload = {
      reason: plan.title,
      auto_recurring: {
        frequency: periodToFrequency(plan.period).frequency,
        frequency_type: periodToFrequency(plan.period).type,
        transaction_amount: amountBrl,
        currency_id: 'BRL',
        start_date: startDate.toISOString(),
      },
      payer_email: opts.studentEmail,
      back_url: opts.frontendUrl,
      external_reference: `personal-sub:${sub.id}`,
      notification_url: `${process.env.BACKEND_URL ?? ''}/api/webhooks/mercadopago`,
    };

    const resp = await axios.post(`${MP_API}/preapproval`, mpPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    const mpId: string = resp.data.id;
    const initPoint: string = resp.data.init_point;

    await pool.query(
      `UPDATE personal_student_subscriptions SET mp_preapproval_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [mpId, sub.id]
    );

    await recordBillingEvent(sub.id, 'preapproval_created', { mpId, amountBrl });

    return { subscription: { ...sub, mpPreapprovalId: mpId }, initPoint };
  } catch (err) {
    logger.error({ err, subId: sub.id }, '[personalBilling] MP pre-approval failed');
    await recordBillingEvent(sub.id, 'preapproval_error', { error: String(err) });
    throw err;
  }
}

export async function cancelSubscription(subId: number, personalId: number): Promise<StudentSubscription> {
  const r = await pool.query(
    `UPDATE personal_student_subscriptions
     SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND personal_id = $2 AND status NOT IN ('canceled','expired')
     RETURNING *`,
    [subId, personalId]
  );
  if (r.rowCount === 0) { const e = new Error('Subscription not found'); (e as any).code = 'NOT_FOUND'; throw e; }

  const sub = mapSubscription(r.rows[0]);
  await recordBillingEvent(sub.id, 'canceled_by_personal', {});

  if (sub.mpPreapprovalId) {
    const token = MP_TOKEN();
    if (token) {
      axios
        .put(`${MP_API}/preapproval/${sub.mpPreapprovalId}`, { status: 'cancelled' }, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        })
        .catch((err) => logger.error({ err }, '[personalBilling] MP cancel failed (best-effort)'));
    }
  }

  return sub;
}

// ---------------------------------------------------------------------------
// Webhook handler (called from routes/webhooks.ts)
// ---------------------------------------------------------------------------

export async function handleMpPreapprovalWebhook(
  mpPreapprovalId: string,
  mpStatus: string,
  payload: Record<string, unknown>
): Promise<void> {
  const r = await pool.query(
    `SELECT id FROM personal_student_subscriptions WHERE mp_preapproval_id = $1`,
    [mpPreapprovalId]
  );
  if (r.rowCount === 0) return; // not a personal sub

  const subId: number = r.rows[0].id;
  const statusMap: Record<string, string> = {
    authorized: 'active',
    paused: 'paused',
    cancelled: 'canceled',
    pending: 'pending',
    expired: 'expired',
  };
  const newStatus = statusMap[mpStatus] ?? null;

  if (newStatus) {
    await pool.query(
      `UPDATE personal_student_subscriptions
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      [newStatus, subId]
    );
  }

  await recordBillingEvent(subId, `mp_${mpStatus}`, payload);
}

// ---------------------------------------------------------------------------
// Finance summary
// ---------------------------------------------------------------------------

export async function computeFinanceSummary(
  personalId: number,
  academyId: number | null,
  range: '30d' | '90d' | '12m' = '30d'
): Promise<FinanceSummary> {
  const activeRows = await pool.query(
    `SELECT price_cents, student_id FROM personal_student_subscriptions
     WHERE personal_id = $1
       AND status = 'active'
       AND ($2::int IS NULL OR academy_id IS NULL OR academy_id = $2)`,
    [personalId, academyId]
  );
  const activeCount = activeRows.rowCount ?? 0;
  const mrrCents = activeRows.rows.reduce((s: number, r: any) => s + Number(r.price_cents), 0);
  const averageTicketCents = activeCount > 0 ? Math.round(mrrCents / activeCount) : 0;

  // Churn: subs canceled in the last 30d / (active + canceled)
  const canceledRows = await pool.query(
    `SELECT COUNT(*) AS cnt FROM personal_student_subscriptions
     WHERE personal_id = $1
       AND status = 'canceled'
       AND canceled_at >= NOW() - INTERVAL '30 days'
       AND ($2::int IS NULL OR academy_id IS NULL OR academy_id = $2)`,
    [personalId, academyId]
  );
  const canceledCount = Number(canceledRows.rows[0]?.cnt ?? 0);
  const totalForChurn = activeCount + canceledCount;
  const churnRate30d = totalForChurn > 0 ? Math.round((canceledCount / totalForChurn) * 100) : 0;
  const retention30d = 100 - churnRate30d;

  // Monthly evolution (last 6 months)
  const evRows = await pool.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', pbe.occurred_at), 'YYYY-MM') AS month,
       COUNT(DISTINCT pss.student_id)                            AS active_count,
       SUM(pss.price_cents)                                      AS mrr_cents
     FROM personal_billing_events pbe
     JOIN personal_student_subscriptions pss ON pss.id = pbe.subscription_id
     WHERE pss.personal_id = $1
       AND pbe.event_type = 'mp_authorized'
       AND pbe.occurred_at >= NOW() - INTERVAL '6 months'
       AND ($2::int IS NULL OR pss.academy_id IS NULL OR pss.academy_id = $2)
     GROUP BY 1
     ORDER BY 1`,
    [personalId, academyId]
  );

  const monthlyEvolution = evRows.rows.map((r: any) => ({
    month: r.month,
    mrrCents: Number(r.mrr_cents ?? 0),
    activeCount: Number(r.active_count ?? 0),
  }));

  return { mrrCents, activeCount, churnRate30d, averageTicketCents, retention30d, monthlyEvolution };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recordBillingEvent(
  subscriptionId: number,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO personal_billing_events (subscription_id, event_type, payload_json)
     VALUES ($1, $2, $3)`,
    [subscriptionId, eventType, JSON.stringify(payload)]
  );
}

function periodToFrequency(period: string): { frequency: number; type: string } {
  const map: Record<string, { frequency: number; type: string }> = {
    monthly: { frequency: 1, type: 'months' },
    quarterly: { frequency: 3, type: 'months' },
    semiannual: { frequency: 6, type: 'months' },
    annual: { frequency: 12, type: 'months' },
  };
  return map[period] ?? { frequency: 1, type: 'months' };
}

function mapSettings(row: any): BillingSettings {
  return {
    personalId: row.personal_id,
    defaultTicketCents: row.default_ticket_cents,
    defaultPeriod: row.default_period ?? 'monthly',
    metacoreFeeBps: row.metacore_fee_bps ?? 0,
  };
}

function mapPlan(row: any): BillingPlan {
  return {
    id: row.id,
    personalId: row.personal_id,
    academyId: row.academy_id,
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    period: row.period,
    active: row.active,
  };
}

function mapSubscription(row: any): StudentSubscription {
  return {
    id: row.id,
    personalId: row.personal_id,
    studentId: row.student_id,
    academyId: row.academy_id,
    planId: row.plan_id,
    priceCents: row.price_cents,
    status: row.status,
    mpPreapprovalId: row.mp_preapproval_id,
    currentPeriodStart: row.current_period_start ? new Date(row.current_period_start).toISOString() : null,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    nextChargeAt: row.next_charge_at ? new Date(row.next_charge_at).toISOString() : null,
    discountCents: row.discount_cents ?? 0,
    metaCoreFeeSnapshot: row.metacore_fee_bps_snapshot ?? 0,
  };
}
