import { Router, Request, Response } from 'express';
import { authMiddleware, blockAccessProfilesMiddleware } from '../middleware/auth';
import * as subscriptionService from '../services/subscriptionService';
import * as mercadoPagoService from '../services/mercadoPagoService';

const router = Router();

// GET /subscriptions/tiers - Get all subscription tiers
router.get('/tiers', async (req: Request, res: Response) => {
  try {
    const tiers = await subscriptionService.getSubscriptionTiers();

    res.json({
      success: true,
      data: { tiers }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /subscriptions/current - Get current user's subscription
router.get('/current', authMiddleware, blockAccessProfilesMiddleware('clientes_sb'), async (req: Request, res: Response) => {
  try {
    const subscription = await subscriptionService.getUserSubscriptionWithTierInfo(req.user!.id);

    res.json({
      success: true,
      data: { subscription }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /subscriptions/create-checkout - Create Mercado Pago checkout
router.post('/create-checkout', authMiddleware, blockAccessProfilesMiddleware('clientes_sb'), async (req: Request, res: Response) => {
  try {
    const { tierId } = req.body;

    if (!tierId) {
      return res.status(400).json({ success: false, error: 'tierId is required' });
    }

    // Get user data
    const userRes = await subscriptionService.getUserSubscriptionWithTierInfo(req.user!.id);
    if (!userRes) {
      // Get user email from context (you'll need to pass this through)
      // For now, we'll need to fetch it
      return res.status(400).json({ success: false, error: 'User not found' });
    }

    // Get tier details
    const tiers = await subscriptionService.getSubscriptionTiers();
    const selectedTier = tiers.find(t => t.id === tierId);

    if (!selectedTier) {
      return res.status(404).json({ success: false, error: 'Subscription tier not found' });
    }

    if (selectedTier.priceBrl === 0) {
      return res.status(400).json({ success: false, error: 'Cannot checkout free tier' });
    }

    // Create Mercado Pago preapproval
    const { preapprovalId, initPoint } = await mercadoPagoService.createPreapprovalSubscription(
      req.user!.id,
      selectedTier.name,
      selectedTier.priceBrl,
      req.user!.email
    );

    res.json({
      success: true,
      data: {
        preapprovalId,
        checkoutUrl: initPoint
      }
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /subscriptions/cancel - Cancel user's subscription
router.post('/cancel', authMiddleware, blockAccessProfilesMiddleware('clientes_sb'), async (req: Request, res: Response) => {
  try {
    const subscription = await subscriptionService.getUserSubscription(req.user!.id);

    if (!subscription) {
      return res.status(404).json({ success: false, error: 'No active subscription found' });
    }

    // Cancel Mercado Pago preapproval if exists
    if (subscription.mercadoPagoSubscriptionId) {
      await mercadoPagoService.cancelPreapproval(subscription.mercadoPagoSubscriptionId);
    }

    // Cancel local subscription
    const cancelled = await subscriptionService.cancelUserSubscription(subscription.id);

    res.json({
      success: true,
      data: { subscription: cancelled }
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

export default router;
