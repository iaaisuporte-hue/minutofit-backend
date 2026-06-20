import pool from '../config/database';
import axios from 'axios';
import logger from '../lib/logger';

const MP_API = 'https://api.mercadopago.com';
const MP_TOKEN = () => process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '';

export type PersonalPlan = 'free' | 'starter' | 'pro';
export type PersonalPlanStatus = 'active' | 'trial' | 'expired' | 'cancelled' | 'pending';

export interface PersonalPlanConfig {
  plan: PersonalPlan;
  status: PersonalPlanStatus;
  studentLimit: number | null;
  aiEnabled: boolean;
  currentPeriodEnd: Date | null;
}

const PLAN_DEFAULTS: Record<PersonalPlan, Pick<PersonalPlanConfig, 'studentLimit' | 'aiEnabled'>> = {
  free:    { studentLimit: 3,    aiEnabled: false },
  starter: { studentLimit: 15,   aiEnabled: false },
  pro:     { studentLimit: null, aiEnabled: true  },
};

/** Preços mensais dos planos pagos (centavos BRL). V1 só vende Pro. */
const PLAN_PRICING_CENTS: Partial<Record<PersonalPlan, number>> = {
  starter: 4900,
  pro:     8900,
};

const FREE_DEFAULT: PersonalPlanConfig = {
  plan: 'free',
  status: 'active',
  studentLimit: PLAN_DEFAULTS.free.studentLimit,
  aiEnabled: PLAN_DEFAULTS.free.aiEnabled,
  currentPeriodEnd: null,
};

export async function getPersonalPlan(personalId: number): Promise<PersonalPlanConfig> {
  const result = await pool.query(
    `SELECT plan, status, student_limit, ai_enabled, current_period_end
     FROM personal_platform_subscriptions
     WHERE personal_id = $1`,
    [personalId]
  );

  if (result.rows.length === 0) return FREE_DEFAULT;

  const row = result.rows[0];
  const status = row.status as PersonalPlanStatus;

  // Gating só honra o plano pago quando a assinatura está ativa (ou em trial).
  // Checkout 'pending' (ainda não pagou) ou 'cancelled'/'expired' = trata como Free.
  if (status !== 'active' && status !== 'trial') {
    return FREE_DEFAULT;
  }

  return {
    plan: row.plan as PersonalPlan,
    status,
    studentLimit: row.student_limit ?? PLAN_DEFAULTS[row.plan as PersonalPlan].studentLimit,
    aiEnabled: row.ai_enabled,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
  };
}

export async function setPersonalPlan(
  personalId: number,
  plan: PersonalPlan,
  opts: { periodDays?: number; notes?: string; setBy: number }
): Promise<void> {
  const defaults = PLAN_DEFAULTS[plan];
  const currentPeriodEnd = opts.periodDays
    ? new Date(Date.now() + opts.periodDays * 24 * 60 * 60 * 1000)
    : null;

  await pool.query(
    `INSERT INTO personal_platform_subscriptions
       (personal_id, plan, status, student_limit, ai_enabled, current_period_end, notes, set_by_user_id)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
     ON CONFLICT (personal_id) DO UPDATE SET
       plan               = EXCLUDED.plan,
       status             = 'active',
       student_limit      = EXCLUDED.student_limit,
       ai_enabled         = EXCLUDED.ai_enabled,
       current_period_end = EXCLUDED.current_period_end,
       notes              = EXCLUDED.notes,
       set_by_user_id     = EXCLUDED.set_by_user_id,
       updated_at         = NOW()`,
    [personalId, plan, defaults.studentLimit, defaults.aiEnabled, currentPeriodEnd, opts.notes ?? null, opts.setBy]
  );
}

export const PLATFORM_SUB_EXTERNAL_REF_PREFIX = 'platform-sub:';

/**
 * Cria um checkout (pre-approval recorrente do Mercado Pago) para o personal
 * assinar um plano pago. Espelha o padrão de subscribeStudent em personalBillingService.
 * A linha fica 'pending' até o webhook confirmar o pagamento (handlePlatformPreapprovalWebhook).
 */
export async function createPlatformCheckout(
  personalId: number,
  plan: PersonalPlan,
  opts: { payerEmail: string; frontendUrl: string }
): Promise<{ initPoint: string }> {
  const priceCents = PLAN_PRICING_CENTS[plan];
  if (!priceCents) {
    const e = new Error('Plano não cobrável (free é grátis)');
    (e as any).code = 'PLAN_NOT_BILLABLE';
    throw e;
  }

  const token = MP_TOKEN();
  if (!token) {
    const e = new Error('Pagamento indisponível no momento');
    (e as any).code = 'PAYMENTS_UNAVAILABLE';
    throw e;
  }

  // Registra/atualiza a linha como 'pending' (ainda não pagou — gating segue Free).
  await pool.query(
    `INSERT INTO personal_platform_subscriptions
       (personal_id, plan, status, price_cents)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (personal_id) DO UPDATE SET
       plan        = EXCLUDED.plan,
       status      = 'pending',
       price_cents = EXCLUDED.price_cents,
       updated_at  = NOW()`,
    [personalId, plan, priceCents]
  );

  const startDate = new Date();
  startDate.setMinutes(startDate.getMinutes() + 5);

  const mpPayload = {
    reason: `MetaCore Personal — ${plan === 'pro' ? 'Pro' : 'Starter'}`,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: priceCents / 100,
      currency_id: 'BRL',
      start_date: startDate.toISOString(),
    },
    payer_email: opts.payerEmail,
    back_url: opts.frontendUrl,
    external_reference: `${PLATFORM_SUB_EXTERNAL_REF_PREFIX}${personalId}`,
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
      `UPDATE personal_platform_subscriptions SET mp_preapproval_id = $1, updated_at = NOW()
       WHERE personal_id = $2`,
      [mpId, personalId]
    );

    return { initPoint };
  } catch (err) {
    logger.error({ err, personalId, plan }, '[personalPlan] MP pre-approval failed');
    throw err;
  }
}

/**
 * Webhook do Mercado Pago para a assinatura SaaS do personal.
 * Roteado de routes/webhooks.ts pelo prefixo 'platform-sub:{personalId}'.
 * Idempotente: reaplica o estado correspondente ao status atual do MP.
 */
export async function handlePlatformPreapprovalWebhook(
  personalId: number,
  mpStatus: string,
  _payload: Record<string, unknown>
): Promise<void> {
  const r = await pool.query(
    `SELECT plan FROM personal_platform_subscriptions WHERE personal_id = $1`,
    [personalId]
  );
  if (r.rowCount === 0) return;
  const plan = (r.rows[0].plan as PersonalPlan) ?? 'pro';
  const defaults = PLAN_DEFAULTS[plan];

  if (mpStatus === 'authorized') {
    // Pagamento confirmado → ativa o plano pago por 1 mês.
    const periodEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE personal_platform_subscriptions SET
         status = 'active', student_limit = $2, ai_enabled = $3,
         current_period_end = $4, updated_at = NOW()
       WHERE personal_id = $1`,
      [personalId, defaults.studentLimit, defaults.aiEnabled, periodEnd]
    );
    return;
  }

  if (mpStatus === 'cancelled' || mpStatus === 'expired' || mpStatus === 'suspended') {
    // Deixou de pagar → reverte para Free (gating volta a Free via getPersonalPlan).
    await pool.query(
      `UPDATE personal_platform_subscriptions SET
         plan = 'free', status = 'cancelled', student_limit = $2,
         ai_enabled = $3, current_period_end = NULL, updated_at = NOW()
       WHERE personal_id = $1`,
      [personalId, PLAN_DEFAULTS.free.studentLimit, PLAN_DEFAULTS.free.aiEnabled]
    );
  }
}

export async function countActiveStudents(personalId: number): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM personal_student_assignments
     WHERE personal_id = $1 AND status = 'active'`,
    [personalId]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

export async function checkStudentLimitGate(
  personalId: number
): Promise<{ over: boolean; limit: number | null; current: number }> {
  const [config, current] = await Promise.all([
    getPersonalPlan(personalId),
    countActiveStudents(personalId),
  ]);

  if (config.studentLimit === null) {
    return { over: false, limit: null, current };
  }

  return { over: current >= config.studentLimit, limit: config.studentLimit, current };
}
