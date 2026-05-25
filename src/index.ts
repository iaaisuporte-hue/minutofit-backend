import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/node';
import pinoHttp from 'pino-http';

import logger from './lib/logger';
import authRoutes from './routes/auth';
import subscriptionRoutes from './routes/subscriptions';
import webhookRoutes from './routes/webhooks';
import adminRoutes from './routes/admin';
import gamificationRoutes from './routes/gamification';
import messagesRoutes from './routes/messages';
import personalRoutes from './routes/personal';
import videoRoutes from './routes/videos';
import exercisesRoutes from './routes/exercises';
import activitiesRoutes from './routes/activities';
import movementRoutes from './routes/movement';
import planRoutes from './routes/plans';
import metabolismRoutes from './modules/metabolism/metabolic.controller';
import academyRoutes from './routes/academy';
import nutriRoutes from './routes/nutri';
import userRoutes from './routes/user';
import metabolicCheckinRoutes from './routes/metabolicCheckins';
import studentTeamRoutes from './routes/studentTeam';
import professionalNetworkRoutes from './routes/professionalNetwork';
import { tenantResolverMiddleware } from './middleware/tenantResolver';
import pool from './config/database';

// --- DB schema boot chain (fully sequential, deterministic order) ---
import { ensureUsersCoreColumns } from './db/ensureUsersCoreColumns';
import { ensureComplianceSchema } from './db/ensureComplianceSchema';
import { ensurePlanFeaturesSchema } from './db/ensurePlanFeaturesSchema';
import { ensureMessagesSchema } from './db/ensureMessagesSchema';
import { ensurePersonalWorkoutPlansSchema } from './db/ensurePersonalWorkoutPlansSchema';
import { ensureWorkoutReviewsSchema } from './db/ensureWorkoutReviewsSchema';
import { ensurePersonalDashboardIndexes } from './db/ensurePersonalDashboardIndexes';
import { ensureUsersMetabolismColumns } from './db/ensureUsersMetabolismColumns';
import { ensureMetabolismSchema } from './db/ensureMetabolismSchema';
import { ensureDailyCheckinSignalsSchema } from './db/ensureDailyCheckinSignalsSchema';
import { ensureRevokedTokensSchema } from './db/ensureRevokedTokensSchema';
import { ensureActivitySessionsSchema } from './db/ensureActivitySessionsSchema';
import { ensureMovementSessionsSchema } from './db/ensureMovementSessionsSchema';
import { ensureAcademiesSchema } from './db/ensureAcademiesSchema';
import { seedDefaultAcademy } from './db/seedDefaultAcademy';
import { ensureStudentsSchema } from './db/ensureStudentsSchema';
import { ensureReceptionSchema } from './db/ensureReceptionSchema';
import { ensureTenantColumnsPhase2 } from './db/ensureTenantColumnsPhase2';
import { backfillTenantColumns } from './db/backfillTenantColumns';
import { ensureTenantColumnsPhase2Lock } from './db/ensureTenantColumnsPhase2Lock';
import { relaxAcademyIdNullable } from './db/relaxAcademyIdNullable';
import { ensurePersonalDirectInvitesSchema } from './db/ensurePersonalDirectInvitesSchema';
import { ensureStudentExerciseNotesSchema } from './db/ensureStudentExerciseNotesSchema';
import { ensureWorkoutProtocolsSchema } from './db/ensureWorkoutProtocolsSchema';
// ensureProtocolBackfill mantido apenas como CLI (script:backfill-protocols).
// Removido do boot para não ressuscitar fichas órfãs como protocolos.
import { ensureExercisesSchema } from './db/ensureExercisesSchema';
import { seedExercisesIfEmpty } from './db/seedExercisesIfEmpty';
import { ensureProductsSchema } from './db/ensureProductsSchema';
import { backfillUserProducts } from './db/backfillUserProducts';
import { scheduleDataRetention } from './jobs/dataRetention';
import { getRedisClient } from './lib/redisClient';
import { runMigrations } from './db/runMigrations';

// ---------------------------------------------------------------------------
// Sentry — inicializa antes de qualquer middleware
// ---------------------------------------------------------------------------
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
  });
  logger.info('[sentry] initialized');
}

// ---------------------------------------------------------------------------
// DB schema boot — ÚNICO cadeia sequencial, ordem determinística
// Cada passo logado com tempo decorrido para diagnóstico de cold start.
// ---------------------------------------------------------------------------
async function runBootChain(): Promise<void> {
  await runMigrations();

  const steps: Array<[string, () => Promise<unknown>]> = [
    ['ensureUsersCoreColumns', ensureUsersCoreColumns],
    ['ensureComplianceSchema', ensureComplianceSchema],
    ['ensurePlanFeaturesSchema', ensurePlanFeaturesSchema],
    ['ensureMessagesSchema', ensureMessagesSchema],
    ['ensurePersonalWorkoutPlansSchema', ensurePersonalWorkoutPlansSchema],
    ['ensureWorkoutReviewsSchema', ensureWorkoutReviewsSchema],
    ['ensurePersonalDashboardIndexes', ensurePersonalDashboardIndexes],
    ['ensureUsersMetabolismColumns', ensureUsersMetabolismColumns],
    ['ensureMetabolismSchema', ensureMetabolismSchema],
    ['ensureDailyCheckinSignalsSchema', ensureDailyCheckinSignalsSchema],
    ['ensureRevokedTokensSchema', ensureRevokedTokensSchema],
    ['ensureActivitySessionsSchema', ensureActivitySessionsSchema],
    ['ensureMovementSessionsSchema', ensureMovementSessionsSchema],
    ['ensureAcademiesSchema', ensureAcademiesSchema],
    ['seedDefaultAcademy', seedDefaultAcademy],
    ['ensureStudentsSchema', ensureStudentsSchema],
    ['ensureReceptionSchema', ensureReceptionSchema],
    ['ensureTenantColumnsPhase2', ensureTenantColumnsPhase2],
    ['backfillTenantColumns', backfillTenantColumns],
    ['ensureTenantColumnsPhase2Lock', ensureTenantColumnsPhase2Lock],
    ['relaxAcademyIdNullable', relaxAcademyIdNullable],
    ['ensurePersonalDirectInvitesSchema', ensurePersonalDirectInvitesSchema],
    ['ensureStudentExerciseNotesSchema', ensureStudentExerciseNotesSchema],
    ['ensureWorkoutProtocolsSchema', ensureWorkoutProtocolsSchema],
    // ensureProtocolBackfill removido do boot (mai/2026): recriava protocolos
    // a partir de fichas órfãs no banco, conflitando com a intenção do personal
    // de ter excluído o protocolo. CLI ainda disponível via `npm run script:backfill-protocols`.
    ['ensureExercisesSchema', ensureExercisesSchema],
    ['seedExercisesIfEmpty', seedExercisesIfEmpty],
    ['ensureProductsSchema', ensureProductsSchema],
    ['backfillUserProducts', backfillUserProducts],
  ];

  const totalStart = Date.now();
  for (const [name, fn] of steps) {
    const t = Date.now();
    try {
      await fn();
      logger.info({ step: name, ms: Date.now() - t }, '[boot] schema ok');
    } catch (err) {
      logger.error({ step: name, err }, '[boot] schema error — continuing');
      Sentry.captureException(err, { tags: { boot_step: name } });
    }
  }
  logger.info({ total_ms: Date.now() - totalStart }, '[boot] schema chain complete');
}

void runBootChain();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

/**
 * Fronts conhecidos em produção. O header `Origin` do browser é só scheme + host (sem path).
 */
const BUNDLED_PRODUCTION_ORIGINS = [
  'https://minutofit.com.br',
  'https://www.minutofit.com.br',
  'https://minutofit-app.vercel.app',
];

function normalizeCorsOrigin(raw: string): string {
  const t = raw.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(t)) return t;
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
  } catch {
    return t;
  }
}

function parseAllowedOrigins() {
  const envOrigins = [process.env.FRONTEND_URL, process.env.FRONTEND_URLS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => normalizeCorsOrigin(origin))
    .filter(Boolean);

  return Array.from(
    new Set([
      ...BUNDLED_PRODUCTION_ORIGINS,
      ...envOrigins,
      'http://localhost:5173',
      'http://localhost:3000',
    ])
  );
}

const allowedOrigins = parseAllowedOrigins();
const vercelPreviewPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
const localDevOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
/** Anchored at both ends to prevent bypass via attacker.minutofit.com.br.evil.com */
const minutoFitSubdomainPattern = /^https:\/\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.minutofit\.com\.br$/i;

// --- Security headers (helmet) ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https:'],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// --- CORS ---
app.use(
  cors({
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Host'],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if ((process.env.NODE_ENV || 'development') !== 'production' && localDevOriginPattern.test(origin)) {
        callback(null, true);
        return;
      }

      if (
        allowedOrigins.includes(origin) ||
        vercelPreviewPattern.test(origin) ||
        minutoFitSubdomainPattern.test(origin)
      ) {
        callback(null, true);
        return;
      }

      logger.warn({ origin }, '[cors] blocked origin');
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// --- Structured request logging (pino-http) ---
app.use(
  pinoHttp({
    logger,
    // Attach a correlation ID to every request for tracing
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      if (typeof existing === 'string' && existing) return existing;
      return randomUUID();
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
    // Skip health checks from logs to reduce noise
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  })
);

// --- Body parsers — limit reduzido para 1 mb global ---
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Resolve academy context from Host header
app.use(tenantResolverMiddleware);

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
// Webhook payload maior para aceitar payloads do MercadoPago
app.use('/api/webhooks', express.json({ limit: '5mb' }), webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/personal', personalRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api', planRoutes);
app.use('/api', metabolismRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/movement', movementRoutes);
app.use('/api/academy', academyRoutes);
app.use('/api/nutri', nutriRoutes);
app.use('/api/user', userRoutes);
app.use('/api/metabolic-checkins', metabolicCheckinRoutes);
app.use('/api/student', studentTeamRoutes);
app.use('/api/professional', professionalNetworkRoutes);

// ---------------------------------------------------------------------------
// Health check real — valida DB e presença de secrets críticos
// Retorna 503 quando degradado (load balancer remove instância do pool)
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, 'ok' | 'fail'> = {};
  let healthy = true;

  // DB connectivity
  try {
    await pool.query('SELECT 1');
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
    healthy = false;
  }

  // Critical secrets
  checks.jwt_secret = process.env.JWT_SECRET ? 'ok' : 'fail';
  checks.jwt_refresh_secret = process.env.JWT_REFRESH_SECRET ? 'ok' : 'fail';
  if (checks.jwt_secret === 'fail' || checks.jwt_refresh_secret === 'fail') {
    healthy = false;
  }

  const status = healthy ? 200 : 503;
  res.status(status).json({
    success: healthy,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// --- Global error handler ---
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  Sentry.captureException(err);
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'MinutoFit Backend running');
  logger.info({ origins: allowedOrigins }, 'Allowed frontend origins');

  // Inicializa Redis (não bloqueia o boot — falha silenciosa com fallback in-memory)
  getRedisClient();

  // Job de retenção de dados — LGPD (executa 30s após boot, depois a cada 24h)
  scheduleDataRetention();
});
