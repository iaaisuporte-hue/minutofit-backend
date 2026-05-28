import { Router, type Request, type Response } from 'express';
import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import {
  createConnectionRequest,
  acceptConnectionRequest,
  rejectConnectionRequest,
  cancelConnectionRequest,
  revokeConnection,
  listIncomingRequests,
  listOutgoingRequests,
  resolveProfessionalByIdentifier,
  expireStaleRequests,
} from '../services/connectionRequestService';
import {
  getAvailableProfessionalDetail,
  listAvailableProfessionals,
} from '../services/professionalNetworkService';
import {
  revokeConsent,
  listConsentsForUser,
  type ProfessionalRole,
  type ConsentScope,
} from '../services/consentService';
import { getAuditTrailForUser } from '../services/dataAccessAuditService';
import {
  cancelByStudent,
  createCheckout,
  listStudentSubscriptions,
} from '../services/professionalSubscriptionService';
import { listPublicOfferings } from '../services/professionalOfferingService';
import {
  upsertPushSubscription,
  removePushSubscription,
} from '../services/pushSubscriptionService';
import { listPendingVoiceNotesForPatient } from '../services/nutritionVoiceNoteService';
import pool from '../config/database';

const router = Router();
router.use(authMiddleware);

// ── Student endpoints ─────────────────────────────────────────────────────


/** Lista a Rede de Profissionais curada para o aluno */
router.get('/professional-network', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { role, limit } = req.query as { role?: string; limit?: string };
  const professionalRole = role && ['personal', 'nutri'].includes(role) ? role as ProfessionalRole : undefined;
  const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

  try {
    const result = await listAvailableProfessionals({
      academyId,
      professionalRole,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 403) return res.status(403).json({ success: false, error: e.message });
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

/** Detalhe de um profissional da Rede antes da solicitação */
router.get('/professional-network/:professionalId', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
  try {
    const result = await getAvailableProfessionalDetail({
      academyId,
      professionalId: parseInt(req.params.professionalId, 10),
    });
    if (!result.professional) return res.status(404).json({ success: false, error: 'professional_not_available' });
    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 403) return res.status(403).json({ success: false, error: e.message });
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

/** Busca profissional por email ou código para exibir preview antes de solicitar */
router.get('/resolve-professional', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { identifier, role } = req.query as { identifier?: string; role?: string };
  if (!identifier || !role || !['personal', 'nutri'].includes(role)) {
    return res.status(400).json({ error: 'identifier and role (personal|nutri) required' });
  }
  try {
    const pro = await resolveProfessionalByIdentifier(identifier, role as ProfessionalRole);
    if (!pro) return res.status(404).json({ error: 'professional_not_found' });
    return res.json({ id: pro.id, name: pro.name });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Aluno cria solicitação de vínculo */
router.post('/professional-requests', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const studentId = req.user!.id;

  const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;

  const {
    professionalId,
    professionalRole,
    requestedVia,
    message,
    scopes,
  } = req.body as {
    professionalId: number;
    professionalRole: ProfessionalRole;
    requestedVia: 'email' | 'code' | 'link' | 'discovery';
    message?: string;
    scopes?: ConsentScope[];
  };

  if (!professionalId || !professionalRole || !requestedVia) {
    return res.status(400).json({ error: 'professionalId, professionalRole and requestedVia are required' });
  }

  try {
    const request = await createConnectionRequest({
      studentId,
      professionalId,
      professionalRole,
      requestedVia,
      message,
      scopes,
      academyId,
      ip: req.ip,
    });
    return res.status(201).json({ success: true, data: request });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Aluno lista suas solicitações enviadas */
router.get('/professional-requests', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const requests = await listOutgoingRequests(req.user!.id);
    return res.json({ success: true, data: requests });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Aluno cancela solicitação pendente */
router.delete('/professional-requests/:id', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    await cancelConnectionRequest({
      requestId: req.params.id,
      studentId: req.user!.id,
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number };
    return res.status(e.status ?? 500).json({ error: 'not_found_or_not_pending' });
  }
});

/** Aluno revoga vínculo ativo com um profissional */
router.delete('/connections/:professionalId', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { role } = req.query as { role?: string };
  if (!role || !['personal', 'nutri'].includes(role)) {
    return res.status(400).json({ error: 'role query param required (personal|nutri)' });
  }
  try {
    await revokeConnection({
      studentId: req.user!.id,
      professionalId: parseInt(req.params.professionalId, 10),
      professionalRole: role as ProfessionalRole,
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number };
    return res.status(e.status ?? 500).json({ error: 'internal_error' });
  }
});

/** Aluno lista consentimentos com um profissional */
router.get('/consents/:professionalId', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { role } = req.query as { role?: string };
  if (!role || !['personal', 'nutri'].includes(role)) {
    return res.status(400).json({ error: 'role required (personal|nutri)' });
  }
  try {
    const consents = await listConsentsForUser(
      req.user!.id,
      parseInt(req.params.professionalId, 10),
      role as ProfessionalRole
    );
    return res.json({ success: true, data: consents });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Aluno revoga um escopo específico */
router.patch('/consents/:professionalId/revoke', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { role, scope } = req.body as { role?: ProfessionalRole; scope?: ConsentScope };
  if (!role || !scope) {
    return res.status(400).json({ error: 'role and scope required' });
  }
  try {
    await revokeConsent(req.user!.id, parseInt(req.params.professionalId, 10), role, scope, req.ip);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Aluno consulta trilha de auditoria dos próprios dados */
router.get('/audit/me', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const trail = await getAuditTrailForUser(req.user!.id, 50);
    return res.json({ success: true, data: trail });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Endpoint interno: expirar requests vencidos (pode ser chamado por cron ou admin) */
router.post('/admin/expire-requests', async (req: Request, res: Response) => {
  if (req.user?.role !== 'admin') return res.status(403).end();
  try {
    const expired = await expireStaleRequests();
    return res.json({ success: true, expired });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Student-visible offerings (US4 — leitura de planos do profissional) ──

/** Aluno lista planos ativos de um profissional específico antes do checkout */
router.get('/professionals/:professionalId/offerings', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const professionalId = parseInt(req.params.professionalId, 10);
  if (!Number.isFinite(professionalId)) {
    return res.status(400).json({ success: false, error: 'invalid_professional_id' });
  }
  try {
    const data = await listPublicOfferings(professionalId);
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ── Student subscriptions (US4 — checkout pago) ───────────────────────────

/** Aluno inicia checkout pago de uma offering profissional */
router.post('/subscriptions', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  const { offeringId } = req.body as { offeringId?: string };
  if (!offeringId) {
    return res.status(400).json({ success: false, error: 'validation_failed', details: { required: ['offeringId'] } });
  }
  try {
    const data = await createCheckout({
      studentId: req.user!.id,
      studentEmail: req.user!.email ?? '',
      offeringId,
      frontendUrl: process.env.FRONTEND_URL,
      ip: req.ip,
    });
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; details?: unknown };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error', details: e.details });
  }
});

/** Aluno lista suas próprias assinaturas */
router.get('/subscriptions', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const data = await listStudentSubscriptions(req.user!.id);
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

/** Aluno cancela própria assinatura */
router.delete('/subscriptions/:id', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const data = await cancelByStudent(req.params.id, req.user!.id, req.ip);
    return res.json({ success: true, data });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    return res.status(e.status ?? 500).json({ success: false, error: e.message ?? 'internal_error' });
  }
});

// ── Professional endpoints (personal/nutri) ────────────────────────────────

/** Personal lista requests recebidos */
router.get('/incoming-requests/personal', roleCheckMiddleware('personal'), requireProduct('personal'), async (req: Request, res: Response) => {
  const { status } = req.query as { status?: string };
  try {
    const validStatus = ['pending', 'accepted', 'rejected'].includes(status ?? '') ? status as 'pending' : 'pending';
    const requests = await listIncomingRequests(req.user!.id, validStatus);
    return res.json({ success: true, data: requests });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Nutri lista requests recebidos */
router.get('/incoming-requests/nutri', roleCheckMiddleware('nutri'), requireProduct('nutri'), async (req: Request, res: Response) => {
  const { status } = req.query as { status?: string };
  try {
    const validStatus = ['pending', 'accepted', 'rejected'].includes(status ?? '') ? status as 'pending' : 'pending';
    const requests = await listIncomingRequests(req.user!.id, validStatus);
    return res.json({ success: true, data: requests });
  } catch {
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** Profissional aceita request */
router.post('/incoming-requests/:id/accept', async (req: Request, res: Response) => {
  const role = req.user?.role;
  if (!role || !['personal', 'nutri'].includes(role)) {
    return res.status(403).json({ error: 'only personal or nutri can accept' });
  }
  try {
    await acceptConnectionRequest({
      requestId: req.params.id,
      professionalId: req.user!.id,
      professionalRole: role as ProfessionalRole,
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number };
    return res.status(e.status ?? 500).json({ error: 'not_found_or_not_pending' });
  }
});

/** Profissional recusa request */
router.post('/incoming-requests/:id/reject', async (req: Request, res: Response) => {
  const role = req.user?.role;
  if (!role || !['personal', 'nutri'].includes(role)) {
    return res.status(403).json({ error: 'only personal or nutri can reject' });
  }
  try {
    await rejectConnectionRequest({
      requestId: req.params.id,
      professionalId: req.user!.id,
      professionalRole: role as ProfessionalRole,
      rejectionReason: req.body.reason,
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number };
    return res.status(e.status ?? 500).json({ error: 'not_found_or_not_pending' });
  }
});

// ===========================================================================
// Push Subscriptions (Spec 005)
// ===========================================================================

router.post('/push-subscriptions', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { endpoint, p256dh, auth, deviceLabel } = req.body as {
      endpoint?: string; p256dh?: string; auth?: string; deviceLabel?: string;
    };
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ success: false, error: 'endpoint_p256dh_auth_required' });
    }
    await upsertPushSubscription(userId, { endpoint, p256dh, auth, deviceLabel });
    res.status(201).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/push-subscriptions', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const endpoint = typeof req.body.endpoint === 'string' ? req.body.endpoint : null;
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint_required' });
    await removePushSubscription(userId, endpoint);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===========================================================================
// Voice Notes — notas da nutri visíveis ao aluno (Spec 005)
// ===========================================================================

router.get('/voice-notes/pending', roleCheckMiddleware('user'), async (req: Request, res: Response) => {
  try {
    const patientId = req.user!.id;
    const notes = await listPendingVoiceNotesForPatient(patientId, req.ip);
    res.json({ success: true, data: notes });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
