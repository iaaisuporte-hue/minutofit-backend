import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../middleware/auth';
import * as authService from '../services/authService';
import * as oauthService from '../services/oauthService';
import { generateAccessToken } from '../utils/jwt';
import { verifyRegistrationCaptcha } from '../services/captchaService';
import { verifyRefreshToken } from '../utils/jwt';
import pool from '../config/database';
import { validateInvitationToken, acceptInvitation } from '../services/academyTeamService';
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
    const status =
      message === 'CPF ja cadastrado.' || message === 'Email ja cadastrado.'
        ? 409
        : 400;
    res.status(status).json({ success: false, error: message });
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
    console.error('[auth/branding]', err);
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
    console.error('Login error:', error);
    const msg = String(error?.message || 'Nao foi possivel entrar.');
    const status = msg.includes('Sem acesso') ? 403 : 401;
    res.status(status).json({ success: false, error: msg });
  }
});

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
    // Resolve academy role to use as effectiveProfile (overrides users.access_profile for academy staff)
    const { academyRoleSlug } = await authService.resolveAcademyContext(req.user!.id);
    const effectiveProfile = (academyRoleSlug as any) ?? user.accessProfile;

    res.json({
      success: true,
      data: { user: { ...user, accessProfile: effectiveProfile } }
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
    const newAccessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      profileCompleted: user.profileCompleted,
      accessProfile: effectiveProfile,
      activeAcademyId: academyId,
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
