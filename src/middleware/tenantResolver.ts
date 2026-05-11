import { Request, Response, NextFunction } from 'express';
import pool from '../config/database';

/** Slugs that are reserved system subdomains and must never map to an academy. */
const RESERVED_SLUGS = new Set([
  'app', 'www', 'api', 'admin', 'cdn', 'static', 'assets',
  'mail', 'dev', 'staging', 'test', 'localhost',
]);

const SLUG_REGEX = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.minutofit\.com\.br$/i;

export interface TenantHost {
  slug: string;
  academyId: number;
  subdomainStatus: string;
}

declare global {
  namespace Express {
    interface Request {
      tenantHost?: TenantHost;
    }
  }
}

// Simple in-memory LRU-style cache: slug → { academyId, status, expiresAt }
interface CacheEntry {
  academyId: number;
  subdomainStatus: string;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function getFromCache(slug: string): CacheEntry | null {
  const entry = cache.get(slug);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(slug);
    return null;
  }
  return entry;
}

function setCache(slug: string, entry: Omit<CacheEntry, 'expiresAt'>): void {
  // Keep cache from growing unbounded (simple eviction: clear if > 500 entries)
  if (cache.size >= 500) cache.clear();
  cache.set(slug, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Extracts academy context from the Host header.
 * Populates req.tenantHost when request comes from a known academy subdomain.
 * Does NOT authenticate — safe to use on public routes.
 */
export async function tenantResolverMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    const match = SLUG_REGEX.exec(host);

    if (!match) {
      return next();
    }

    const slug = match[1].toLowerCase();
    if (RESERVED_SLUGS.has(slug)) {
      return next();
    }

    // Check cache first
    const cached = getFromCache(slug);
    if (cached) {
      if (cached.subdomainStatus === 'active') {
        req.tenantHost = { slug, academyId: cached.academyId, subdomainStatus: cached.subdomainStatus };
      }
      return next();
    }

    // Resolve from DB
    const result = await pool.query(
      `SELECT id, subdomain_status FROM academies WHERE slug = $1 AND status != 'cancelled' LIMIT 1`,
      [slug]
    );

    if (result.rows.length === 0) {
      setCache(slug, { academyId: -1, subdomainStatus: 'not_found' });
      return next();
    }

    const row = result.rows[0];
    const subdomainStatus: string = row.subdomain_status ?? 'active';
    setCache(slug, { academyId: row.id, subdomainStatus });

    if (subdomainStatus === 'active') {
      req.tenantHost = { slug, academyId: row.id, subdomainStatus };
    }

    return next();
  } catch (err) {
    // Non-fatal: if resolver fails, continue without tenant context
    console.error('[tenantResolver] error:', err);
    return next();
  }
}

/** Validate a slug is not reserved. Returns error message or null. */
export function validateReservedSlug(slug: string): string | null {
  const normalized = String(slug).trim().toLowerCase();
  if (RESERVED_SLUGS.has(normalized)) {
    return `Slug "${normalized}" é reservado e não pode ser usado para uma academia.`;
  }
  return null;
}

/** Invalidate a slug in the resolver cache (call after subdomain_status change). */
export function invalidateTenantCache(slug: string): void {
  cache.delete(slug.toLowerCase());
}
