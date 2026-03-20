import pool from '../config/database';

export interface SubscriptionTier {
  id: number;
  name: string;
  priceBrl: number;
  maxVideosPerMonth: number | null;
  features: any;
}

export interface UserSubscription {
  id: number;
  userId: number;
  tierId: number;
  status: 'active' | 'cancelled' | 'expired' | 'trial';
  mercadoPagoSubscriptionId?: string;
  trialEndsAt?: string;
  activeFrom: string;
  activeTo?: string;
}

export async function getSubscriptionTiers(): Promise<SubscriptionTier[]> {
  const result = await pool.query(
    `SELECT id, name, price_brl, max_videos_per_month, features FROM subscription_tiers ORDER BY price_brl`
  );

  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    priceBrl: row.price_brl,
    maxVideosPerMonth: row.max_videos_per_month,
    features: row.features
  }));
}

export async function getUserSubscription(userId: number): Promise<UserSubscription | null> {
  const result = await pool.query(
    `SELECT id, user_id, tier_id, status, mercado_pago_subscription_id, trial_ends_at, active_from, active_to
     FROM user_subscriptions
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapSubscriptionRow(result.rows[0]);
}

export async function getUserSubscriptionWithTierInfo(userId: number): Promise<any> {
  const result = await pool.query(
    `SELECT us.id, us.user_id, us.tier_id, us.status, st.name, st.price_brl, st.features,
            us.mercado_pago_subscription_id, us.trial_ends_at, us.active_from, us.active_to
     FROM user_subscriptions us
     JOIN subscription_tiers st ON us.tier_id = st.id
     WHERE us.user_id = $1 AND us.status = 'active'
     ORDER BY us.created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    userId: result.rows[0].user_id,
    tierId: result.rows[0].tier_id,
    status: result.rows[0].status,
    tierName: result.rows[0].name,
    price: result.rows[0].price_brl,
    features: result.rows[0].features,
    mercadoPagoSubscriptionId: result.rows[0].mercado_pago_subscription_id,
    trialEndsAt: result.rows[0].trial_ends_at,
    activeFrom: result.rows[0].active_from,
    activeTo: result.rows[0].active_to
  };
}

export async function createUserSubscription(
  userId: number,
  tierId: number,
  mercadoPagoSubscriptionId?: string
): Promise<UserSubscription> {
  const result = await pool.query(
    `INSERT INTO user_subscriptions (user_id, tier_id, status, mercado_pago_subscription_id, active_from)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     RETURNING id, user_id, tier_id, status, mercado_pago_subscription_id, trial_ends_at, active_from, active_to`,
    [userId, tierId, 'active', mercadoPagoSubscriptionId]
  );

  return mapSubscriptionRow(result.rows[0]);
}

export async function updateUserSubscription(
  subscriptionId: number,
  tierId?: number,
  status?: string,
  mercadoPagoSubscriptionId?: string
): Promise<UserSubscription> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (tierId !== undefined) {
    updates.push(`tier_id = $${paramCount}`);
    values.push(tierId);
    paramCount++;
  }

  if (status !== undefined) {
    updates.push(`status = $${paramCount}`);
    values.push(status);
    paramCount++;
  }

  if (mercadoPagoSubscriptionId !== undefined) {
    updates.push(`mercado_pago_subscription_id = $${paramCount}`);
    values.push(mercadoPagoSubscriptionId);
    paramCount++;
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(subscriptionId);

  const query = `UPDATE user_subscriptions SET ${updates.join(', ')} WHERE id = $${paramCount}
                 RETURNING id, user_id, tier_id, status, mercado_pago_subscription_id, trial_ends_at, active_from, active_to`;

  const result = await pool.query(query, values);

  if (result.rows.length === 0) {
    throw new Error('Subscription not found');
  }

  return mapSubscriptionRow(result.rows[0]);
}

export async function cancelUserSubscription(subscriptionId: number): Promise<UserSubscription> {
  return updateUserSubscription(subscriptionId, undefined, 'cancelled');
}

export async function recordPayment(
  userId: number,
  subscriptionId: number | null,
  mercadoPagoPaymentId: string,
  amountBrl: number,
  status: string
): Promise<void> {
  await pool.query(
    `INSERT INTO payments (user_id, subscription_id, mercado_pago_payment_id, amount_brl, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, subscriptionId, mercadoPagoPaymentId, amountBrl, status]
  );
}

export async function getAllActiveSubscriptions(): Promise<any[]> {
  const result = await pool.query(
    `SELECT us.id, us.user_id, u.email, u.name, st.name as tier_name, st.price_brl,
            us.status, us.active_from, us.active_to, us.created_at
     FROM user_subscriptions us
     JOIN users u ON us.user_id = u.id
     JOIN subscription_tiers st ON us.tier_id = st.id
     WHERE us.status = 'active'
     ORDER BY us.created_at DESC`
  );

  return result.rows;
}

function mapSubscriptionRow(row: any): UserSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    tierId: row.tier_id,
    status: row.status,
    mercadoPagoSubscriptionId: row.mercado_pago_subscription_id,
    trialEndsAt: row.trial_ends_at,
    activeFrom: row.active_from,
    activeTo: row.active_to
  };
}
