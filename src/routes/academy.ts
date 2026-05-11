import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
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
import { validateBrandingColor, contrastRatio } from '../utils/contrastValidator';
import { calcPrimaryHover, calcPrimarySoft, calcCtaTextColor } from '../utils/colorContrast';
import { sanitizeBrandingText } from '../utils/htmlSanitize';
import pool from '../config/database';

const ALLOWED_LOGO_ORIGINS = ['s3.amazonaws.com', 'minutofit.com.br', 'cdn.minutofit.com.br'];

function validateLogoUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return 'Logo URL deve usar HTTPS.';
    const isAllowed = ALLOWED_LOGO_ORIGINS.some((origin) => parsed.hostname.endsWith(origin));
    if (!isAllowed) return 'Logo deve estar hospedado no MinutoFit (S3 ou CDN).';
    return null;
  } catch {
    return 'Logo URL inválida.';
  }
}

const router = Router();

// All routes require authentication + tenant context
router.use(authMiddleware, tenantContextMiddleware);

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
        return res.status(201).json({ success: true, data: result });
      }

      if (mode === 'invite') {
        const result = await createInvitation(academyId, req.user!.id, { roleSlug, email }, frontendUrl);
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
      await revokeInvitation(req.tenant!.academyId, req.user!.id, Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// ─── Branding ─────────────────────────────────────────────────────────────────

// GET /academy/branding
router.get('/branding', async (req: Request, res: Response) => {
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

// GET /academy/students
router.get(
  '/students',
  requireTenantPermission('academy.students.read'),
  async (req: Request, res: Response) => {
    try {
      const { status, q, unitId, page, pageSize } = req.query as Record<string, string>;
      const result = await listStudents(req.tenant!.academyId, {
        status:   status || undefined,
        q:        q || undefined,
        unitId:   unitId ? Number(unitId) : undefined,
        page:     page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
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
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
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
      await pauseStudent(req.tenant!.academyId, req.user!.id, Number(req.params.userId));
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
      await cancelStudent(req.tenant!.academyId, req.user!.id, Number(req.params.userId));
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
      await reactivateStudent(req.tenant!.academyId, req.user!.id, Number(req.params.userId));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
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
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const { academyId } = req.tenant!;

    const [membersRes, academyRes, brandingRes] = await Promise.all([
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
    ]);

    const membersByRole: Record<string, number> = {};
    for (const row of membersRes.rows) {
      membersByRole[row.slug] = Number(row.count);
    }

    res.json({
      success: true,
      data: {
        academy: academyRes.rows[0] ?? null,
        branding: brandingRes.rows[0] ?? null,
        membersByRole,
        totalMembers: Object.values(membersByRole).reduce((a, b) => a + b, 0),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
