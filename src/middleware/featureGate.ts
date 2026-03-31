import { NextFunction, Request, Response } from 'express';
import * as planFeatureService from '../services/planFeatureService';

const cache = new Map<string, { expiresAt: number; value: boolean }>();
const CACHE_TTL_MS = 60_000;

/** Plan feature gate, unless the user has one of these roles (e.g. personal trainers building plans for students). */
export function requireFeatureOrRoles(featureKey: string, bypassRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.user && bypassRoles.includes(req.user.role)) {
      return next();
    }
    const gate = requireFeature(featureKey);
    return gate(req, res, next);
  };
}

export function requireFeature(featureKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const cacheKey = `${req.user.id}:${featureKey}`;
      const now = Date.now();
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now) {
        if (hit.value) return next();
        return res.status(403).json({
          success: false,
          code: 'FEATURE_DISABLED_FOR_PLAN',
          error: `Feature ${featureKey} is not enabled for this plan`,
        });
      }

      const { plan, features } = await planFeatureService.getFeatureMapForUser(req.user.id);
      const enabled = Boolean(features[featureKey]);

      cache.set(cacheKey, { value: enabled, expiresAt: now + CACHE_TTL_MS });

      if (!enabled) {
        return res.status(403).json({
          success: false,
          code: 'FEATURE_DISABLED_FOR_PLAN',
          error: plan?.name ? `Disponivel em um plano superior ao ${plan.name}` : 'Feature indisponivel para o plano atual',
        });
      }

      next();
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to evaluate feature gate' });
    }
  };
}

