/**
 * Web Push dispatch — meal reminders (Spec 005 Onda B).
 *
 * Requires env vars:
 *   VAPID_PUBLIC_KEY   — base64url, generate with: npx web-push generate-vapid-keys
 *   VAPID_PRIVATE_KEY  — base64url
 *   VAPID_SUBJECT      — mailto: or https: URL
 *
 * Without those vars the service degrades silently (no push sent, no crash).
 */

import webpush from 'web-push';
import pool from '../config/database';
import logger from '../lib/logger';

let _initialized = false;

function init() {
  if (_initialized) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return false;
  webpush.setVapidDetails(subject, pub, priv);
  _initialized = true;
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export async function saveSubscription(
  userId: number,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  deviceLabel?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id, endpoint)
     DO UPDATE SET p256dh = $3, auth = $4, device_label = $5, updated_at = now()`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, deviceLabel ?? null],
  );
}

export async function removeSubscription(userId: number, endpoint: string): Promise<void> {
  await pool.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint],
  );
}

async function sendToUser(
  userId: number,
  payload: { title: string; body: string; tag?: string },
): Promise<void> {
  if (!init()) return;

  const { rows } = await pool.query(
    `SELECT id::text, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );
  if (rows.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  await Promise.allSettled(
    rows.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr,
        );
      } catch (err: any) {
        // 410 Gone = subscription expired, clean it up
        if (err?.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          logger.info({ userId, subId: sub.id }, '[push] removed expired subscription');
        } else {
          logger.warn({ err: err?.message, userId }, '[push] delivery failed');
        }
      }
    }),
  );
}

/**
 * Dispatch meal reminders for meals due in the next `windowMinutes` minutes.
 * Called by a cron-style endpoint (e.g. Render Cron Job every 5 min).
 * Records each dispatch in nutrition_meal_reminders to avoid duplicates.
 */
export async function dispatchMealReminders(windowMinutes = 30): Promise<{ dispatched: number }> {
  if (!init()) {
    logger.warn('[push] VAPID not configured — skipping meal reminder dispatch');
    return { dispatched: 0 };
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const windowEnd = nowMin + windowMinutes;
  const today = now.toISOString().slice(0, 10);

  // Meals due in [nowMin, windowEnd], not yet dispatched today, not already checked-in
  const { rows: dueMeals } = await pool.query(
    `SELECT npm.id AS meal_id, npm.name AS meal_name, npm.meal_time,
            np.patient_id, np.title AS plan_title
     FROM nutrition_plan_meals npm
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE np.status = 'active'
       AND npm.meal_time IS NOT NULL
       AND EXTRACT(HOUR FROM npm.meal_time::time) * 60 + EXTRACT(MINUTE FROM npm.meal_time::time)
           BETWEEN $1 AND $2
       AND NOT EXISTS (
         SELECT 1 FROM nutrition_meal_reminders nmr
         WHERE nmr.patient_id = np.patient_id AND nmr.meal_id = npm.id::uuid
           AND nmr.reminder_date = $3
       )
       AND NOT EXISTS (
         SELECT 1 FROM nutrition_meal_checkins nmc
         WHERE nmc.patient_id = np.patient_id AND nmc.meal_id = npm.id
           AND nmc.check_date = $3
       )`,
    [nowMin, windowEnd, today],
  );

  let dispatched = 0;
  for (const meal of dueMeals) {
    await sendToUser(meal.patient_id, {
      title: meal.plan_title,
      body: `Hora da refeição: ${meal.meal_name}`,
      tag: `meal-${meal.meal_id}-${today}`,
    });

    // Record dispatch to prevent duplicates
    await pool.query(
      `INSERT INTO nutrition_meal_reminders (patient_id, meal_id, reminder_date, sent_at)
       VALUES ($1, $2::uuid, $3, now())
       ON CONFLICT (patient_id, meal_id, reminder_date) DO NOTHING`,
      [meal.patient_id, meal.meal_id, today],
    );
    dispatched++;
  }

  if (dispatched > 0) {
    logger.info({ dispatched }, '[push] meal reminders dispatched');
  }
  return { dispatched };
}

/**
 * Dispatch check-in reminders for users who:
 *   - have at least one active adaptation policy (master_enabled = true)
 *   - have a push subscription
 *   - have NOT checked in today
 *   - have NOT already received this reminder today (dedup via data_access_audit)
 *
 * Intended to be called once per day via admin endpoint / Render Cron.
 */
export async function dispatchCheckinReminders(): Promise<{ dispatched: number; skipped: number }> {
  if (!init()) {
    logger.warn('[push] VAPID not configured — skipping check-in reminder dispatch');
    return { dispatched: 0, skipped: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT DISTINCT ps.user_id
     FROM push_subscriptions ps
     JOIN training_adaptation_policy tap
       ON tap.student_id = ps.user_id AND tap.master_enabled = TRUE
     WHERE NOT EXISTS (
       SELECT 1 FROM user_daily_checkins udc
       WHERE udc.user_id = ps.user_id AND udc.date_key = $1::date
     )
     AND NOT EXISTS (
       SELECT 1 FROM data_access_audit daa
       WHERE daa.actor_id = ps.user_id
         AND daa.event_type = 'push.checkin_reminder'
         AND daa.created_at::date = $1::date
     )`,
    [today],
  );

  let dispatched = 0;
  let skipped = 0;

  for (const row of rows) {
    const userId: number = row.user_id;
    try {
      await sendToUser(userId, {
        title: 'Treino adaptado esperando por você',
        body: 'Registre seu check-in e receba seu treino ajustado para como você está hoje.',
        tag: `checkin-reminder-${today}`,
      });

      await pool.query(
        `INSERT INTO data_access_audit (actor_id, subject_user_id, event_type, event_payload)
         VALUES ($1, $1, 'push.checkin_reminder', '{}')`,
        [userId],
      );
      dispatched++;
    } catch (err) {
      logger.warn({ err, userId }, '[push] check-in reminder failed');
      skipped++;
    }
  }

  logger.info({ dispatched, skipped }, '[push] check-in reminders dispatched');
  return { dispatched, skipped };
}
