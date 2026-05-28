import pool from '../config/database';

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel?: string;
}

export async function upsertPushSubscription(
  userId: number,
  input: PushSubscriptionInput,
): Promise<void> {
  const { endpoint, p256dh, auth, deviceLabel = null } = input;
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id, endpoint)
     DO UPDATE SET p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth,
                   device_label = EXCLUDED.device_label,
                   updated_at = now()`,
    [userId, endpoint, p256dh, auth, deviceLabel],
  );
}

export async function removePushSubscription(
  userId: number,
  endpoint: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint],
  );
}
