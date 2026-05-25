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

export default router;
