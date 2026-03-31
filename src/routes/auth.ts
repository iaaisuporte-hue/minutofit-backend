import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import * as authService from '../services/authService';
import * as oauthService from '../services/oauthService';
import { verifyRegistrationCaptcha } from '../services/captchaService';

const router = Router();

// POST /auth/register - Register with email and password
router.post('/register', async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const cpf = String(req.body.cpf || '').trim();
    const phone = String(req.body.phone || '').trim();
    const role = req.body.role;
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
      role: role || 'user',
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

// POST /auth/login - Login with email and password
router.post('/login', async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const { user, accessToken, refreshToken } = await authService.loginUser(email, password);

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
    res.status(401).json({ success: false, error: String(error?.message || 'Nao foi possivel entrar.') });
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
router.post('/refresh', async (req: Request, res: Response) => {
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

    res.json({
      success: true,
      data: { user }
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

// POST /auth/logout - Logout (optional - mainly for frontend to clear)
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

export default router;
