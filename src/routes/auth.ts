import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../middleware/auth';
import * as authService from '../services/authService';
import * as oauthService from '../services/oauthService';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { verifyRegistrationCaptcha } from '../services/captchaService';
import { verifyRefreshToken } from '../utils/jwt';
import pool from '../config/database';
import { validateInvitationToken, acceptInvitation } from '../services/academyTeamService';
import { logAcademyAction } from '../services/auditService';
import { getUserProducts, getUserProductsWithMeta } from '../db/ensureProductsSchema';
import { findOrCreateUserFromContext, verifyUserPassword } from '../services/userIdentityService';
import { grantMembership } from '../services/membershipService';
import logger from '../lib/logger';
import {
  calcPrimarySoftStrong,
  calcPrimaryGlow,
  calcPrimaryLight,
  calcPrimaryDeep,
  calcBorderPrimary,
  calcBorderStrong,
  calcGradientPrimary,
} from '../utils/colorContrast';

const loginRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' },
  skipSuccessfulRequests: false,
});

const refreshRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' },
  skipSuccessfulRequests: true,
});

const router = Router();

// POST /auth/register - Register with email and password
router.post('/register', async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const cpf = String(req.body.cpf || '').trim();
    const phone = String(req.body.phone || '').trim();
    const h = req.body.healthFlags;
    let healthFlags: authService.HealthFlags | undefined;
    if (h && typeof h === 'object') {
      const candidate = {
        semHistoricoHipertensao: h.sem_historico_hipertensao,
        semHistoricoCardiaco: h.sem_historico_cardiaco,
        semRestricaoMedicaExercicio: h.sem_restricao_medica_exercicio,
        aptoParaAtividadeFisica: h.apto_para_atividade_fisica,
        aceitaResponsabilidadeInformacoes: h.aceita_responsabilidade_informacoes,
      };
      if (Object.values(candidate).every((v) => typeof v === 'boolean')) {
        healthFlags = candidate as authService.HealthFlags;
      }
    }

    if (!email || !password || !name || !cpf || !phone) {
      return res.status(400).json({
        success: false,
        error: 'Nome, CPF, telefone, email e senha sao obrigatorios.',
      });
    }

    const captchaToken =
      typeof req.body.captchaToken === 'string'
        ? req.body.captchaToken
        : typeof req.body.turnstileToken === 'string'
          ? req.body.turnstileToken
          : undefined;

    try {
      await verifyRegistrationCaptcha(captchaToken, req.ip);
    } catch (captchaErr: any) {
      const msg = String(captchaErr?.message || 'Falha na verificacao do CAPTCHA.');
      const status = msg.includes('nao configurado') ? 503 : 400;
      return res.status(status).json({ success: false, error: msg });
    }

    const { user, accessToken, refreshToken } = await authService.registerUser({
      email,
      password,
      name,
      cpf,
      phone,
      healthFlags,
    });

    res.status(201).json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken
      }
    });
  } catch (error: any) {
    const message = String(error.message || 'Nao foi possivel concluir o cadastro.');
    const code = String(error?.code || '');
    const status =
      code === 'EMAIL_ALREADY_REGISTERED' ||
      message === 'CPF ja cadastrado.' ||
      message === 'Email ja cadastrado.'
        ? 409
        : 400;
    res.status(status).json({
      success: false,
      error: message,
      ...(status === 409 ? { code: code || 'EMAIL_ALREADY_REGISTERED' } : {}),
    });
  }
});

// GET /auth/branding — public, no auth required.
// Returns branding for the academy that owns the request subdomain (via req.tenantHost).
// Returns 204 when accessed from app.minutofit.com.br (no tenant context).
// Returns 404 when slug exists but subdomain is inactive / academy not found.
router.get('/branding', async (req: Request, res: Response) => {
  try {
    if (!req.tenantHost) {
      // No subdomain context — generic login (app.minutofit.com.br)
      return res.status(204).end();
    }

    const { academyId, subdomainStatus } = req.tenantHost;

    if (subdomainStatus !== 'active') {
      return res.status(503).json({ success: false, error: 'Academia temporariamente indisponível.' });
    }

    const result = await pool.query(
      `SELECT
         a.display_name   AS academy_display_name,
         ab.logo_url,
         ab.banner_url,
         ab.display_name,
         ab.primary_color,
         ab.primary_hover,
         ab.primary_soft,
         ab.secondary_color,
         ab.accent_color,
         ab.cta_text_color,
         ab.welcome_message
       FROM academies a
       LEFT JOIN academy_branding ab ON ab.academy_id = a.id
       WHERE a.id = $1`,
      [academyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Academia não encontrada.' });
    }

    const row = result.rows[0];
    const primary: string | null = row.primary_color ?? null;
    const branding = {
      displayName:      row.display_name    ?? row.academy_display_name ?? null,
      logoUrl:          row.logo_url        ?? null,
      bannerUrl:        row.banner_url      ?? null,
      primaryColor:     primary,
      primaryHover:     row.primary_hover   ?? null,
      primarySoft:      row.primary_soft    ?? null,
      secondaryColor:   row.secondary_color ?? null,
      accentColor:      row.accent_color    ?? null,
      ctaTextColor:     row.cta_text_color  ?? null,
      welcomeMessage:   row.welcome_message ?? null,
      // Derived tokens — computed on the fly from primaryColor, never stored
      primarySoftStrong: primary ? calcPrimarySoftStrong(primary) : null,
      primaryGlow:       primary ? calcPrimaryGlow(primary)       : null,
      primaryLight:      primary ? calcPrimaryLight(primary)      : null,
      primaryDeep:       primary ? calcPrimaryDeep(primary)       : null,
      borderPrimary:     primary ? calcBorderPrimary(primary)     : null,
      borderStrong:      primary ? calcBorderStrong(primary)      : null,
      gradientPrimary:   primary ? calcGradientPrimary(primary)   : null,
    };

    return res.json({ success: true, data: { branding } });
  } catch (err: any) {
    logger.error({ err }, '[auth/branding]');
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /auth/login - Login with email and password
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // BE-1.7.4: if accessing via a tenant subdomain, restrict login to users of that academy
    const academyIdFromHost = req.tenantHost?.academyId;

    const { user, accessToken, refreshToken } = await authService.loginUser(
      email,
      password,
      academyIdFromHost
    );

    res.json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken
      }
    });
  } catch (error: any) {
    logger.error({ err: error }, 'Login error');
    const msg = String(error?.message || 'Nao foi possivel entrar.');
    const status = msg.includes('Sem acesso') ? 403 : 401;
    res.status(status).json({ success: false, error: msg });
  }
});

/**
 * Validates that a user is a member of the tenant academy when the request
 * originates from a subdomain (req.tenantHost is set).
 * Returns 403 if the user is not linked to that academy.
 */
async function assertTenantMembership(
  req: Request,
  res: Response,
  userId: number
): Promise<boolean> {
  const tenantAcademyId = req.tenantHost?.academyId;
  if (!tenantAcademyId) return true; // Not a tenant subdomain — allow

  const check = await pool.query(
    `SELECT 1 FROM academy_users
     WHERE user_id = $1 AND academy_id = $2 AND is_active = TRUE AND status = 'active'
     LIMIT 1`,
    [userId, tenantAcademyId]
  );

  if (check.rows.length === 0) {
    res.status(403).json({
      success: false,
      error: 'Usuário não possui acesso a esta academia. Solicite um convite ao administrador.',
      code: 'TENANT_ACCESS_DENIED',
    });
    return false;
  }

  return true;
}

// POST /auth/oauth/google/callback - Google OAuth callback
router.post('/oauth/google/callback', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, error: 'Google ID token is required' });
    }

    const googlePayload = await oauthService.validateGoogleToken(idToken);
    const oauthData = oauthService.extractOAuthUserData('google', googlePayload);

    const { user, accessToken, refreshToken, isNewUser } = await authService.loginOrCreateOAuthUser(
      'google',
      oauthData.oauthId,
      oauthData.email,
      oauthData.name,
      oauthData.photoUrl
    );

    // A5: Validate tenant membership when on a subdomain
    const allowed = await assertTenantMembership(req, res, Number(user.id));
    if (!allowed) return;

    res.json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken,
        isNewUser,
        requiresProfileCompletion: isNewUser && !user.profileCompleted
      }
    });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// POST /auth/oauth/apple/callback - Apple OAuth callback
router.post('/oauth/apple/callback', async (req: Request, res: Response) => {
  try {
    const { identityToken, name, email } = req.body;

    if (!identityToken) {
      return res.status(400).json({ success: false, error: 'Apple identity token is required' });
    }

    const applePayload = await oauthService.validateAppleToken(identityToken);
    const oauthData = oauthService.extractOAuthUserData('apple', applePayload);

    oauthData.email = email || oauthData.email;
    if (name) {
      oauthData.name = name;
    }

    if (!oauthData.email) {
      return res.status(400).json({
        success: false,
        error: 'Apple login did not provide an email. Retry with the same Apple account or use email/password.',
      });
    }

    const { user, accessToken, refreshToken, isNewUser } = await authService.loginOrCreateOAuthUser(
      'apple',
      oauthData.oauthId,
      oauthData.email,
      oauthData.name,
      oauthData.photoUrl
    );

    // A5: Validate tenant membership when on a subdomain
    const allowed = await assertTenantMembership(req, res, Number(user.id));
    if (!allowed) return;

    res.json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken,
        isNewUser,
        requiresProfileCompletion: isNewUser && !user.profileCompleted
      }
    });
  } catch (error: any) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// POST /auth/refresh - New access + refresh tokens from a valid refresh token
router.post('/refresh', refreshRateLimit, async (req: Request, res: Response) => {
  try {
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (!refreshToken) {
      return res.status(400).json({ success: false, error: 'Refresh token obrigatorio.' });
    }

    const { user, accessToken, refreshToken: newRefreshToken } =
      await authService.refreshWithRefreshToken(refreshToken);

    res.json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error: any) {
    const message = String(error?.message || 'Nao foi possivel renovar a sessao.');
    res.status(401).json({ success: false, error: message });
  }
});

// GET /auth/me - Get current user
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await authService.getUserById(req.user!.id);
    // Pass activeAcademyId from the JWT (or from the tenant host header) so users
    // linked to multiple academies get the correct role back. Without this hint,
    // resolveAcademyContext returns {} for any user in 2+ academies.
    const preferredAcademyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId;
    const { academyRoleSlug } = await authService.resolveAcademyContext(req.user!.id, preferredAcademyId);
    const effectiveProfile = (academyRoleSlug as any) ?? user.accessProfile;

    const products = await getUserProductsWithMeta(req.user!.id);

    res.json({
      success: true,
      data: { user: { ...user, accessProfile: effectiveProfile }, products }
    });
  } catch (error: any) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// PATCH /auth/complete-profile - Complete user profile (for new OAuth users)
router.patch('/complete-profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, photoUrl, fitnessGoal, experienceLevel, heightCm, weightKg, dietaryRestrictions } = req.body;

    if (!name || !fitnessGoal || !experienceLevel || heightCm === undefined || weightKg === undefined) {
      return res.status(400).json({
        success: false,
        error: 'name, fitnessGoal, experienceLevel, heightCm, and weightKg are required'
      });
    }

    const user = await authService.completeUserProfile(req.user!.id, {
      name,
      photoUrl,
      fitnessGoal,
      experienceLevel,
      heightCm,
      weightKg,
      dietaryRestrictions
    });

    res.json({
      success: true,
      data: { user }
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// PATCH /auth/student-compliance — triagem de saude + onboarding de treino + PAR-Q assinado
router.patch('/student-compliance', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (req.user!.role !== 'user') {
      return res.status(403).json({ success: false, error: 'Disponivel apenas para alunos.' });
    }

    const { healthFlags, onboardingAnswers, parqAnswers, parqSignatureDataUrl, parqFormVersion } = req.body;

    if (!healthFlags || typeof healthFlags !== 'object') {
      return res.status(400).json({ success: false, error: 'healthFlags obrigatorio.' });
    }

    const hf = {
      semHistoricoHipertensao: healthFlags.sem_historico_hipertensao,
      semHistoricoCardiaco: healthFlags.sem_historico_cardiaco,
      semRestricaoMedicaExercicio: healthFlags.sem_restricao_medica_exercicio,
      aptoParaAtividadeFisica: healthFlags.apto_para_atividade_fisica,
      aceitaResponsabilidadeInformacoes: healthFlags.aceita_responsabilidade_informacoes,
    };

    if (!Object.values(hf).every((v) => typeof v === 'boolean')) {
      return res.status(400).json({ success: false, error: 'healthFlags invalido.' });
    }

    if (onboardingAnswers === undefined || parqAnswers === undefined || parqSignatureDataUrl === undefined) {
      return res.status(400).json({
        success: false,
        error: 'onboardingAnswers, parqAnswers e parqSignatureDataUrl sao obrigatorios.',
      });
    }

    const user = await authService.saveStudentCompliance(req.user!.id, {
      healthFlags: hf as authService.HealthFlags,
      onboardingAnswers,
      parqAnswers,
      parqSignatureDataUrl: String(parqSignatureDataUrl),
      parqFormVersion,
    });

    res.json({
      success: true,
      data: { user },
    });
  } catch (error: any) {
    res.status(400).json({ success: false, error: String(error?.message || 'Falha ao salvar compliance.') });
  }
});

// POST /auth/logout - Revoke the refresh token and clear the session
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const rawRefreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : null;
    if (rawRefreshToken) {
      try {
        const payload = verifyRefreshToken(rawRefreshToken);
        await authService.revokeRefreshToken(payload.jti, payload.id, new Date(payload.exp * 1000));
      } catch {
        // Token already expired or invalid — nothing to revoke; logout still succeeds
      }
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.json({ success: true, message: 'Logged out' });
  }
});

// GET /auth/academies — lista academias ativas do usuário logado
router.get('/academies', authMiddleware, async (req: Request, res: Response) => {
  try {
    const academies = await authService.getAcademiesForUser(req.user!.id);
    res.json({ success: true, data: { academies } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: String(error?.message || 'Erro ao buscar academias.') });
  }
});

// POST /auth/switch-academy — troca a academia ativa e rotaciona o access token
router.post('/switch-academy', authMiddleware, async (req: Request, res: Response) => {
  try {
    const academyId = Number(req.body?.academyId);
    if (!academyId || isNaN(academyId)) {
      return res.status(400).json({ success: false, error: 'academyId obrigatório.' });
    }

    // Verificar que o usuário tem vínculo ativo com a academia solicitada
    const academies = await authService.getAcademiesForUser(req.user!.id);
    const target = academies.find((a) => a.id === academyId);
    if (!target) {
      return res.status(403).json({ success: false, error: 'Acesso à academia não autorizado.' });
    }

    const user = req.user!;
    // Use the role in the selected academy as accessProfile
    const effectiveProfile = (target.roleSlug as any) ?? user.accessProfile;
    const products = await getUserProducts(user.id);
    const newAccessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      profileCompleted: user.profileCompleted,
      accessProfile: effectiveProfile,
      activeAcademyId: academyId,
      products,
    });

    // B2: audit switch-academy
    logAcademyAction({
      academyId,
      userId: user.id,
      action: 'auth.switch_academy',
      entityType: 'academy',
      entityId: academyId,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        activeAcademy: target,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: String(error?.message || 'Erro ao trocar academia.') });
  }
});

// PATCH /auth/profile — atualiza nome e/ou telefone do usuário logado
router.patch('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, phone } = req.body;

    if (!name && !phone) {
      return res.status(400).json({ success: false, error: 'Informe name e/ou phone para atualizar.' });
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (name && String(name).trim()) {
      updates.push(`name = $${params.length + 1}`);
      params.push(String(name).trim());
    }

    if (phone && String(phone).trim()) {
      updates.push(`phone = $${params.length + 1}`);
      params.push(String(phone).trim());
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum campo valido para atualizar.' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.user!.id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id, name, email, phone`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    }

    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Erro interno.';
    res.status(500).json({ success: false, error: msg });
  }
});

// PATCH /auth/onboarding — persiste as respostas do wizard de onboarding do aluno
// Disponível para qualquer role autenticado (personal também pode ter onboarding futuro).
router.patch('/onboarding', authMiddleware, async (req: Request, res: Response) => {
  try {
    const answers = req.body?.answers;

    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ success: false, error: 'answers deve ser um objeto.' });
    }

    // Whitelist de chaves permitidas — impede injeção de campos arbitrários
    const ALLOWED_KEYS = new Set([
      'trainingPlace', 'timePerDay', 'injuries', 'surgeryRecent', 'frequentPain',
      'daysPerWeek', 'bestTime', 'intensityPref', 'equipmentPref', 'wantsCloseFollow',
    ]);

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answers)) {
      if (ALLOWED_KEYS.has(key)) sanitized[key] = value;
    }

    if (Object.keys(sanitized).length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma chave de onboarding válida.' });
    }

    await pool.query(
      `UPDATE users SET onboarding_answers = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(sanitized), req.user!.id]
    );

    res.json({ success: true, data: { onboardingAnswers: sanitized } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: String(error?.message || 'Erro ao salvar onboarding.') });
  }
});

// ─── Invitation public endpoints ────────────────────────────────────────────

// GET /auth/invitations/:token — validate token without auth
router.get('/invitations/:token', async (req: Request, res: Response) => {
  try {
    const data = await validateInvitationToken(req.params.token);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /auth/direct-invite/:token — public; supports personal (default) and nutri (?type=nutri)
router.get('/direct-invite/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const inviteType = req.query.type === 'nutri' ? 'nutri' : 'personal';

    if (!token || token.length > 64) {
      return res.status(400).json({ success: false, error: 'Token inválido.' });
    }

    let result;
    if (inviteType === 'nutri') {
      result = await pool.query(
        `SELECT ndi.id, ndi.invited_email, ndi.invited_name, ndi.status, ndi.expires_at,
                u.name AS professional_name
         FROM nutri_direct_invites ndi
         JOIN users u ON u.id = ndi.nutri_id
         WHERE ndi.token = $1 LIMIT 1`,
        [token]
      );
    } else {
      result = await pool.query(
        `SELECT pdi.id, pdi.invited_email, pdi.invited_name, pdi.status, pdi.expires_at,
                u.name AS professional_name
         FROM personal_direct_invites pdi
         JOIN users u ON u.id = pdi.personal_id
         WHERE pdi.token = $1 LIMIT 1`,
        [token]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Convite não encontrado.' });
    }

    const row = result.rows[0];
    const expired = row.status !== 'pending' || new Date(row.expires_at) < new Date();

    res.json({
      success: true,
      data: {
        professionalName: row.professional_name,
        personalName: row.professional_name, // compat alias for existing clients
        invitedName: row.invited_name,
        invitedEmail: row.invited_email,
        status: row.status,
        expired,
        type: inviteType,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /auth/direct-invite/:token/accept
// Supports both new users (signup) and existing users (login + link).
// When the email/CPF matches an existing account, requires the existing password.
// Returns userExists=true so the frontend can show the appropriate UI.
router.post('/direct-invite/:token/accept', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token || token.length > 64) {
      return res.status(400).json({ success: false, error: 'Token inválido.' });
    }

    const inviteResult = await pool.query(
      `SELECT id, personal_id, invited_email, invited_name, status, expires_at
       FROM personal_direct_invites
       WHERE token = $1 LIMIT 1`,
      [token]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Convite não encontrado.' });
    }

    const invite = inviteResult.rows[0];

    if (invite.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'Este convite já foi usado ou foi revogado.' });
    }

    if (new Date(invite.expires_at) < new Date()) {
      await pool.query(`UPDATE personal_direct_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
      return res.status(410).json({ success: false, error: 'Este convite expirou.' });
    }

    const { email, password, name, cpf, phone } = req.body;
    const finalEmail = (typeof email === 'string' ? email : invite.invited_email || '').trim().toLowerCase();
    const finalName  = (typeof name  === 'string' ? name  : invite.invited_name  || '').trim();

    if (!finalEmail || !finalName) {
      return res.status(400).json({ success: false, error: 'Nome e e-mail são obrigatórios.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, error: 'Senha obrigatória.' });
    }

    // Find or create user — deduplicates by email / CPF / phone
    const { user: identityUser, isNew } = await findOrCreateUserFromContext({
      email: finalEmail,
      name: finalName,
      cpf: typeof cpf === 'string' ? cpf : null,
      phone: typeof phone === 'string' ? phone : null,
      password,
    }).catch(async () => {
      // Fallback: if findOrCreate fails (e.g. cpf conflict on different email), try email-only
      return findOrCreateUserFromContext({ email: finalEmail, name: finalName, password });
    });

    // When the user already existed, verify password to prove ownership
    if (!isNew) {
      const valid = await verifyUserPassword(identityUser.id, password);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: 'Senha incorreta para a conta existente. Faça login para aceitar o convite.',
          userExists: true,
          email: identityUser.email,
        });
      }
    } else {
      // New user: assign free subscription (grantMembership APP is handled inside findOrCreate path)
      await pool.query(
        `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
         SELECT $1, id, 'active', NOW() FROM subscription_tiers WHERE name = 'Free'
         ON CONFLICT DO NOTHING`,
        [identityUser.id]
      );
    }

    // Create personal-student assignment (academy_id = NULL → autonomous personal)
    await pool.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status, created_at, updated_at)
       VALUES ($1, $2, 'active', NOW(), NOW())
       ON CONFLICT (personal_id, student_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
      [invite.personal_id, identityUser.id]
    );

    // Grant PERSONAL membership
    await grantMembership(identityUser.id, 'personal', {
      professionalId: invite.personal_id,
      metadata: { source: 'direct_invite', token },
    });

    // Grant APP membership (idempotent — existing users may already have it)
    await grantMembership(identityUser.id, 'app', {
      metadata: { source: 'direct_invite_personal' },
    });

    // Mark invite as accepted
    await pool.query(
      `UPDATE personal_direct_invites
       SET status = 'accepted', accepted_user_id = $1, accepted_at = NOW()
       WHERE id = $2`,
      [identityUser.id, invite.id]
    );

    // Issue tokens
    const products = await getUserProducts(identityUser.id);
    const { activeAcademyId, academyRoleSlug } = await authService.resolveAcademyContext(identityUser.id);
    const effectiveProfile = (academyRoleSlug as authService.AccessProfile | undefined) ?? (identityUser as any).access_profile;

    const accessToken = generateAccessToken({
      id: identityUser.id,
      email: identityUser.email,
      role: identityUser.role as 'user' | 'personal' | 'nutri' | 'admin',
      profileCompleted: identityUser.profile_completed,
      accessProfile: effectiveProfile,
      activeAcademyId,
      products,
    });
    const refreshToken = generateRefreshToken({ id: identityUser.id, email: identityUser.email });

    const statusCode = isNew ? 201 : 200;
    res.status(statusCode).json({
      success: true,
      data: { user: identityUser, accessToken, refreshToken, isNew, userExists: !isNew },
    });
  } catch (err: any) {
    logger.error({ err }, '[auth] direct-invite accept error');
    res.status(400).json({ success: false, error: err.message || 'Não foi possível concluir o cadastro.' });
  }
});

// POST /auth/direct-invite-nutri/:token/accept
// Same dedup flow as personal, but creates nutri_patient_assignments + grants NUTRI membership.
router.post('/direct-invite-nutri/:token/accept', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token || token.length > 64) {
      return res.status(400).json({ success: false, error: 'Token inválido.' });
    }

    const inviteResult = await pool.query(
      `SELECT id, nutri_id, invited_email, invited_name, status, expires_at
       FROM nutri_direct_invites WHERE token = $1 LIMIT 1`,
      [token]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Convite não encontrado.' });
    }

    const invite = inviteResult.rows[0];

    if (invite.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'Este convite já foi usado ou foi revogado.' });
    }

    if (new Date(invite.expires_at) < new Date()) {
      await pool.query(`UPDATE nutri_direct_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
      return res.status(410).json({ success: false, error: 'Este convite expirou.' });
    }

    const { email, password, name, cpf, phone } = req.body;
    const finalEmail = (typeof email === 'string' ? email : invite.invited_email || '').trim().toLowerCase();
    const finalName  = (typeof name  === 'string' ? name  : invite.invited_name  || '').trim();

    if (!finalEmail || !finalName || !password) {
      return res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
    }

    const { user: identityUser, isNew } = await findOrCreateUserFromContext({
      email: finalEmail,
      name: finalName,
      cpf: typeof cpf === 'string' ? cpf : null,
      phone: typeof phone === 'string' ? phone : null,
      password,
    }).catch(async () => findOrCreateUserFromContext({ email: finalEmail, name: finalName, password }));

    if (!isNew) {
      const valid = await verifyUserPassword(identityUser.id, password);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: 'Senha incorreta para a conta existente. Faça login para aceitar o convite.',
          userExists: true,
          email: identityUser.email,
        });
      }
    } else {
      await pool.query(
        `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
         SELECT $1, id, 'active', NOW() FROM subscription_tiers WHERE name = 'Free'
         ON CONFLICT DO NOTHING`,
        [identityUser.id]
      );
    }

    // Create nutri-patient assignment
    await pool.query(
      `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status, created_at, updated_at)
       VALUES ($1, $2, 'active', NOW(), NOW())
       ON CONFLICT (nutri_id, patient_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
      [invite.nutri_id, identityUser.id]
    );

    // Grant NUTRI + APP memberships
    await grantMembership(identityUser.id, 'nutri', {
      professionalId: invite.nutri_id,
      metadata: { source: 'direct_invite', token },
    });
    await grantMembership(identityUser.id, 'app', {
      metadata: { source: 'direct_invite_nutri' },
    });

    // Mark invite accepted
    await pool.query(
      `UPDATE nutri_direct_invites
       SET status = 'accepted', accepted_user_id = $1, accepted_at = NOW()
       WHERE id = $2`,
      [identityUser.id, invite.id]
    );

    const products = await getUserProducts(identityUser.id);
    const { activeAcademyId, academyRoleSlug } = await authService.resolveAcademyContext(identityUser.id);
    const effectiveProfile = (academyRoleSlug as authService.AccessProfile | undefined) ?? (identityUser as any).access_profile;

    const accessToken = generateAccessToken({
      id: identityUser.id,
      email: identityUser.email,
      role: identityUser.role as 'user' | 'personal' | 'nutri' | 'admin',
      profileCompleted: identityUser.profile_completed,
      accessProfile: effectiveProfile,
      activeAcademyId,
      products,
    });
    const refreshToken = generateRefreshToken({ id: identityUser.id, email: identityUser.email });

    res.status(isNew ? 201 : 200).json({
      success: true,
      data: { user: identityUser, accessToken, refreshToken, isNew, userExists: !isNew },
    });
  } catch (err: any) {
    logger.error({ err }, '[auth] direct-invite-nutri accept error');
    res.status(400).json({ success: false, error: err.message || 'Não foi possível concluir o cadastro.' });
  }
});

// POST /auth/accept-invitation
router.post('/accept-invitation', async (req: Request, res: Response) => {
  try {
    const { token, password, name, cpf, phone } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'token obrigatório.' });

    const result = await acceptInvitation(token, { password, name, cpf, phone });
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
