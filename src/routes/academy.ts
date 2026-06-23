import { Router, Request, Response } from 'express';
import bcryptjs from 'bcryptjs';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { tenantContextMiddleware, requireTenantPermission } from '../middleware/tenantContext';
import {
  getTeam,
  addMemberDirect,
  createInvitation,
  getInvitations,
  revokeInvitation,
  updateMember,
} from '../services/academyTeamService';
import {
  listStudents,
  getStudent,
  addStudent,
  updateStudent,
  enrollStudent,
  pauseStudent,
  cancelStudent,
  reactivateStudent,
} from '../services/academyStudentService';
import {
  listPlans,
  createPlan,
  updatePlan,
  archivePlan,
} from '../services/academyPlanService';
import { auditLog } from '../utils/auditLog';
import { logAcademyAction, listAcademyAudit } from '../services/auditService';
import { listAcademyPayments, getAcademyFinanceKPIs } from '../services/academyFinanceService';
import {
  createVisitorAccess,
  getReceptionDashboard,
  getReceptionPanel,
  getReceptionStudentContext,
  logReceptionNotesViewed,
  registerStudentAccess,
  searchReceptionStudents,
  type ReceptionPanelApiKey,
} from '../services/academyReceptionService';
import { receptionStreamSubscribe } from '../services/receptionStream';
import { validateBrandingColor } from '../utils/contrastValidator';
import { calcPrimaryHover, calcPrimarySoft, calcCtaTextColor } from '../utils/colorContrast';
import { sanitizeBrandingText } from '../utils/htmlSanitize';
import pool from '../config/database';
import { getAcademyNetworkPolicy, upsertAcademyNetworkPolicy } from '../services/professionalNetworkService';

const ALLOWED_LOGO_ORIGINS = ['s3.amazonaws.com', 'corefit.com.br', 'cdn.corefit.com.br'];

function validateLogoUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return 'Logo URL deve usar HTTPS.';
    const isAllowed = ALLOWED_LOGO_ORIGINS.some((origin) => parsed.hostname.endsWith(origin));
    if (!isAllowed) return 'Logo deve estar hospedado no S2Core (S3 ou CDN).';
    return null;
  } catch {
    return 'Logo URL inválida.';
  }
}

const router = Router();

// Auth + produto Academia (claim no JWT) + tenant — alinhado ao ProductGate no frontend
router.use(authMiddleware, requireProduct('academia'), tenantContextMiddleware);


// ─── Rede de Profissionais ─────────────────────────────────────────────────

router.get(
  '/professional-network-policy',
  requireTenantPermission('academy.professionals.read'),
  async (req: Request, res: Response) => {
    try {
      const policy = await getAcademyNetworkPolicy(req.tenant!.academyId);
      return res.json({ success: true, data: policy });
    } catch {
      return res.status(500).json({ success: false, error: 'internal_error' });
    }
  }
);

router.put(
  '/professional-network-policy',
  requireTenantPermission('academy.professionals.write'),
  async (req: Request, res: Response) => {
    const { mode } = req.body as { mode?: string };
    if (!mode || !['allow', 'block'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be allow or block' });
    }

    try {
      const policy = await upsertAcademyNetworkPolicy({
        academyId: req.tenant!.academyId,
        mode: mode as 'allow' | 'block',
        actorId: req.user!.id,
        ip: req.ip,
      });
      return res.json({ success: true, data: policy });
    } catch {
      return res.status(500).json({ success: false, error: 'internal_error' });
    }
  }
);

// ─── Team ─────────────────────────────────────────────────────────────────────

// GET /academy/team
router.get(
  '/team',
  requireTenantPermission('academy.invitations.write'),
  async (req: Request, res: Response) => {
    try {
      const members = await getTeam(req.tenant!.academyId);
      res.json({ success: true, data: { members } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/team — add member (direct or invite)
router.post(
  '/team',
  requireTenantPermission('academy.invitations.write'),
  async (req: Request, res: Response) => {
    try {
      const { mode, roleSlug, name, email, cpf, phone } = req.body;
      const { academyId } = req.tenant!;

      if (!mode || !roleSlug || !email) {
        return res.status(400).json({ success: false, error: 'mode, roleSlug e email são obrigatórios.' });
      }

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

      if (mode === 'direct') {
        if (!name) return res.status(400).json({ success: false, error: 'name obrigatório para cadastro direto.' });
        const result = await addMemberDirect(academyId, req.user!.id, { roleSlug, name, email, cpf, phone });
        logAcademyAction({
          academyId,
          userId: req.user!.id,
          action: 'team.add_member',
          entityType: 'user',
          meta: { email, roleSlug, mode },
          ipAddress: req.ip,
        });
        return res.status(201).json({ success: true, data: result });
      }

      if (mode === 'invite') {
        const result = await createInvitation(academyId, req.user!.id, { roleSlug, email }, frontendUrl);
        logAcademyAction({
          academyId,
          userId: req.user!.id,
          action: 'invitation.create',
          entityType: 'invitation',
          meta: { email, roleSlug },
          ipAddress: req.ip,
        });
        return res.status(201).json({ success: true, data: result });
      }

      return res.status(400).json({ success: false, error: 'mode deve ser "direct" ou "invite".' });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// PATCH /academy/team/:userId — update member role or active status
router.patch(
  '/team/:userId',
  requireTenantPermission('academy.invitations.write'),
  async (req: Request, res: Response) => {
    try {
      const targetUserId = Number(req.params.userId);
      const { roleSlug, isActive } = req.body;
      await updateMember(req.tenant!.academyId, req.user!.id, targetUserId, { roleSlug, isActive });
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'team.role_update',
        entityType: 'user',
        entityId: targetUserId,
        meta: { roleSlug, isActive },
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// ─── Invitations ─────────────────────────────────────────────────────────────

// GET /academy/invitations
router.get(
  '/invitations',
  requireTenantPermission('academy.invitations.write'),
  async (req: Request, res: Response) => {
    try {
      const invitations = await getInvitations(req.tenant!.academyId);
      res.json({ success: true, data: { invitations } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// DELETE /academy/invitations/:id
router.delete(
  '/invitations/:id',
  requireTenantPermission('academy.invitations.write'),
  async (req: Request, res: Response) => {
    try {
      const invitationId = Number(req.params.id);
      await revokeInvitation(req.tenant!.academyId, req.user!.id, invitationId);
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'invitation.revoke',
        entityType: 'invitation',
        entityId: invitationId,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// ─── Branding ─────────────────────────────────────────────────────────────────

// GET /academy/branding
router.get(
  '/branding',
  requireTenantPermission('academy.branding'),
  async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT logo_url, display_name, primary_color, primary_hover, accent_color, welcome_message, theme
       FROM academy_branding WHERE academy_id = $1`,
      [req.tenant!.academyId]
    );

    const row = result.rows[0];
    const branding = row
      ? {
          logoUrl:        row.logo_url        ?? undefined,
          bannerUrl:      row.banner_url      ?? undefined,
          displayName:    row.display_name    ?? undefined,
          primaryColor:   row.primary_color   ?? undefined,
          primaryHover:   row.primary_hover   ?? undefined,
          primarySoft:    row.primary_soft    ?? undefined,
          secondaryColor: row.secondary_color ?? undefined,
          accentColor:    row.accent_color    ?? undefined,
          ctaTextColor:   row.cta_text_color  ?? undefined,
          welcomeMessage: row.welcome_message ?? undefined,
          theme:          row.theme           ?? 'default',
        }
      : null;

    res.json({ success: true, data: { branding } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /academy/branding
router.put(
  '/branding',
  requireTenantPermission('academy.branding'),
  async (req: Request, res: Response) => {
    try {
      const { displayName, primaryColor, secondaryColor, accentColor, welcomeMessage, theme, logoUrl, bannerUrl } = req.body;

      // Sanitize text fields
      const safeDisplayName    = sanitizeBrandingText(displayName, 100);
      const safeWelcomeMessage = sanitizeBrandingText(welcomeMessage, 200);

      // Validate logo/banner URLs
      if (logoUrl) {
        const err = validateLogoUrl(String(logoUrl));
        if (err) return res.status(400).json({ success: false, error: err });
      }
      if (bannerUrl) {
        const err = validateLogoUrl(String(bannerUrl));
        if (err) return res.status(400).json({ success: false, error: err });
      }

      // Validate colors (WCAG AA)
      if (primaryColor) {
        const err = validateBrandingColor(primaryColor, 'Cor primária', 4.5);
        if (err) return res.status(400).json({ success: false, error: err });
      }
      if (secondaryColor) {
        const err = validateBrandingColor(secondaryColor, 'Cor secundária', 4.5);
        if (err) return res.status(400).json({ success: false, error: err });
      }
      if (accentColor) {
        const err = validateBrandingColor(accentColor, 'Cor de destaque', 3.0);
        if (err) return res.status(400).json({ success: false, error: err });
      }

      const allowedThemes = ['default', 'dark', 'light'];
      if (theme && !allowedThemes.includes(theme)) {
        return res.status(400).json({ success: false, error: `theme inválido. Permitidos: ${allowedThemes.join(', ')}.` });
      }

      // Auto-calculate derived tokens from primary color
      const derivedHover    = primaryColor ? calcPrimaryHover(primaryColor)   : null;
      const derivedSoft     = primaryColor ? calcPrimarySoft(primaryColor)    : null;
      const derivedCtaText  = primaryColor ? calcCtaTextColor(primaryColor)   : null;

      await pool.query(
        `INSERT INTO academy_branding
           (academy_id, display_name, logo_url, banner_url, primary_color, primary_hover, primary_soft,
            secondary_color, accent_color, cta_text_color, welcome_message, theme, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (academy_id) DO UPDATE
           SET display_name    = COALESCE(EXCLUDED.display_name,    academy_branding.display_name),
               logo_url        = COALESCE(EXCLUDED.logo_url,        academy_branding.logo_url),
               banner_url      = COALESCE(EXCLUDED.banner_url,      academy_branding.banner_url),
               primary_color   = COALESCE(EXCLUDED.primary_color,   academy_branding.primary_color),
               primary_hover   = COALESCE(EXCLUDED.primary_hover,   academy_branding.primary_hover),
               primary_soft    = COALESCE(EXCLUDED.primary_soft,    academy_branding.primary_soft),
               secondary_color = COALESCE(EXCLUDED.secondary_color, academy_branding.secondary_color),
               accent_color    = COALESCE(EXCLUDED.accent_color,    academy_branding.accent_color),
               cta_text_color  = COALESCE(EXCLUDED.cta_text_color,  academy_branding.cta_text_color),
               welcome_message = COALESCE(EXCLUDED.welcome_message, academy_branding.welcome_message),
               theme           = COALESCE(EXCLUDED.theme,           academy_branding.theme),
               updated_at      = NOW()`,
        [
          req.tenant!.academyId,
          safeDisplayName    ?? null,
          logoUrl            ?? null,
          bannerUrl          ?? null,
          primaryColor       ?? null,
          derivedHover       ?? null,
          derivedSoft        ?? null,
          secondaryColor     ?? null,
          accentColor        ?? null,
          derivedCtaText     ?? null,
          safeWelcomeMessage ?? null,
          theme              ?? null,
        ]
      );

      await auditLog(pool, {
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'branding.updated',
        meta: { primaryColor, secondaryColor, accentColor },
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─── Students ─────────────────────────────────────────────────────────────────

// GET /academy/students/search?q=
router.get(
  '/students/search',
  requireTenantPermission('academy.students.read'),
  async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q ?? '');
      const limit = req.query.limit ? Number(req.query.limit) : 8;
      const students = await searchReceptionStudents(req.tenant!.academyId, q, limit);
      res.json({ success: true, data: { students } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /academy/students
router.get(
  '/students',
  requireTenantPermission('academy.students.read'),
  async (req: Request, res: Response) => {
    try {
      const { status, q, unitId, page, pageSize, atRisk, filter } = req.query as Record<string, string>;
      const atRiskFlag =
        atRisk === '1' ||
        atRisk === 'true' ||
        String(filter).toLowerCase() === 'at_risk';
      const result = await listStudents(req.tenant!.academyId, {
        status:   status || undefined,
        q:        q || undefined,
        unitId:   unitId ? Number(unitId) : undefined,
        page:     page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
        atRisk:   atRiskFlag,
      });
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students
router.post(
  '/students',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const {
        mode, name, email, cpf, phone, birthDate, avatarUrl,
        unitId, planId, startDate,
        paymentMethod, mainGoal, medicalRestrictions,
        emergencyContactName, emergencyContactPhone,
        acceptedTerms, acceptedLgpd,
        giveAppBonus,
      } = req.body;
      if (!mode || !email) {
        return res.status(400).json({ success: false, error: 'mode e email são obrigatórios.' });
      }
      const result = await addStudent(req.tenant!.academyId, req.user!.id, {
        mode, name, email, cpf, phone, birthDate, avatarUrl,
        unitId: unitId ? Number(unitId) : undefined,
        planId: planId ? Number(planId) : undefined,
        startDate,
        paymentMethod, mainGoal, medicalRestrictions,
        emergencyContactName, emergencyContactPhone,
        acceptedTerms: !!acceptedTerms, acceptedLgpd: !!acceptedLgpd,
        // Default: conceder App como bônus (true). Frontend pode enviar false
        // para desligar (caso a academia opte por não incluir o app).
        giveAppBonus: giveAppBonus === undefined ? true : !!giveAppBonus,
      });
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'student.enroll',
        entityType: 'user',
        meta: { mode, email },
        ipAddress: req.ip,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// GET /academy/students/:userId/reception-context
router.get(
  '/students/:userId/reception-context',
  requireTenantPermission('academy.recepcao.dashboard'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId inválido.' });
      }
      const data = await getReceptionStudentContext(req.tenant!.academyId, userId);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/recepcao/student-notes-audit  { studentUserId }
router.post(
  '/recepcao/student-notes-audit',
  requireTenantPermission('academy.recepcao.dashboard'),
  async (req: Request, res: Response) => {
    try {
      const studentUserId = Number(req.body.studentUserId);
      if (!studentUserId) {
        return res.status(400).json({ success: false, error: 'studentUserId é obrigatório.' });
      }
      await logReceptionNotesViewed({
        academyId: req.tenant!.academyId,
        actorUserId: req.user!.id,
        studentUserId,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// GET /academy/recepcao/panel/:panelKey?page=1&pageSize=10&q=
router.get(
  '/recepcao/panel/:panelKey',
  requireTenantPermission('academy.recepcao.dashboard'),
  async (req: Request, res: Response) => {
    try {
      const raw = String(req.params.panelKey ?? '');
      const allowed: ReceptionPanelApiKey[] = [
        'occupancyNow',
        'accessToday',
        'overdueStudents',
        'birthdaysToday',
        'exceptionsToday',
        'deniedToday',
        'newStudents7d',
      ];
      if (raw === 'observability' || !allowed.includes(raw as ReceptionPanelApiKey)) {
        return res.status(400).json({ success: false, error: 'Painel inválido.' });
      }
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 10)));
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const data = await getReceptionPanel(req.tenant!.academyId, raw as ReceptionPanelApiKey, page, pageSize, q);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /academy/recepcao/stream  (SSE — opt-in via RECEPCAO_SSE_ENABLED)
router.get(
  '/recepcao/stream',
  requireTenantPermission('academy.recepcao.dashboard'),
  (req: Request, res: Response) => {
    if (process.env.RECEPCAO_SSE_ENABLED !== 'true') {
      return res.status(503).json({ success: false, error: 'SSE desativado no servidor.' });
    }
    const academyId = req.tenant!.academyId;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();
    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = receptionStreamSubscribe(academyId, send);
    const hb = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);
    const maxTimer = setTimeout(() => {
      clearInterval(hb);
      unsubscribe();
      res.end();
    }, 5 * 60 * 1000);
    req.on('close', () => {
      clearInterval(hb);
      clearTimeout(maxTimer);
      unsubscribe();
    });
  }
);

// GET /academy/students/:userId
router.get(
  '/students/:userId',
  requireTenantPermission('academy.students.read'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      const student = await getStudent(req.tenant!.academyId, userId);
      res.json({ success: true, data: student });
    } catch (err: any) {
      // Return 404 to prevent IDOR leakage
      res.status(404).json({ success: false, error: 'Aluno não encontrado.' });
    }
  }
);

// PATCH /academy/students/:userId
router.patch(
  '/students/:userId',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      const { studentStatus, unitId, notes } = req.body;
      await updateStudent(req.tenant!.academyId, req.user!.id, userId, { studentStatus, unitId, notes });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students/:userId/enroll
router.post(
  '/students/:userId/enroll',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      const { planId, startDate, notes } = req.body;
      if (!planId) return res.status(400).json({ success: false, error: 'planId é obrigatório.' });
      const enrollment = await enrollStudent(req.tenant!.academyId, req.user!.id, userId, {
        planId: Number(planId), startDate, notes,
      });
      res.status(201).json({ success: true, data: enrollment });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students/:userId/pause
router.post(
  '/students/:userId/pause',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const pausedId = Number(req.params.userId);
      await pauseStudent(req.tenant!.academyId, req.user!.id, pausedId);
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'student.pause',
        entityType: 'user',
        entityId: pausedId,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students/:userId/cancel
router.post(
  '/students/:userId/cancel',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const canceledId = Number(req.params.userId);
      await cancelStudent(req.tenant!.academyId, req.user!.id, canceledId);
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'student.cancel',
        entityType: 'user',
        entityId: canceledId,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students/:userId/reactivate
router.post(
  '/students/:userId/reactivate',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const reactivatedId = Number(req.params.userId);
      await reactivateStudent(req.tenant!.academyId, req.user!.id, reactivatedId);
      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId: req.user!.id,
        action: 'student.reactivate',
        entityType: 'user',
        entityId: reactivatedId,
        ipAddress: req.ip,
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/students/:userId/reset-password
router.post(
  '/students/:userId/reset-password',
  requireTenantPermission('academy.students.write'),
  async (req: Request, res: Response) => {
    try {
      const targetId = Number(req.params.userId);

      // Generate a readable temporary password: word + 4-digit number
      const words = ['Treino', 'Forca', 'Saude', 'Ativo', 'Fit', 'Move'];
      const word  = words[Math.floor(Math.random() * words.length)];
      const num   = String(Math.floor(1000 + Math.random() * 9000));
      const tempPassword = `${word}${num}`;
      const hashed = await bcryptjs.hash(tempPassword, 10);

      // CTE atômica: valida vínculo ativo (academy_student) e atualiza senha no mesmo statement.
      // Se o aluno foi removido entre validação e update, RETURNING retorna 0 linhas → 404.
      const resetResult = await pool.query(
        `WITH ok AS (
           SELECT au.user_id
           FROM academy_users au
           JOIN academy_roles ar ON ar.id = au.role_id
           WHERE au.user_id = $1 AND au.academy_id = $2
             AND au.is_active = TRUE AND au.status = 'active'
             AND ar.slug = 'academy_student'
         )
         UPDATE users SET password = $3, must_change_password = TRUE
          WHERE id IN (SELECT user_id FROM ok)
         RETURNING id`,
        [targetId, req.tenant!.academyId, hashed]
      );
      if (resetResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Aluno não encontrado nesta academia.' });
      }

      logAcademyAction({
        academyId: req.tenant!.academyId,
        userId:    req.user!.id,
        action:    'student.password_reset',
        entityType: 'user',
        entityId:  targetId,
        ipAddress: req.ip,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, tempPassword });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─── Plans ─────────────────────────────────────────────────────────────────────

// GET /academy/plans
router.get(
  '/plans',
  requireTenantPermission('academy.plans.read'),
  async (req: Request, res: Response) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const plans = await listPlans(req.tenant!.academyId, includeArchived);
      res.json({ success: true, data: { plans } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/plans
router.post(
  '/plans',
  requireTenantPermission('academy.plans.write'),
  async (req: Request, res: Response) => {
    try {
      const { name, description, monthlyPrice, billingCycleDays } = req.body;
      if (!name || monthlyPrice == null) {
        return res.status(400).json({ success: false, error: 'name e monthlyPrice são obrigatórios.' });
      }
      const plan = await createPlan(req.tenant!.academyId, req.user!.id, {
        name, description, monthlyPrice: Number(monthlyPrice),
        billingCycleDays: billingCycleDays ? Number(billingCycleDays) : undefined,
      });
      res.status(201).json({ success: true, data: { plan } });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// PATCH /academy/plans/:id
router.patch(
  '/plans/:id',
  requireTenantPermission('academy.plans.write'),
  async (req: Request, res: Response) => {
    try {
      const planId = Number(req.params.id);
      const { name, description, monthlyPrice, billingCycleDays } = req.body;
      const plan = await updatePlan(req.tenant!.academyId, req.user!.id, planId, {
        name, description,
        monthlyPrice: monthlyPrice != null ? Number(monthlyPrice) : undefined,
        billingCycleDays: billingCycleDays != null ? Number(billingCycleDays) : undefined,
      });
      res.json({ success: true, data: { plan } });
    } catch (err: any) {
      res.status(404).json({ success: false, error: err.message });
    }
  }
);

// DELETE /academy/plans/:id (archives)
router.delete(
  '/plans/:id',
  requireTenantPermission('academy.plans.write'),
  async (req: Request, res: Response) => {
    try {
      await archivePlan(req.tenant!.academyId, req.user!.id, Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(404).json({ success: false, error: err.message });
    }
  }
);

// ─── Dashboard summary ────────────────────────────────────────────────────────

// GET /academy/dashboard
router.get(
  '/dashboard',
  requireTenantPermission('academy.dashboard'),
  async (req: Request, res: Response) => {
  try {
    const { academyId } = req.tenant!;

    const [membersRes, academyRes, brandingRes, retentionRes, atRiskRes, professionalRes,
           metabolismRes, topPersonalsRes, adoptionRes, commercialRes] = await Promise.all([
      pool.query(
        `SELECT ar.slug, COUNT(*) AS count
         FROM academy_users au
         JOIN academy_roles ar ON ar.id = au.role_id
         WHERE au.academy_id = $1 AND au.is_active = TRUE
         GROUP BY ar.slug`,
        [academyId]
      ),
      pool.query(
        `SELECT display_name, slug, status, created_at FROM academies WHERE id = $1`,
        [academyId]
      ),
      pool.query(
        `SELECT logo_url, display_name, primary_color FROM academy_branding WHERE academy_id = $1`,
        [academyId]
      ),
      // B3: Student retention signals
      pool.query(
        `SELECT
           COUNT(*)                                                          AS total_students,
           COUNT(*) FILTER (
             WHERE udc.last_checkin >= NOW() - INTERVAL '7 days'
           )                                                                 AS active_7d,
           COUNT(*) FILTER (
             WHERE udc.last_checkin IS NULL
               OR  udc.last_checkin <  NOW() - INTERVAL '14 days'
           )                                                                 AS no_checkin_14d,
           COUNT(*) FILTER (
             WHERE uwl.last_workout IS NULL
               OR  uwl.last_workout <  NOW() - INTERVAL '14 days'
           )                                                                 AS no_workout_14d,
           ROUND(
             100.0 * COUNT(*) FILTER (
               WHERE udc.last_checkin >= NOW() - INTERVAL '7 days'
             ) / NULLIF(COUNT(*), 0)
           , 1)                                                              AS adherence_7d_pct
         FROM academy_users au
         JOIN users u ON u.id = au.user_id
         LEFT JOIN (
           SELECT user_id, MAX(created_at) AS last_checkin
           FROM user_daily_checkins
           WHERE academy_id = $1
           GROUP BY user_id
         ) udc ON udc.user_id = au.user_id
         LEFT JOIN (
           SELECT user_id, MAX(completed_at) AS last_workout
           FROM user_workout_logs
           WHERE academy_id = $1
           GROUP BY user_id
         ) uwl ON uwl.user_id = au.user_id
         WHERE au.academy_id = $1
           AND au.is_active   = TRUE
           AND au.status      = 'active'
           AND u.role         = 'user'`,
        [academyId]
      ),
      // B3: Top 3 at-risk students (no activity in last 14 days)
      pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.phone,
           udc.last_checkin,
           uwl.last_workout,
           GREATEST(
             COALESCE(EXTRACT(EPOCH FROM NOW() - udc.last_checkin) / 86400, 999),
             COALESCE(EXTRACT(EPOCH FROM NOW() - uwl.last_workout) / 86400, 999)
           )::integer AS days_inactive
         FROM academy_users au
         JOIN users u ON u.id = au.user_id
         LEFT JOIN (
           SELECT user_id, MAX(created_at) AS last_checkin
           FROM user_daily_checkins
           WHERE academy_id = $1
           GROUP BY user_id
         ) udc ON udc.user_id = au.user_id
         LEFT JOIN (
           SELECT user_id, MAX(completed_at) AS last_workout
           FROM user_workout_logs
           WHERE academy_id = $1
           GROUP BY user_id
         ) uwl ON uwl.user_id = au.user_id
         WHERE au.academy_id = $1
           AND au.is_active   = TRUE
           AND au.status      = 'active'
           AND u.role         = 'user'
           AND (
             udc.last_checkin IS NULL
             OR udc.last_checkin < NOW() - INTERVAL '14 days'
           )
         ORDER BY days_inactive DESC
         LIMIT 3`,
        [academyId]
      ),
      // B3: Active professionals (personal trainers) in this academy
      pool.query(
        `SELECT COUNT(*) AS count
         FROM academy_users au
         JOIN academy_roles ar ON ar.id = au.role_id
         WHERE au.academy_id = $1
           AND au.is_active   = TRUE
           AND au.status      = 'active'
           AND ar.slug IN ('personal', 'academy_personal')`,
        [academyId]
      ),
      // 3.4: Average metabolism score (30d, min 5 snapshots required)
      pool.query(
        `SELECT
           ROUND(AVG(latest.score), 1)     AS avg_score,
           COUNT(DISTINCT latest.user_id)  AS snapshot_count
         FROM (
           SELECT DISTINCT ON (ms.user_id)
             ms.user_id,
             ms.score
           FROM user_metabolism_snapshots ms
           JOIN academy_users au ON au.user_id = ms.user_id
             AND au.academy_id = $1
             AND au.is_active  = TRUE
           WHERE ms.created_at > NOW() - INTERVAL '30 days'
           ORDER BY ms.user_id, ms.created_at DESC
         ) latest`,
        [academyId]
      ).catch(() => ({ rows: [{ avg_score: null, snapshot_count: 0 }] })),
      // 3.5: Top 3 personals by student adherence (30d)
      pool.query(
        `SELECT
           u.id          AS user_id,
           u.name,
           COUNT(DISTINCT psa.student_id)  AS students_count,
           ROUND(
             100.0 * COUNT(DISTINCT udc.user_id) FILTER (
               WHERE udc.last_checkin >= NOW() - INTERVAL '7 days'
             ) / NULLIF(COUNT(DISTINCT psa.student_id), 0)
           , 1) AS adherence_rate
         FROM personal_student_assignments psa
         JOIN users u ON u.id = psa.personal_id
         LEFT JOIN (
           SELECT user_id, MAX(created_at) AS last_checkin
           FROM user_daily_checkins
           WHERE academy_id = $1
           GROUP BY user_id
         ) udc ON udc.user_id = psa.student_id
         WHERE psa.academy_id = $1 AND psa.status = 'active'
         GROUP BY u.id, u.name
         ORDER BY adherence_rate DESC NULLS LAST, students_count DESC
         LIMIT 3`,
        [academyId]
      ),
      // 3.6: Adoption indicators
      pool.query(
        `SELECT
           COUNT(DISTINCT au.user_id)                                   AS total_students,
           COUNT(DISTINCT ms.user_id) FILTER (
             WHERE ms.created_at > NOW() - INTERVAL '30 days'
           )                                                            AS lab_users,
           COUNT(DISTINCT acs.user_id) FILTER (
             WHERE acs.started_at > NOW() - INTERVAL '30 days'
           )                                                            AS tracker_users,
           COUNT(DISTINCT ae.user_id) FILTER (
             WHERE ae.created_at > NOW() - INTERVAL '30 days'
           )                                                            AS new_enrollments,
           COUNT(DISTINCT ae2.user_id) FILTER (
             WHERE ae2.status = 'cancelled' AND ae2.updated_at > NOW() - INTERVAL '30 days'
           )                                                            AS cancellations
         FROM academy_users au
         LEFT JOIN movement_sessions ms
           ON ms.user_id = au.user_id AND ms.academy_id = $1
         LEFT JOIN activity_sessions acs
           ON acs.user_id = au.user_id AND acs.academy_id = $1
         LEFT JOIN academy_enrollments ae     ON ae.user_id = au.user_id AND ae.academy_id = $1
         LEFT JOIN academy_enrollments ae2    ON ae2.user_id = au.user_id AND ae2.academy_id = $1
         WHERE au.academy_id = $1
           AND au.is_active   = TRUE
           AND au.status      = 'active'`,
        [academyId]
      ),
      // M7: Commercial signals — upgrade candidates, no plan, external personal
      pool.query(
        `WITH base AS (
           SELECT au.user_id
           FROM academy_users au
           JOIN users u ON u.id = au.user_id
           WHERE au.academy_id = $1
             AND au.is_active = TRUE AND au.status = 'active'
             AND u.role = 'user'
         ),
         signals AS (
           SELECT
             b.user_id,
             udc.last_checkin,
             EXTRACT(EPOCH FROM NOW() - ae.start_date) / 86400 AS enrolled_days,
             EXISTS (
               SELECT 1 FROM user_product_memberships upm
               WHERE upm.user_id = b.user_id
                 AND upm.product_key = 'app' AND upm.status = 'active'
             ) AS has_app,
             EXISTS (
               SELECT 1 FROM personal_workout_plans pwp
               WHERE pwp.student_id = b.user_id AND pwp.is_active = TRUE
             ) AS has_plan,
             EXISTS (
               SELECT 1 FROM personal_student_assignments psa
               WHERE psa.student_id = b.user_id AND psa.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1 FROM academy_users pau
                   WHERE pau.user_id = psa.personal_id
                     AND pau.academy_id = $1 AND pau.is_active = TRUE
                 )
             ) AS has_external_personal
           FROM base b
           LEFT JOIN (
             SELECT user_id, MAX(created_at) AS last_checkin
             FROM user_daily_checkins
             WHERE academy_id = $1
             GROUP BY user_id
           ) udc ON udc.user_id = b.user_id
           LEFT JOIN LATERAL (
             SELECT start_date FROM academy_enrollments
             WHERE user_id = b.user_id AND academy_id = $1 AND status = 'active'
             ORDER BY start_date ASC LIMIT 1
           ) ae ON TRUE
         )
         SELECT
           COUNT(*) FILTER (
             WHERE last_checkin >= NOW() - INTERVAL '30 days' AND NOT has_app
           )::integer AS upgrade_candidates,
           COUNT(*) FILTER (
             WHERE enrolled_days >= 30 AND NOT has_plan
           )::integer AS no_workout_plan,
           COUNT(*) FILTER (WHERE has_external_personal)::integer AS external_personal
         FROM signals`,
        [academyId]
      ).catch(() => ({ rows: [{ upgrade_candidates: 0, no_workout_plan: 0, external_personal: 0 }] })),
    ]);

    const membersByRole: Record<string, number> = {};
    for (const row of membersRes.rows) {
      membersByRole[row.slug] = Number(row.count);
    }

    const r = retentionRes.rows[0] ?? {};
    const retention = {
      totalStudents:   Number(r.total_students   ?? 0),
      studentsActive:  Number(r.active_7d         ?? 0),
      studentsAtRisk:  Number(r.no_checkin_14d    ?? 0),
      noWorkout14d:    Number(r.no_workout_14d    ?? 0),
      adherence7dPct:  r.adherence_7d_pct != null ? parseFloat(r.adherence_7d_pct) : null,
    };

    const atRiskStudents = atRiskRes.rows.map((row: any) => ({
      id:           row.id,
      name:         row.name || row.email || `Aluno ${row.id}`,
      email:        row.email,
      phone:        row.phone ?? null,
      lastCheckin:  row.last_checkin  ? new Date(row.last_checkin).toISOString()  : null,
      lastWorkout:  row.last_workout  ? new Date(row.last_workout).toISOString()  : null,
      daysInactive: Number(row.days_inactive),
    }));

    const metRow = metabolismRes.rows[0] ?? {};
    const snapshotCount = Number(metRow.snapshot_count ?? 0);
    const averageMetabolismScore = snapshotCount >= 5
      ? (metRow.avg_score != null ? parseFloat(metRow.avg_score) : null)
      : null;

    const topPersonals = (topPersonalsRes.rows as any[]).map((r) => ({
      userId:        Number(r.user_id),
      name:          r.name || `Personal ${r.user_id}`,
      studentsCount: Number(r.students_count),
      adherenceRate: r.adherence_rate != null ? parseFloat(r.adherence_rate) : null,
    }));

    const adoptRow = adoptionRes.rows[0] ?? {};
    const totalStudents2 = Number(adoptRow.total_students ?? 0);
    const adoption = {
      labAdoptionPct:     totalStudents2 > 0
        ? Math.round((Number(adoptRow.lab_users     ?? 0) / totalStudents2) * 100) : null,
      trackerAdoptionPct: totalStudents2 > 0
        ? Math.round((Number(adoptRow.tracker_users ?? 0) / totalStudents2) * 100) : null,
      netGrowth: Number(adoptRow.new_enrollments ?? 0) - Number(adoptRow.cancellations ?? 0),
    };

    const commRow = commercialRes.rows[0] ?? {};
    const commercialSignals = {
      upgradeCandidates: Number(commRow.upgrade_candidates ?? 0),
      noWorkoutPlan:     Number(commRow.no_workout_plan    ?? 0),
      externalPersonal:  Number(commRow.external_personal  ?? 0),
    };

    res.json({
      success: true,
      data: {
        academy: academyRes.rows[0] ?? null,
        branding: brandingRes.rows[0] ?? null,
        membersByRole,
        totalMembers: Object.values(membersByRole).reduce((a, b) => a + b, 0),
        professionalsActive: Number(professionalRes.rows[0]?.count ?? 0),
        retention,
        atRiskStudents,
        averageMetabolismScore,
        topPersonals,
        adoption,
        commercialSignals,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Recepção MVP ─────────────────────────────────────────────────────────────

// GET /academy/recepcao/dashboard
router.get(
  '/recepcao/dashboard',
  requireTenantPermission('academy.recepcao.dashboard'),
  async (req: Request, res: Response) => {
    try {
      const data = await getReceptionDashboard(req.tenant!.academyId);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/checkins
router.post(
  '/checkins',
  requireTenantPermission('academy.checkin.write'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.body.userId);
      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
      }
      const result = await registerStudentAccess({
        academyId: req.tenant!.academyId,
        actorUserId: req.user!.id,
        userId,
        eventType: 'checkin',
        source: req.body.source === 'qr' ? 'qr' : 'manual',
        ipAddress: req.ip,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/checkins/exception
router.post(
  '/checkins/exception',
  requireTenantPermission('academy.checkin.write'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.body.userId);
      const reason = String(req.body.reason ?? '').trim();
      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
      }
      if (reason.length < 10) {
        return res.status(400).json({
          success: false,
          error: 'Motivo deve ter pelo menos 10 caracteres (auditoria).',
        });
      }
      const result = await registerStudentAccess({
        academyId: req.tenant!.academyId,
        actorUserId: req.user!.id,
        userId,
        eventType: 'exception',
        source: 'manual',
        reason,
        ipAddress: req.ip,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/checkins/deny
router.post(
  '/checkins/deny',
  requireTenantPermission('academy.checkin.write'),
  async (req: Request, res: Response) => {
    try {
      const userId = Number(req.body.userId);
      const reason = String(req.body.reason ?? '').trim();
      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
      }
      if (reason.length < 10) {
        return res.status(400).json({
          success: false,
          error: 'Motivo deve ter pelo menos 10 caracteres (auditoria).',
        });
      }
      const result = await registerStudentAccess({
        academyId: req.tenant!.academyId,
        actorUserId: req.user!.id,
        userId,
        eventType: 'denied',
        source: 'manual',
        reason,
        ipAddress: req.ip,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /academy/visitors
router.post(
  '/visitors',
  requireTenantPermission('academy.checkin.write'),
  async (req: Request, res: Response) => {
    try {
      const vtRaw = String(req.body.visitorType ?? 'visitor');
      const visitorType =
        vtRaw === 'external_personal' || vtRaw === 'prospect' || vtRaw === 'trial_class'
          ? vtRaw
          : 'visitor';
      const result = await createVisitorAccess({
        academyId: req.tenant!.academyId,
        actorUserId: req.user!.id,
        name: String(req.body.name ?? ''),
        document: req.body.document ? String(req.body.document) : undefined,
        visitorType,
        phone: req.body.phone ? String(req.body.phone) : undefined,
        referredBy: req.body.referredBy ? String(req.body.referredBy) : undefined,
        validUntil: req.body.validUntil ? String(req.body.validUntil) : undefined,
        reason: req.body.reason ? String(req.body.reason) : undefined,
        ipAddress: req.ip,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// ─── Audit log ────────────────────────────────────────────────────────────────

// GET /academy/audit-log?limit=50&offset=0&action=<filter>
router.get(
  '/audit-log',
  requireTenantPermission('academy.audit.read'),
  async (req: Request, res: Response) => {
  try {
    const { academyId } = req.tenant!;
    const limit  = Math.min(Number(req.query.limit  ?? 50), 100);
    const offset = Number(req.query.offset ?? 0);
    const actorUserId = req.query.actor_user_id ? Number(req.query.actor_user_id) : undefined;
    const actionPrefix =
      typeof req.query.action_prefix === 'string' && req.query.action_prefix.length > 0
        ? req.query.action_prefix
        : undefined;
    const rows = await listAcademyAudit(academyId, limit, offset, {
      actorUserId: Number.isFinite(actorUserId) ? actorUserId : undefined,
      actionPrefix,
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Finance MVP ──────────────────────────────────────────────────────────────

// GET /academy/payments?from=&to=&status=&limit=&offset=
router.get(
  '/payments',
  requireTenantPermission('academy.finance.read'),
  async (req: Request, res: Response) => {
  try {
    const { academyId } = req.tenant!;
    const { from, to, status } = req.query as Record<string, string | undefined>;
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);

    const [{ rows, total }, kpis] = await Promise.all([
      listAcademyPayments({ academyId, from, to, status, limit, offset }),
      getAcademyFinanceKPIs(academyId),
    ]);

    res.json({ success: true, data: { rows, total, kpis } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
