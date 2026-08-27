import { Router, Request, Response, RequestHandler } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { requireFeature } from '../middleware/featureGate';
import { requirePhysicalActivityClearance } from '../middleware/requirePhysicalActivityClearance';
import { createRateLimiter } from '../lib/rateLimiter';
import { getReadinessLensToday } from '../modules/readiness/readiness.service';
import { PersonalPrescriptionSource } from '../modules/training/adaptive/personal.source';
import { adaptWorkoutDay, assertSafeAdaptation } from '../modules/training/adaptive/adaptation.transformer';
import type { AdaptationPolicy } from '../modules/training/adaptive/types';
import { DEFAULT_POLICY } from '../modules/training/adaptive/types';
import pool from '../config/database';
import logger from '../lib/logger';
import { logDataAccessEvent } from '../services/dataAccessAuditService';
import {
  createSession,
  listSessions,
  listSessionsPage,
  decodeSessionCursor,
  getSession,
  getWorkoutStats,
  sanitizeClientKey,
} from '../services/workoutSessionService';
import { dayKey } from '../utils/appDay';
import { registerNumericParams } from '../middleware/numericParam';
import { parseId, parseLimit, parseOptionalIndex } from '../utils/parseId';

const router = Router();
registerNumericParams(router, ['id']);
router.use(authMiddleware, requireProduct('app'));

const personalSource = new PersonalPrescriptionSource();

router.get('/today', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const planId = req.query.planId ? parseInt(req.query.planId as string, 10) : undefined;
    const dayIndex = req.query.dayIndex ? parseInt(req.query.dayIndex as string, 10) : undefined;

    // Load today's prescribed plan day
    const day = await personalSource.loadTodayDay(userId, planId, dayIndex);
    if (!day) {
      return res.status(404).json({ success: false, error: 'no_active_plan' });
    }

    // Load readiness lens (null = no check-in today)
    const readiness = await getReadinessLensToday(userId);

    // Resolve adaptation policy
    const policy = await personalSource.resolvePolicy(day, userId);

    let adaptedItems = day.items;
    let changes: ReturnType<typeof adaptWorkoutDay>['changes'] = [];
    let recoverySuggestion: ReturnType<typeof adaptWorkoutDay>['recoverySuggestion'] = null;
    let policyVersion = policy.version;
    let adaptationEnabled = policy.masterEnabled && readiness !== null;

    if (readiness && policy.masterEnabled) {
      try {
        const result = adaptWorkoutDay(day.items, readiness.level, policy);
        assertSafeAdaptation(day.items, result.adaptedItems);
        adaptedItems = result.adaptedItems;
        changes = result.changes;
        recoverySuggestion = result.recoverySuggestion;
        policyVersion = result.policyVersion;

        // Persist adaptation log (upsert — idempotent for the day)
        if (day.sourceRef.planId && day.responsibleParty.kind === 'personal') {
          void upsertAdaptationLog({
            studentId: userId,
            personalId: day.responsibleParty.personalId,
            academyId: day.academyId,
            planId: day.sourceRef.planId,
            dayIndex: day.sourceRef.dayIndex,
            readinessLevel: readiness.level,
            readinessFactors: readiness.factors,
            policy,
            originalItems: day.items,
            adaptedItems: result.adaptedItems,
            changes: result.changes,
          }).catch(err => logger.error({ err }, '[adaptive] upsert log error'));

          // Audit event (fire-and-forget)
          if (changes.length > 0) {
            void logDataAccessEvent({
              actorId: userId,
              subjectUserId: userId,
              eventType: 'training.adaptation.applied',
              eventPayload: {
                planId: day.sourceRef.planId,
                dayIndex: day.sourceRef.dayIndex,
                level: readiness.level,
                changesCount: changes.length,
                policyVersion,
              },
            }).catch(() => {});
          }
        }
      } catch (err) {
        // Safety guard tripped — serve original, log error
        logger.error({ err }, '[adaptive] assertSafeAdaptation failed — serving original plan');
        adaptedItems = day.items;
        changes = [];
        recoverySuggestion = null;
        adaptationEnabled = false;
      }
    }

    const originalPlanDay = { index: day.sourceRef.dayIndex, name: day.name, focus: day.focus, items: day.items };
    const adaptedPlanDay = { index: day.sourceRef.dayIndex, name: day.name, focus: day.focus, items: adaptedItems };

    return res.json({
      success: true,
      data: {
        readiness,
        adaptationEnabled,
        originalPlanDay,
        adaptedPlanDay,
        changes,
        recoverySuggestion,
        policyVersion,
      },
    });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /today error');
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// Frontend UX events — allow-list only, actorId = subjectUserId = self
const ALLOWED_FRONTEND_EVENTS = new Set<string>([
  'training.adaptation.viewed',
  // Onda P6 — o aluno pode seguir o original. Medir as duas escolhas é o que
  // permite saber se o ajuste ajuda ou atrapalha; só uma delas seria viés.
  'training.adaptation.accepted',
  'training.adaptation.declined',
]);

router.post('/events', async (req: Request, res: Response) => {
  const { eventType, payload = {} } = req.body ?? {};
  if (typeof eventType !== 'string' || !ALLOWED_FRONTEND_EVENTS.has(eventType)) {
    return res.status(400).json({ success: false, error: 'unknown_event' });
  }
  void logDataAccessEvent({
    actorId: req.user!.id,
    subjectUserId: req.user!.id,
    eventType: eventType as 'training.adaptation.viewed',
    eventPayload: typeof payload === 'object' && payload !== null ? payload : {},
    ip: req.ip,
  }).catch(() => {});
  return res.json({ success: true });
});

// ── Execução real do treino (Spec 010) ──────────────────────────────────────
// O cliente envia a ORIGEM do treino; a natureza retroativa (source
// 'user_retroactive') é stampada pelo servidor (Spec 024), não aceita do cliente.
const VALID_SOURCES = new Set(['personal', 'suggested', 'academy', 'free', 'movement_lab']);
const VALID_STATUS = new Set(['started', 'completed', 'partial', 'abandoned']);
// Caps de anti-abuso (P0-5). Um dia de treino real dificilmente passa de ~40
// exercícios; cada um expande no máximo 12 séries no servidor → 200 cobre folga.
const MAX_PRESCRIBED_ITEMS = 40;
const MAX_SET_LOGS = 200;
const RETRO_WINDOW_DAYS = 3;

// Registro retroativo (Spec 024): kill-switch por feature + teto de 3/24h por
// usuário. Só incide quando o payload traz `performedAt` — o fluxo ao vivo passa
// reto, sem regressão de comportamento.
const retroFeatureGate = requireFeature('retro_workout_enabled');
const retroRateLimiter = createRateLimiter({
  storeKey: 'retro_workout',
  keyFn: (req) => `user:${req.user!.id}`,
  limit: 3,
  windowSeconds: 24 * 3600,
  errorMessage: 'Limite de registros retroativos atingido. Tente novamente mais tarde.',
});
const retroOnly = (mw: RequestHandler): RequestHandler => (req, res, next) =>
  req.body?.performedAt != null ? mw(req, res, next) : next();

const utcDayMs = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/**
 * Valida o payload retroativo ANTES do rate limiter.
 *
 * O limitador (3/24h) rodava primeiro e contava tentativa rejeitada: quem errava
 * a data duas vezes — ano errado no seletor, por exemplo — queimava a cota do dia
 * e recebia "Limite de registros retroativos atingido" tendo registrado ZERO
 * treinos. A janela retroativa é de 3 dias, então perder a cota é perder o treino.
 *
 * O resultado fica em `res.locals` para o handler não revalidar.
 */
const validateRetroPayload: RequestHandler = (req, res, next) => {
  const raw = req.body?.performedAt;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return res.status(400).json({ success: false, error: 'invalid_performed_at' });
  }
  // Âncora ao meio-dia UTC: não vira de dia ao fazer ::date em nenhum fuso.
  const anchored = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(anchored.getTime())) {
    return res.status(400).json({ success: false, error: 'invalid_performed_at' });
  }
  // "Hoje" no fuso do aluno — em UTC, um treino salvo às 22h (BRT) já contava
  // como do dia anterior e exigia confirmação de honestidade sem motivo.
  const diffDays = Math.round((utcDayMs(dayKey()) - utcDayMs(raw)) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) {
    return res.status(400).json({ success: false, error: 'performed_at_in_future' });
  }
  if (diffDays > RETRO_WINDOW_DAYS) {
    return res.status(400).json({ success: false, error: 'retro_window_exceeded' });
  }
  // Aceite de honestidade obrigatório server-side (não confiar só na UI).
  if (diffDays >= 1 && req.body?.confirmedHonesty !== true) {
    return res.status(400).json({ success: false, error: 'honesty_confirmation_required' });
  }
  res.locals.retro = { performedAt: anchored, confirmationAccepted: req.body?.confirmedHonesty === true };
  return next();
};

// POST /api/training/sessions — registra a sessão executada (caminho rápido:
// só prescribed + status; ou detalhado: sets com carga/reps reais).
// Ordem importa: feature gate → validação → rate limiter. Só tentativa VÁLIDA
// consome cota.
// O gate de PAR-Q estava só no roteador do SPA (`RequireClearance`) — a API
// aceitava o registro de treino de quem não tinha liberação, enquanto
// `/activities` e `/movement/sessions` já barravam. Passa a valer nos três: com
// o PAR-Q agora gateando de verdade (P1-1), a brecha deixaria o aluno em estado
// `medical_clearance_required` registrando treino normalmente pela API.
router.post('/sessions', requirePhysicalActivityClearance(), retroOnly(retroFeatureGate), retroOnly(validateRetroPayload), retroOnly(retroRateLimiter), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const body = req.body ?? {};

    if (!VALID_SOURCES.has(body.source)) {
      return res.status(400).json({ success: false, error: 'invalid_source' });
    }
    if (!VALID_STATUS.has(body.status)) {
      return res.status(400).json({ success: false, error: 'invalid_status' });
    }

    // P0-5 da auditoria: caps de tamanho antes do INSERT em loop. O
    // express.json({limit:'1mb'}) global não impede milhares de itens pequenos.
    if (Array.isArray(body.prescribed) && body.prescribed.length > MAX_PRESCRIBED_ITEMS) {
      return res.status(400).json({ success: false, error: 'too_many_prescribed_items' });
    }
    if (Array.isArray(body.sets) && body.sets.length > MAX_SET_LOGS) {
      return res.status(400).json({ success: false, error: 'too_many_sets' });
    }

    // Modo retroativo (Spec 024): já validado por `validateRetroPayload`, que
    // roda antes do rate limiter. Ausência de performedAt = ao vivo.
    const retro = res.locals.retro as { performedAt: Date; confirmationAccepted: boolean } | undefined;
    const performedAt: Date | null = retro?.performedAt ?? null;
    const confirmationAccepted: boolean = retro?.confirmationAccepted ?? false;

    const result = await createSession(userId, academyId, {
      source: body.source,
      status: body.status,
      title: typeof body.title === 'string' ? body.title.slice(0, 200) : null,
      // `Number(null)` é 0 e `Number.isFinite(0)` é `true`: a coerção anterior
      // transformava o `planId: null` explícito do Treino Livre em `plan_id = 0`,
      // que estoura a FK de `personal_workout_plans` — 500 em 100% dos registros
      // livres (QA em navegador, ago/2026). O mesmo valia para `dayIndex`, que
      // gravava "dia 0" numa sessão sem ficha nenhuma.
      planId: parseId(body.planId),
      dayIndex: parseOptionalIndex(body.dayIndex),
      sessionRpe: body.sessionRpe ?? null,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null,
      prescribed: Array.isArray(body.prescribed) ? body.prescribed : [],
      sets: Array.isArray(body.sets) ? body.sets : undefined,
      awardGamification: body.awardGamification === true,
      muscleGroups: Array.isArray(body.muscleGroups) ? body.muscleGroups : undefined,
      performedAt,
      retroactiveReason: typeof body.retroactiveReason === 'string' ? body.retroactiveReason.slice(0, 280) : null,
      confirmationAccepted,
      // Chave de idempotência do treino livre. Lixo vira null: sem chave o
      // comportamento é o de sempre (nenhuma dedup), nunca um 400 que
      // descartaria um treino já feito.
      clientKey: sanitizeClientKey(body.clientKey),
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    // Defesa em profundidade: o serviço revalida a janela e lança códigos.
    if (err?.code === 'PERFORMED_AT_IN_FUTURE') {
      return res.status(400).json({ success: false, error: 'performed_at_in_future' });
    }
    if (err?.code === 'RETRO_WINDOW_EXCEEDED') {
      return res.status(400).json({ success: false, error: 'retro_window_exceeded' });
    }
    logger.error({ err }, '[training] POST /sessions error');
    return res.status(500).json({ success: false, error: 'Failed to register session' });
  }
});

// GET /api/training/sessions — histórico do aluno
//
// Dois formatos de resposta, por compatibilidade (Spec 033, P1):
//
//   sem `cursor`  → `data: [...]` (array cru), exatamente como sempre foi
//   com `cursor`  → `data: { sessions: [...], nextCursor }`
//
// Manter o array quando o parâmetro não vem é o que permite trocar a paginação
// sem coordenar deploy com o app: o cliente antigo continua funcionando, o novo
// pede `cursor=first` e recebe o envelope. `cursor=first` (em vez de omitir)
// é o opt-in explícito da primeira página do modo keyset.
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    // `?limit=' OR '1'='1` virava NaN e chegava ao LIMIT $n → 500
    // (QA 02/ago/2026, P2-7). Entrada inválida agora cai no default.
    const limit = parseLimit(req.query.limit, 50);
    const rawCursor = req.query.cursor;

    if (rawCursor === undefined) {
      const rows = await listSessions(req.user!.id, limit);
      return res.json({ success: true, data: rows });
    }

    // Cursor ilegível cai na primeira página em vez de 500: histórico é leitura,
    // e um link velho ou truncado deve mostrar o começo, não quebrar a aba.
    const before = rawCursor === 'first' ? null : decodeSessionCursor(rawCursor);
    const page = await listSessionsPage(req.user!.id, limit, before);
    return res.json({ success: true, data: page });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /sessions error');
    return res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
});

// GET /api/training/stats — frequência + progressão de carga por exercício
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getWorkoutStats(req.user!.id);
    return res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /stats error');
    return res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// GET /api/training/sessions/:id — detalhe (séries)
router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    // `parseInt` para no primeiro caractere inválido, então "1' OR '1'='1" e
    // "1e10" viravam o id 1 e devolviam a sessão 1. Não havia SQLi (a query é
    // parametrizada) nem IDOR (a busca é escopada por user_id), mas aceitar
    // lixo como identificador é ruído que esconde bug de cliente.
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'invalid_id' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_id' });
    }
    const session = await getSession(req.user!.id, id);
    if (!session) return res.status(404).json({ success: false, error: 'not_found' });
    return res.json({ success: true, data: session });
  } catch (err: any) {
    logger.error({ err }, '[training] GET /sessions/:id error');
    return res.status(500).json({ success: false, error: 'Failed to load session' });
  }
});

async function upsertAdaptationLog(params: {
  studentId: number;
  personalId: number;
  academyId: number | null;
  planId: number;
  dayIndex: number;
  readinessLevel: string;
  readinessFactors: unknown[];
  policy: AdaptationPolicy;
  originalItems: unknown[];
  adaptedItems: unknown[];
  changes: unknown[];
}): Promise<void> {
  const policySnapshot = {
    version: params.policy.version,
    masterEnabled: params.policy.masterEnabled,
    allowVolumeReduction: params.policy.allowVolumeReduction,
    allowRestIncrease: params.policy.allowRestIncrease,
    allowIntensityReduction: params.policy.allowIntensityReduction,
    allowActiveRecoverySubstitution: params.policy.allowActiveRecoverySubstitution,
    allowMobilitySuggestion: params.policy.allowMobilitySuggestion,
    maxSetReductionPct: params.policy.maxSetReductionPct,
    maxRestIncreasePct: params.policy.maxRestIncreasePct,
    minIntensityPct: params.policy.minIntensityPct,
  };

  await pool.query(
    `INSERT INTO workout_adaptation_log
       (student_id, personal_id, academy_id, plan_id, day_index, snapshot_date,
        readiness_level, readiness_factors, policy_version, policy_snapshot,
        original_payload, adapted_payload, changes)
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (student_id, plan_id, day_index, snapshot_date)
     DO UPDATE SET
       readiness_level   = EXCLUDED.readiness_level,
       readiness_factors = EXCLUDED.readiness_factors,
       policy_version    = EXCLUDED.policy_version,
       policy_snapshot   = EXCLUDED.policy_snapshot,
       adapted_payload   = EXCLUDED.adapted_payload,
       changes           = EXCLUDED.changes`,
    [
      params.studentId,
      params.personalId,
      params.academyId,
      params.planId,
      params.dayIndex,
      params.readinessLevel,
      JSON.stringify(params.readinessFactors),
      params.policy.version,
      JSON.stringify(policySnapshot),
      JSON.stringify(params.originalItems),
      JSON.stringify(params.adaptedItems),
      JSON.stringify(params.changes),
    ],
  );
}

export default router;
