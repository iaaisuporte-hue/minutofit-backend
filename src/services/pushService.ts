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
import { dayKey, minutesSinceMidnight } from '../utils/appDay';

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

  // SPEC 035 / NUTRI-08 e NUTRI-09: `getHours()` lia o relógio do PROCESSO
  // (UTC na Render, 3h à frente de Brasília) — a janela de disparo inteira
  // rodava adiantada. E `npm.id::uuid` nunca funcionou: `nutrition_plan_meals
  // .id` é `integer`; o cast lançava erro de tipo antes de qualquer linha,
  // então esta função NUNCA despachou um lembrete sequer (migration 1839
  // corrigiu `nutrition_meal_reminders.meal_id` para `integer`).
  const nowMin = minutesSinceMidnight(new Date());
  const windowEnd = nowMin + windowMinutes;
  const today = dayKey();

  // Meals due in [nowMin, windowEnd], not yet dispatched today, not already checked-in
  const { rows: dueMeals } = await pool.query(
    `SELECT npm.id AS meal_id, npm.name AS meal_name, npm.meal_time,
            np.patient_id, np.title AS plan_title
     FROM nutrition_plan_meals npm
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE np.status = 'active'
       AND npm.deleted_at IS NULL
       AND npm.meal_time IS NOT NULL
       AND EXTRACT(HOUR FROM npm.meal_time::time) * 60 + EXTRACT(MINUTE FROM npm.meal_time::time)
           BETWEEN $1 AND $2
       AND NOT EXISTS (
         SELECT 1 FROM nutrition_meal_reminders nmr
         WHERE nmr.patient_id = np.patient_id AND nmr.meal_id = npm.id
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
       VALUES ($1, $2, $3, now())
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

/**
 * Agrupa sinais de alunos em risco e envia UMA notificação por personal
 * em vez de N notificações separadas — princípio de agregação (Fase E).
 *
 * Regras:
 *  - Só dispara se houver ≥ 1 aluno com riskScore ≥ 55 no portfolio.
 *  - Máximo 1 disparo por personal por dia (dedup via data_access_audit).
 *  - Título varia conforme quantidade: "2 alunos precisam de atenção".
 */
export async function dispatchPersonalAtRiskAlerts(): Promise<{ dispatched: number; skipped: number }> {
  if (!init()) {
    logger.warn('[push] VAPID not configured — skipping personal at-risk alerts');
    return { dispatched: 0, skipped: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);

  // Personals com push subscription que ainda não receberam este alerta hoje
  const { rows: personals } = await pool.query<{ personal_id: number }>(
    `SELECT DISTINCT ps.user_id AS personal_id
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id AND u.role = 'personal'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_access_audit daa
       WHERE daa.actor_id = ps.user_id
         AND daa.event_type = 'push.personal_at_risk_alert'
         AND daa.created_at::date = $1::date
     )`,
    [today],
  );

  let dispatched = 0;
  let skipped = 0;

  for (const row of personals) {
    const personalId = row.personal_id;
    try {
      // Buscar alunos em risco deste personal agrupados em uma única query
      const { rows: atRisk } = await pool.query<{ name: string; risk_score: number }>(
        `SELECT name, risk_score FROM (
           SELECT u.name,
                  GREATEST(0, 100 - LEAST(100,
                    COALESCE(gs.current_streak, 0) * 2 +
                    (SELECT COUNT(*)::int FROM user_workout_logs uwl
                     WHERE uwl.user_id = u.id
                       AND uwl.completed_at >= NOW() - INTERVAL '7 days') * 5
                  )) AS risk_score
           FROM personal_student_assignments psa
           JOIN users u ON u.id = psa.student_id
           LEFT JOIN user_gamification_stats gs ON gs.user_id = u.id
           WHERE psa.personal_id = $1
             AND psa.status = 'active'
             AND u.role = 'user'
         ) scored
         WHERE risk_score >= 55
         ORDER BY risk_score DESC
         LIMIT 5`,
        [personalId],
      );

      if (atRisk.length === 0) {
        skipped++;
        continue;
      }

      const names = atRisk.slice(0, 3).map((r) => r.name.split(' ')[0]).join(', ');
      const count = atRisk.length;
      const title = count === 1 ? 'Aluno precisa de atenção' : `${count} alunos precisam de atenção`;
      const body = count === 1
        ? `${names} está com baixo engajamento. Um contato pode fazer diferença.`
        : `${names}${count > 3 ? ' e outros' : ''} — engajamento em queda. Veja o dashboard.`;

      await sendToUser(personalId, {
        title,
        body,
        tag: `personal-at-risk-${today}`,
      });

      await pool.query(
        `INSERT INTO data_access_audit (actor_id, subject_user_id, event_type, event_payload)
         VALUES ($1, $1, 'push.personal_at_risk_alert', $2)`,
        [personalId, JSON.stringify({ count, names: atRisk.map((r) => r.name) })],
      );
      dispatched++;
    } catch (err) {
      logger.warn({ err, personalId }, '[push] personal at-risk alert failed');
      skipped++;
    }
  }

  logger.info({ dispatched, skipped }, '[push] personal at-risk alerts dispatched');
  return { dispatched, skipped };
}
