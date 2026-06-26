import pool from '../config/database';
import axios from 'axios';
import logger from '../lib/logger';
import { getPreapprovalStatus } from './mercadoPagoService';

const MP_API = 'https://api.mercadopago.com';
const MP_TOKEN = () => process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '';

/** Preço do Pro da academia — configurável por env, NUNCA hardcodado. null = não cobrável ainda. */
function academyProPriceCents(): number | null {
  const env = Number(process.env.ACADEMY_PRO_PRICE_CENTS);
  return Number.isFinite(env) && env > 0 ? Math.round(env) : null;
}

/**
 * Spec 015 — Academy SaaS Billing. Free=operação · Pro=inteligência.
 * Sem linha em academy_subscriptions = Free implícito.
 * intelligence_enabled é o gate do bloco de inteligência do dashboard.
 *
 * Não confundir com academyPlanService.ts (CRUD dos planos de mensalidade que a
 * academia vende ao aluno). Aqui é a assinatura SaaS da academia na plataforma.
 * Checkout MP + webhook ficam em PR-2.
 */

export type AcademySaasPlan = 'free' | 'pro';
export type AcademySaasStatus = 'active' | 'trial' | 'pending' | 'expired' | 'cancelled';

export interface AcademySubscriptionConfig {
  plan: AcademySaasPlan;
  status: AcademySaasStatus;
  intelligenceEnabled: boolean;
  studentCap: number | null;     // null = ilimitado
  currentPeriodEnd: Date | null;
  trialUntil: Date | null;
}

export const ACADEMY_SAAS_DEFAULTS: Record<AcademySaasPlan, Pick<AcademySubscriptionConfig, 'intelligenceEnabled' | 'studentCap'>> = {
  free: { intelligenceEnabled: false, studentCap: null },
  pro:  { intelligenceEnabled: true,  studentCap: null },
};

const FREE_DEFAULT: AcademySubscriptionConfig = {
  plan: 'free',
  status: 'active',
  intelligenceEnabled: false,
  studentCap: null,
  currentPeriodEnd: null,
  trialUntil: null,
};

export const ACADEMY_SUB_EXTERNAL_REF_PREFIX = 'academy-sub:';

export async function getAcademySubscription(academyId: number): Promise<AcademySubscriptionConfig> {
  const result = await pool.query(
    `SELECT plan, status, intelligence_enabled, student_cap, current_period_end, trial_until
       FROM academy_subscriptions
      WHERE academy_id = $1`,
    [academyId]
  );

  if (result.rows.length === 0) return FREE_DEFAULT;

  const row = result.rows[0];
  const status = row.status as AcademySaasStatus;

  // Só honra o plano pago quando ativo/trial. 'pending' (checkout aberto),
  // 'cancelled' ou 'expired' = trata como Free (inteligência travada).
  if (status !== 'active' && status !== 'trial') return FREE_DEFAULT;

  return {
    plan: row.plan as AcademySaasPlan,
    status,
    intelligenceEnabled: row.intelligence_enabled,
    studentCap: row.student_cap ?? ACADEMY_SAAS_DEFAULTS[row.plan as AcademySaasPlan].studentCap,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
    trialUntil: row.trial_until ? new Date(row.trial_until) : null,
  };
}

/**
 * Concede/altera a assinatura SaaS da academia (admin grant — sem cobrança).
 * Registra histórico de plano/preço em academy_subscription_billing_events
 * (event_type = 'admin_set'). trialDays → status 'trial'; senão 'active'.
 */
export async function setAcademySubscription(
  academyId: number,
  plan: AcademySaasPlan,
  opts: { periodDays?: number; priceCents?: number; trialDays?: number; notes?: string; setBy: number | null }
): Promise<void> {
  const defaults = ACADEMY_SAAS_DEFAULTS[plan];
  const currentPeriodEnd = opts.periodDays
    ? new Date(Date.now() + opts.periodDays * 24 * 60 * 60 * 1000)
    : null;
  const trialUntil = opts.trialDays
    ? new Date(Date.now() + opts.trialDays * 24 * 60 * 60 * 1000)
    : null;
  const status: AcademySaasStatus = opts.trialDays ? 'trial' : 'active';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO academy_subscriptions
         (academy_id, plan, status, intelligence_enabled, student_cap, price_cents,
          trial_until, current_period_end, notes, set_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (academy_id) DO UPDATE SET
         plan                 = EXCLUDED.plan,
         status               = EXCLUDED.status,
         intelligence_enabled = EXCLUDED.intelligence_enabled,
         student_cap          = EXCLUDED.student_cap,
         price_cents          = EXCLUDED.price_cents,
         trial_until          = EXCLUDED.trial_until,
         current_period_end   = EXCLUDED.current_period_end,
         notes                = EXCLUDED.notes,
         set_by_user_id       = EXCLUDED.set_by_user_id,
         updated_at           = NOW()`,
      [academyId, plan, status, defaults.intelligenceEnabled, defaults.studentCap,
       opts.priceCents ?? null, trialUntil, currentPeriodEnd, opts.notes ?? null, opts.setBy]
    );
    await client.query(
      `INSERT INTO academy_subscription_billing_events
         (academy_id, event_type, mp_status, payload)
       VALUES ($1, 'admin_set', $2, $3::jsonb)`,
      [academyId, status, JSON.stringify({
        plan,
        periodDays: opts.periodDays ?? null,
        trialDays: opts.trialDays ?? null,
        priceCents: opts.priceCents ?? null,
        setBy: opts.setBy,
        notes: opts.notes ?? null,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cria o checkout (pre-approval recorrente do MP) para a academia assinar o Pro.
 * Espelha createPlatformCheckout (Spec 008). A linha fica 'pending' até o webhook
 * confirmar (handleAcademyPreapprovalWebhook). Preço vem de env (TBD configurável).
 */
export async function createAcademyCheckout(
  academyId: number,
  opts: { payerEmail: string; frontendUrl: string }
): Promise<{ initPoint: string }> {
  const priceCents = academyProPriceCents();
  if (!priceCents) {
    const e = new Error('Preço do Pro não configurado (ACADEMY_PRO_PRICE_CENTS)');
    (e as Error & { code?: string }).code = 'PRICE_NOT_CONFIGURED';
    throw e;
  }

  const token = MP_TOKEN();
  if (!token) {
    const e = new Error('Pagamento indisponível no momento');
    (e as Error & { code?: string }).code = 'PAYMENTS_UNAVAILABLE';
    throw e;
  }

  // Registra a linha como 'pending' (gating segue Free até o webhook confirmar).
  await pool.query(
    `INSERT INTO academy_subscriptions (academy_id, plan, status, price_cents)
     VALUES ($1, 'pro', 'pending', $2)
     ON CONFLICT (academy_id) DO UPDATE SET
       plan = 'pro', status = 'pending', price_cents = EXCLUDED.price_cents, updated_at = NOW()`,
    [academyId, priceCents]
  );

  const startDate = new Date();
  startDate.setMinutes(startDate.getMinutes() + 5);

  const mpPayload = {
    reason: 'S2Core Academia — Pro',
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: priceCents / 100,
      currency_id: 'BRL',
      start_date: startDate.toISOString(),
    },
    payer_email: opts.payerEmail,
    back_url: opts.frontendUrl,
    external_reference: `${ACADEMY_SUB_EXTERNAL_REF_PREFIX}${academyId}`,
    notification_url: `${process.env.BACKEND_URL ?? ''}/api/webhooks/mercadopago`,
  };

  try {
    const resp = await axios.post(`${MP_API}/preapproval`, mpPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const mpId: string = resp.data.id;
    const initPoint: string = resp.data.init_point;

    await pool.query(
      `UPDATE academy_subscriptions SET mp_preapproval_id = $1, updated_at = NOW()
       WHERE academy_id = $2`,
      [mpId, academyId]
    );
    return { initPoint };
  } catch (err) {
    logger.error({ err, academyId }, '[academySub] MP pre-approval failed');
    throw err;
  }
}

/** Mapeia o status cru do MP para a ação aplicada (e o tipo de evento). */
function actionForMpStatus(mpStatus: string): 'activated' | 'cancelled' | 'ignored_paused' | 'ignored' {
  if (mpStatus === 'authorized') return 'activated';
  if (mpStatus === 'cancelled' || mpStatus === 'expired' || mpStatus === 'suspended') return 'cancelled';
  if (mpStatus === 'paused') return 'ignored_paused';
  return 'ignored';
}

/**
 * Webhook do MP para a assinatura SaaS da academia. Roteado de routes/webhooks.ts
 * pelo prefixo 'academy-sub:{academyId}'. IDEMPOTENTE: reivindica o evento no log
 * (UNIQUE em mp_event_id); duplicado → pula. Em erro, ROLLBACK → MP re-tenta limpo.
 */
export async function handleAcademyPreapprovalWebhook(
  academyId: number,
  mpStatus: string,
  payload: Record<string, unknown>,
  eventId?: string | null
): Promise<void> {
  const action = actionForMpStatus(mpStatus);
  const mpPreapprovalId = payload?.id != null ? String(payload.id) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claim = await client.query(
      `INSERT INTO academy_subscription_billing_events
         (academy_id, mp_preapproval_id, mp_event_id, event_type, mp_status, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (mp_event_id) WHERE mp_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [academyId, mpPreapprovalId, eventId ?? null, action, mpStatus, JSON.stringify(payload ?? {})]
    );

    if (eventId && (claim.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      logger.info({ academyId, eventId, mpStatus }, '[academy-billing] webhook duplicado — ignorado');
      return;
    }

    const r = await client.query(
      `SELECT plan FROM academy_subscriptions WHERE academy_id = $1 FOR UPDATE`,
      [academyId]
    );
    if ((r.rowCount ?? 0) > 0) {
      if (action === 'activated') {
        const periodEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
        await client.query(
          `UPDATE academy_subscriptions SET
             plan = 'pro', status = 'active', intelligence_enabled = true,
             student_cap = $2, current_period_end = $3, updated_at = NOW()
           WHERE academy_id = $1`,
          [academyId, ACADEMY_SAAS_DEFAULTS.pro.studentCap, periodEnd]
        );
      } else if (action === 'cancelled') {
        await client.query(
          `UPDATE academy_subscriptions SET
             plan = 'free', status = 'cancelled', intelligence_enabled = false,
             student_cap = $2, current_period_end = NULL, updated_at = NOW()
           WHERE academy_id = $1`,
          [academyId, ACADEMY_SAAS_DEFAULTS.free.studentCap]
        );
      }
      // 'ignored' / 'ignored_paused': sem mudança de estado (só auditado).
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Reconciliação (safety net) — busca o status real no MP e ressincroniza. Admin-triggered. */
export async function reconcileAcademySubscription(
  academyId: number
): Promise<{ mpStatus: string | null; action: string }> {
  const r = await pool.query(
    `SELECT mp_preapproval_id FROM academy_subscriptions WHERE academy_id = $1`,
    [academyId]
  );
  const mpId = r.rows[0]?.mp_preapproval_id as string | undefined;
  if (!mpId) return { mpStatus: null, action: 'no_preapproval' };

  const preapproval = await getPreapprovalStatus(mpId);
  const mpStatus: string | null = preapproval?.status ?? null;
  if (!mpStatus) return { mpStatus: null, action: 'unknown' };

  await handleAcademyPreapprovalWebhook(academyId, mpStatus, preapproval, null);
  return { mpStatus, action: actionForMpStatus(mpStatus) };
}

/** Histórico de eventos de billing da academia (auditoria/debug). */
export async function listAcademyBillingEvents(academyId: number, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, mp_preapproval_id, mp_event_id, event_type, mp_status, created_at
       FROM academy_subscription_billing_events
      WHERE academy_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [academyId, Math.min(200, Math.max(1, limit))]
  );
  return rows;
}
