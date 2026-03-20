import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import * as authService from '../services/authService';
import * as oauthService from '../services/oauthService';

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
    const healthFlags = {
      semHistoricoHipertensao: req.body.healthFlags?.sem_historico_hipertensao,
      semHistoricoCardiaco: req.body.healthFlags?.sem_historico_cardiaco,
      semRestricaoMedicaExercicio: req.body.healthFlags?.sem_restricao_medica_exercicio,
      aptoParaAtividadeFisica: req.body.healthFlags?.apto_para_atividade_fisica,
      aceitaResponsabilidadeInformacoes: req.body.healthFlags?.aceita_responsabilidade_informacoes,
    };

    if (!email || !password || !name || !cpf || !phone) {
      return res.status(400).json({
        success: false,
        error: 'Nome, CPF, telefone, email e senha sao obrigatorios.',
      });
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
    res.status(401).json({ success: false, error: error.message });
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

// POST /auth/logout - Logout (optional - mainly for frontend to clear)
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

export default router;
