import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from './redisClient';
import logger from './logger';

interface MemEntry {
  count: number;
  resetAt: number; // epoch ms
}

// One Map per storeKey so different limiters don't collide in memory
const _memStores = new Map<string, Map<string, MemEntry>>();

function memStore(storeKey: string): Map<string, MemEntry> {
  let store = _memStores.get(storeKey);
  if (!store) {
    store = new Map();
    _memStores.set(storeKey, store);
  }
  return store;
}

function checkMemory(store: Map<string, MemEntry>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

async function checkRedis(redisKey: string, limit: number, windowSeconds: number): Promise<boolean | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, windowSeconds);
    return count <= limit;
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[rateLimiter] redis error — using in-memory fallback');
    return null;
  }
}

export interface RateLimiterOptions {
  /** Unique name for this limiter's in-memory store (e.g. 'nutri_obs'). */
  storeKey: string;
  /** Derives the per-request bucket key from the request. */
  keyFn: (req: Request) => string;
  /** Max requests allowed within the window. */
  limit: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /** Message returned in the 429 response. */
  errorMessage?: string;
}

/**
 * Returns an Express middleware that enforces a rate limit.
 * Uses Redis when available; falls back to per-process in-memory map.
 */
export function createRateLimiter(opts: RateLimiterOptions) {
  const { storeKey, keyFn, limit, windowSeconds, errorMessage } = opts;
  const windowMs = windowSeconds * 1000;
  const message = errorMessage ?? `Rate limit exceeded. Max ${limit} requests per ${windowSeconds}s.`;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const key = `rl:${storeKey}:${keyFn(req)}`;
      const redisResult = await checkRedis(key, limit, windowSeconds);
      const allowed = redisResult !== null
        ? redisResult
        : checkMemory(memStore(storeKey), key, limit, windowMs);

      if (!allowed) {
        res.set('Retry-After', String(windowSeconds));
        return res.status(429).json({ error: 'rate_limit_exceeded', message });
      }
      next();
    } catch (err) {
      // Fail open: rate limit error should never bring the endpoint down
      logger.error({ err }, '[rateLimiter] unexpected error — request allowed');
      next();
    }
  };
}
