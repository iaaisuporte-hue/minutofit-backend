import { Router, type Request, type Response } from 'express';
import pool from '../config/database';
import logger from '../lib/logger';

/**
 * Waitlist B2C (Spec 013) — endpoint PÚBLICO (pré-auth) de captura de interesse.
 *
 * Sem autenticação por design: é a borda de marketing B2C. Proteções:
 *  - valida formato e tamanho do e-mail (anti-lixo);
 *  - dedup por UNIQUE (ON CONFLICT DO NOTHING) → reinscrição é no-op idempotente;
 *  - rate limit in-memory por IP (defensivo; melhor esforço em multi-instância);
 *  - nunca loga o e-mail (PII) — só o resultado agregado.
 */
const router = Router();

// E-mail: regex conservadora + teto de tamanho (RFC permite 254).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MAX_FIELD_LEN = 120;

// Rate limit in-memory: máx 5 submissões por IP por janela de 10 min.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().slice(0, MAX_FIELD_LEN);
  return t.length > 0 ? t : null;
}

router.post('/', async (req: Request, res: Response) => {
  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
  if (rateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'too_many_requests' });
  }

  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    return res.status(400).json({ success: false, error: 'invalid_email' });
  }

  const source = clean(req.body?.source) ?? 'landing';
  const referral = clean(req.body?.referral);
  const interest = clean(req.body?.interest);

  try {
    await pool.query(
      `INSERT INTO b2c_waitlist (email, source, referral, interest)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [rawEmail, source, referral, interest],
    );
    // Resposta idêntica para inserção nova e duplicada — não vaza se o e-mail já existe.
    return res.status(201).json({ success: true });
  } catch (err) {
    logger.error({ err }, 'waitlist: insert failed');
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

export default router;
