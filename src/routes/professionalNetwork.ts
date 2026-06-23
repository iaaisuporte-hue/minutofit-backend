import { Router, type NextFunction, type Request, type Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import {
  getOwnNetworkProfile,
  submitOwnNetworkProfileForReview,
  unpublishOwnNetworkProfile,
  upsertOwnNetworkProfile,
  type AvailabilityStatus,
} from '../services/professionalNetworkService';
import type { ProfessionalRole } from '../services/consentService';
import {
  archiveOffering,
  createOffering,
  listOwnOfferings,
  updateOffering,
  type OfferingPeriod,
} from '../services/professionalOfferingService';
import {
  cancelByProfessional,
  listProfessionalSubscriptions,
} from '../services/professionalSubscriptionService';

const router = Router();

router.use(authMiddleware, roleCheckMiddleware('personal', 'nutri'));

function productForRole(req: Request, res: Response, next: NextFunction) {
  const role = req.user!.role as ProfessionalRole;
  return requireProduct(role)(req, res, next);
}

router.use(productForRole);

router.get('/network-profile', async (req: Request, res: Response) => {
  try {
    const profile = await getOwnNetworkProfile(req.user!.id);
    return res.json({ success: true, data: profile });
  } catch {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

router.put('/network-profile', async (req: Request, res: Response) => {
  const role = req.user!.role as ProfessionalRole;
  const body = req.body as {
    credentialCode?: string;
    displayName?: string;
    bio?: string | null;
    photoUrl?: string | null;
    specialties?: string[];
    metabolicFocus?: string | null;
    modality?: 'in_person' | 'online' | 'hybrid' | null;
    city?: string | null;
    stateUf?: string | null;
    availabilityStatus?: AvailabilityStatus;
  };

  try {
    const profile = await upsertOwnNetworkProfile({
      professionalId: req.user!.id,
      input: {
        professionalRole: role,
        credentialCode: body.credentialCode ?? '',
        displayName: body.displayName ?? req.user!.email ?? 'Profissional S2Core',
        bio: body.bio,
        photoUrl: body.photoUrl,
        specialties: body.specialties,
        metabolicFocus: body.metabolicFocus,
        modality: body.modality,
        city: body.city,
        stateUf: body.stateUf,
        availabilityStatus: body.availabilityStatus,
      },
    });
    return res.json({ success: true, data: profile });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

router.post('/network-profile/publish', async (req: Request, res: Response) => {
  try {
    const profile = await submitOwnNetworkProfileForReview(req.user!.id);
    return res.json({ success: true, data: profile });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

router.post('/network-profile/unpublish', async (req: Request, res: Response) => {
  try {
    const profile = await unpublishOwnNetworkProfile(req.user!.id);
    return res.json({ success: true, data: profile });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

// Keep old route alias for compatibility
router.post('/network-profile/submit-review', async (req: Request, res: Response) => {
  try {
    const profile = await submitOwnNetworkProfileForReview(req.user!.id);
    return res.json({ success: true, data: profile });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

// ---------------------------------------------------------------------------
// Offerings — planos comerciais (US4)
// ---------------------------------------------------------------------------

router.get('/offerings', async (req: Request, res: Response) => {
  try {
    const data = await listOwnOfferings(req.user!.id);
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

router.post('/offerings', async (req: Request, res: Response) => {
  const role = req.user!.role as ProfessionalRole;
  const body = req.body as {
    title?: string;
    description?: string | null;
    priceCents?: number;
    period?: OfferingPeriod;
  };
  try {
    if (!body.title || body.priceCents == null || !body.period) {
      return res.status(400).json({ success: false, error: 'validation_failed', details: { required: ['title', 'priceCents', 'period'] } });
    }
    const data = await createOffering({
      professionalId: req.user!.id,
      professionalRole: role,
      input: {
        title: body.title,
        description: body.description ?? null,
        priceCents: body.priceCents,
        period: body.period,
      },
      ip: req.ip,
    });
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

router.patch('/offerings/:id', async (req: Request, res: Response) => {
  const body = req.body as {
    title?: string;
    description?: string | null;
    priceCents?: number;
    period?: OfferingPeriod;
  };
  try {
    const data = await updateOffering({
      offeringId: req.params.id,
      professionalId: req.user!.id,
      input: body,
      ip: req.ip,
    });
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

router.post('/offerings/:id/archive', async (req: Request, res: Response) => {
  try {
    const data = await archiveOffering({
      offeringId: req.params.id,
      professionalId: req.user!.id,
      ip: req.ip,
    });
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// Subscriptions — visão do profissional (US4)
// ---------------------------------------------------------------------------

router.get('/subscriptions', async (req: Request, res: Response) => {
  try {
    const data = await listProfessionalSubscriptions(req.user!.id);
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

router.post('/subscriptions/:id/cancel', async (req: Request, res: Response) => {
  try {
    const data = await cancelByProfessional(req.params.id, req.user!.id, req.ip);
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

export default router;
