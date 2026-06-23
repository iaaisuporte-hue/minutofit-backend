import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import pool from '../config/database';
import * as subscriptionService from '../services/subscriptionService';
import { handleMpPreapprovalWebhook } from '../services/personalBillingService';
import {
  handleMpPreapprovalWebhook as handleProNetworkPreapproval,
  PRO_NETWORK_EXTERNAL_REF_PREFIX,
} from '../services/professionalSubscriptionService';
import {
  handlePlatformPreapprovalWebhook,
  PLATFORM_SUB_EXTERNAL_REF_PREFIX,
} from '../services/personalPlanService';
import { grantMembership, cancelMembership } from '../services/membershipService';
import { getPreapprovalStatus } from '../services/mercadoPagoService';
import { logAcademyAction } from '../services/auditService';
import logger from '../lib/logger';

const router = Router();

/**
 * Auditoria persistente de mudança de membership disparada por webhook MP.
 * Antes esses grant/cancel por pagamento só deixavam log efêmero do pino —
 * impossível reconstruir "por que esse usuário ganhou/perdeu acesso".
 * logAcademyAction é fire-and-forget e nunca propaga erro.
 */
function auditMpMembership(
  userId: number,
  action: 'product.grant' | 'product.revoke',
  meta: Record<string, unknown>
) {
  logAcademyAction({ academyId: null, userId, action, entityType: 'product', meta });
}

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
      logger.error('[webhook] MERCADOPAGO_WEBHOOK_SECRET not set in production — rejecting request');
      return false;
    }
    logger.warn('[webhook] MERCADOPAGO_WEBHOOK_SECRET not set — skipping signature check (non-production)');
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
    logger.warn({ ip: req.ip, xSignature: req.headers['x-signature'], xRequestId: req.headers['x-request-id'] }, '[webhook] Rejected request with invalid or missing Mercado Pago signature');
    return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
  }

  try {
    const { type, data } = req.body;

    logger.info({ type, data }, 'Mercado Pago webhook received');

    if (type === 'payment') {
      await handlePaymentNotification(data);
    } else if (type === 'plan') {
      await handlePlanNotification(data);
    } else if (type === 'subscription' || type === 'subscription_preapproval' || type === 'preapproval') {
      await handleSubscriptionNotification(data);
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, 'Webhook error');
    // Devolve 500 para o Mercado Pago re-tentar. Os handlers são idempotentes
    // (UPSERT/UPDATE determinístico), então o retry é seguro — e necessário:
    // antes devolvíamos 200 e perdíamos ativações em falhas transitórias
    // (ex.: erro de rede ao buscar o preapproval ou DB momentâneo).
    res.status(500).json({ success: false });
  }
});

async function handlePaymentNotification(data: any) {
  try {
    const paymentId = data.id;
    const status = data.status;

    logger.info({ paymentId, status }, 'Payment notification');

    const preapprovalId = data.preapproval_id;

    if (preapprovalId) {
      const result = await pool.query(
        `SELECT us.id, us.user_id, us.tier_id, us.academy_id, st.name, st.price_brl
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
          status,
          subscription.academy_id ?? null  // A6: stamp academy_id derived from user_subscriptions
        );

        if (status === 'approved') {
          await subscriptionService.updateUserSubscription(subscription.id, undefined, 'active');
          // Sync APP membership
          await grantMembership(subscription.user_id, 'app', {
            planId: subscription.tier_id ?? null,
            metadata: { source: 'mp_payment_approved', mp_preapproval_id: preapprovalId, payment_id: paymentId },
          }).catch((err) => logger.error({ err }, '[webhook] grantMembership app failed'));
          auditMpMembership(subscription.user_id, 'product.grant', { productKey: 'app', via: 'mp_payment', paymentId, mpStatus: status });
        } else if (status === 'rejected' || status === 'cancelled') {
          await subscriptionService.updateUserSubscription(subscription.id, undefined, 'expired');
          await cancelMembership(subscription.user_id, 'app', {
            reason: `mp_payment_${status}`,
          }).catch((err) => logger.error({ err }, '[webhook] cancelMembership app failed'));
          auditMpMembership(subscription.user_id, 'product.revoke', { productKey: 'app', via: 'mp_payment', paymentId, mpStatus: status });
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Payment notification error');
    throw error;
  }
}

async function handlePlanNotification(data: any) {
  logger.info({ data }, 'Plan notification');
}

async function handleSubscriptionNotification(data: any) {
  try {
    const preapprovalId = data?.id != null ? String(data.id) : undefined;
    if (!preapprovalId) {
      logger.warn({ data }, '[webhook] subscription notification without preapproval id — ignoring');
      return;
    }

    // O Mercado Pago envia apenas { id } nas notificações de preapproval —
    // `status` e `external_reference` NÃO chegam de forma confiável no corpo.
    // Sem buscar o objeto real na API, o roteamento (platform-sub:, etc.)
    // nunca casa e o plano nunca ativa (personal paga e fica preso em pending).
    let status = data?.status;
    let externalReference: string | undefined = data?.external_reference;
    if (!status || !externalReference) {
      const preapproval = await getPreapprovalStatus(preapprovalId);
      status = preapproval?.status ?? status;
      externalReference = preapproval?.external_reference ?? externalReference;
    }

    logger.info({ preapprovalId, status, externalReference }, 'Subscription notification');

    // Route personal-sub webhooks to the personal billing service
    if (externalReference?.startsWith('personal-sub:')) {
      await handleMpPreapprovalWebhook(preapprovalId, status, data);
      return;
    }

    // Route platform-sub webhooks (personal paga o plano SaaS) ao personalPlanService
    if (externalReference?.startsWith(PLATFORM_SUB_EXTERNAL_REF_PREFIX)) {
      const personalId = Number(externalReference.slice(PLATFORM_SUB_EXTERNAL_REF_PREFIX.length));
      if (Number.isFinite(personalId)) {
        await handlePlatformPreapprovalWebhook(personalId, status, data);
      }
      return;
    }

    // Route pro-net-sub webhooks to the professional network subscription service
    if (externalReference?.startsWith(PRO_NETWORK_EXTERNAL_REF_PREFIX)) {
      await handleProNetworkPreapproval(preapprovalId, status, externalReference, data);
      return;
    }

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

      // Sync APP membership based on subscription status
      if (localStatus === 'active') {
        await grantMembership(subscription.user_id, 'app', {
          metadata: { source: 'mp_subscription', mp_preapproval_id: preapprovalId, mp_status: status },
        }).catch((err) => logger.error({ err }, '[webhook] grantMembership app (subscription) failed'));
        auditMpMembership(subscription.user_id, 'product.grant', { productKey: 'app', via: 'mp_subscription', preapprovalId, mpStatus: status });
      } else if (localStatus === 'cancelled' || localStatus === 'expired') {
        await cancelMembership(subscription.user_id, 'app', {
          reason: `mp_subscription_${status}`,
        }).catch((err) => logger.error({ err }, '[webhook] cancelMembership app (subscription) failed'));
        auditMpMembership(subscription.user_id, 'product.revoke', { productKey: 'app', via: 'mp_subscription', preapprovalId, mpStatus: status });
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Subscription notification error');
    throw error;
  }
}

export default router;
