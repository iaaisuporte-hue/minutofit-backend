import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import pool from '../config/database';
import * as subscriptionService from '../services/subscriptionService';

const router = Router();

/**
 * Validates the Mercado Pago webhook signature.
 *
 * MP sends:
 *   x-signature: ts=<timestamp>,v1=<HMAC-SHA256-hex>
 *   x-request-id: <uuid>
 *
 * Signed template: id:<query data.id>;request-id:<x-request-id>;ts:<timestamp>
 *
 * Returns true when:
 *  - MERCADOPAGO_WEBHOOK_SECRET is not set AND NODE_ENV != production (dev skip with warning)
 *  - Signature matches
 *
 * Returns false (reject) when:
 *  - MERCADOPAGO_WEBHOOK_SECRET is not set AND NODE_ENV == production
 *  - x-signature header is missing or malformed
 *  - HMAC does not match
 */
function validateMercadoPagoSignature(req: Request): boolean {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[webhook] MERCADOPAGO_WEBHOOK_SECRET not set in production — rejecting request');
      return false;
    }
    console.warn('[webhook] MERCADOPAGO_WEBHOOK_SECRET not set — skipping signature check (non-production)');
    return true;
  }

  const xSignature = req.headers['x-signature'] as string | undefined;
  const xRequestId = req.headers['x-request-id'] as string | undefined;

  if (!xSignature) {
    return false;
  }

  // Parse "ts=...,v1=..." into { ts: '...', v1: '...' }
  const sigParts: Record<string, string> = {};
  for (const part of xSignature.split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      sigParts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }

  const ts = sigParts['ts'];
  const v1 = sigParts['v1'];

  if (!ts || !v1) {
    return false;
  }

  // data.id comes from query param (MP sends ?data.id=... on the notification URL)
  // Fall back to body.data.id for older integrations
  const dataId =
    (req.query['data.id'] as string | undefined) ||
    (req.body?.data?.id != null ? String(req.body.data.id) : undefined);

  const templateParts: string[] = [];
  if (dataId) templateParts.push(`id:${dataId}`);
  if (xRequestId) templateParts.push(`request-id:${xRequestId}`);
  templateParts.push(`ts:${ts}`);

  const signedString = templateParts.join(';');
  const expected = crypto.createHmac('sha256', secret).update(signedString).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}

// POST /webhooks/mercadopago - Handle Mercado Pago webhook
router.post('/mercadopago', async (req: Request, res: Response) => {
  if (!validateMercadoPagoSignature(req)) {
    console.warn('[webhook] Rejected request with invalid or missing Mercado Pago signature', {
      ip: req.ip,
      xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'],
    });
    return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
  }

  try {
    const { type, data } = req.body;

    console.log('Mercado Pago webhook received:', { type, data });

    if (type === 'payment') {
      await handlePaymentNotification(data);
    } else if (type === 'plan') {
      await handlePlanNotification(data);
    } else if (type === 'subscription') {
      await handleSubscriptionNotification(data);
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Webhook error:', error);
    // Still return 200 to prevent Mercado Pago from retrying on processing errors
    res.json({ success: true, error: error.message });
  }
});

async function handlePaymentNotification(data: any) {
  try {
    const paymentId = data.id;
    const status = data.status;

    console.log(`Payment ${paymentId} status: ${status}`);

    const preapprovalId = data.preapproval_id;

    if (preapprovalId) {
      const result = await pool.query(
        `SELECT us.id, us.user_id, us.tier_id, st.name, st.price_brl
         FROM user_subscriptions us
         JOIN subscription_tiers st ON us.tier_id = st.id
         WHERE us.mercado_pago_subscription_id = $1`,
        [preapprovalId]
      );

      if (result.rows.length > 0) {
        const subscription = result.rows[0];

        await subscriptionService.recordPayment(
          subscription.user_id,
          subscription.id,
          paymentId,
          subscription.price_brl,
          status
        );

        if (status === 'approved') {
          await subscriptionService.updateUserSubscription(subscription.id, undefined, 'active');
        } else if (status === 'rejected' || status === 'cancelled') {
          await subscriptionService.updateUserSubscription(subscription.id, undefined, 'expired');
        }
      }
    }
  } catch (error) {
    console.error('Payment notification error:', error);
    throw error;
  }
}

async function handlePlanNotification(data: any) {
  console.log('Plan notification:', data);
}

async function handleSubscriptionNotification(data: any) {
  try {
    const preapprovalId = data.id;
    const status = data.status;

    console.log(`Subscription ${preapprovalId} status: ${status}`);

    const result = await pool.query(
      `SELECT id, user_id FROM user_subscriptions
       WHERE mercado_pago_subscription_id = $1`,
      [preapprovalId]
    );

    if (result.rows.length > 0) {
      const subscription = result.rows[0];

      let localStatus = 'active';
      if (status === 'authorized') {
        localStatus = 'active';
      } else if (status === 'cancelled') {
        localStatus = 'cancelled';
      } else if (status === 'suspended') {
        localStatus = 'expired';
      }

      await subscriptionService.updateUserSubscription(subscription.id, undefined, localStatus);
    }
  } catch (error) {
    console.error('Subscription notification error:', error);
    throw error;
  }
}

export default router;
