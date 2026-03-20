import { Router, Request, Response } from 'express';
import pool from '../config/database';
import * as subscriptionService from '../services/subscriptionService';

const router = Router();

// POST /webhooks/mercadopago - Handle Mercado Pago webhook
router.post('/mercadopago', async (req: Request, res: Response) => {
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
    // Still return 200 to prevent Mercado Pago from retrying
    res.json({ success: true, error: error.message });
  }
});

async function handlePaymentNotification(data: any) {
  try {
    const paymentId = data.id;
    const status = data.status;

    console.log(`Payment ${paymentId} status: ${status}`);

    // Find the preapproval/subscription this payment belongs to
    const preapprovalId = data.preapproval_id;

    if (preapprovalId) {
      // Find user subscription with this Mercado Pago ID
      const result = await pool.query(
        `SELECT us.id, us.user_id, us.tier_id, st.name, st.price_brl
         FROM user_subscriptions us
         JOIN subscription_tiers st ON us.tier_id = st.id
         WHERE us.mercado_pago_subscription_id = $1`,
        [preapprovalId]
      );

      if (result.rows.length > 0) {
        const subscription = result.rows[0];

        // Record payment
        await subscriptionService.recordPayment(
          subscription.user_id,
          subscription.id,
          paymentId,
          subscription.price_brl,
          status
        );

        // Update subscription status based on payment
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
  // Handle plan updates if needed
  console.log('Plan notification:', data);
}

async function handleSubscriptionNotification(data: any) {
  try {
    const preapprovalId = data.id;
    const status = data.status;

    console.log(`Subscription ${preapprovalId} status: ${status}`);

    // Find and update subscription
    const result = await pool.query(
      `SELECT id, user_id FROM user_subscriptions
       WHERE mercado_pago_subscription_id = $1`,
      [preapprovalId]
    );

    if (result.rows.length > 0) {
      const subscription = result.rows[0];

      // Map Mercado Pago statuses to our statuses
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
