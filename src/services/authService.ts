import pool from '../config/database';
import bcryptjs from 'bcryptjs';
import crypto from 'crypto';
import logger from '../lib/logger';
import { CURRENT_TERMS_VERSION } from '../config/legal';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { assertStrongPassword } from '../utils/passwordPolicy';
import { assertAdultBirthDate } from '../utils/birthDate';
import { ensureProfessionalCode } from '../utils/professionalCode';
import { getUserProducts } from '../db/ensureProductsSchema';
import { grantMembership } from './membershipService';
import { findOrCreateUserFromContext, findOrCreateUserForPublicSignup } from './userIdentityService';
import { touchUserActivity } from './usageTelemetryService';
import { checkStudentLimitGate } from './personalPlanService';
import { grantConsents, DIRECT_INVITE_SCOPES_PERSONAL } from './consentService';
import {
  PARQ_FORM_VERSION,
  assertParqSignature,
  parseAndValidateOnboarding,
  parseAndValidateParqAnswers,
  type OnboardingAnswersInput,
  type ParqAnswerInput,
} from './complianceValidation';
import { deriveClearance, invalidateClearanceCache, type PhysicalActivityClearance } from './physicalActivityClearanceService';
import { logDataAccessEvent } from './dataAccessAuditService';

export type AccessProfile =
  | 'admin_owner'
  | 'admin_operations'
  | 'admin_finance'
  | 'admin_support'
  | 'clientes_sb'
  | 'user_default'
  | 'personal_default'
  | 'nutri_default';

export interface HealthFlags {
  semHistoricoHipertensao: boolean;
  semHistoricoCardiaco: boolean;
  semRestricaoMedicaExercicio: boolean;
  aptoParaAtividadeFisica: boolean;
  aceitaResponsabilidadeInformacoes: boolean;
}

export interface User {
  id: number;
  email: string;
  role: 'user' | 'personal' | 'nutri' | 'admin';
  name?: string;
  cpf?: string;
  phone?: string;
  photoUrl?: string;
  fitnessGoal?: string;
  experienceLevel?: string;
  heightCm?: number;
  weightKg?: number;
  dietaryRestrictions?: string;
  healthFlags?: HealthFlags;
  profileCompleted: boolean;
  oauthGoogleId?: string;
  oauthAppleId?: string;
  subscriptionTier?: string;
  accessProfile?: AccessProfile;
  onboardingAnswers?: OnboardingAnswersInput;
  parqAnswers?: ParqAnswerInput[];
  parqSignedAt?: string;
  parqFormVersion?: string;
  parqAnyYes?: boolean;
  parqExpiresAt?: string;
  parqSignatureLevel?: number;
  physicalActivityClearance?: PhysicalActivityClearance;
  /** Triagem de saude + onboarding de treino + PAR-Q assinado (apenas papel user). */
  studentComplianceComplete?: boolean;
  mustChangePassword?: boolean;
  /** Carimbo da última troca de senha — invalida refresh tokens emitidos antes. */
  passwordChangedAt?: string | null;
  /** Spec 031 — refresh tokens emitidos antes deste instante são inválidos. */
  sessionsInvalidatedAt?: string | null;
}

const USER_SELECT_FIELDS = `
  id,
  email,
  role,
  name,
  cpf,
  phone,
  photo_url,
  fitness_goal,
  experience_level,
  height_cm,
  weight_kg,
  dietary_restrictions,
  sem_historico_hipertensao,
  sem_historico_cardiaco,
  sem_restricao_medica_exercicio,
  apto_para_atividade_fisica,
  aceita_responsabilidade_informacoes,
  profile_completed,
  access_profile,
  oauth_google_id,
  oauth_apple_id,
  oauth_provider,
  onboarding_answers,
  parq_answers,
  parq_form_version,
  parq_signed_at,
  parq_signature_data,
  parq_any_yes,
  parq_medical_release_at,
  parq_expires_at,
  parq_signature_level,
  COALESCE(must_change_password, false) AS must_change_password,
  password_changed_at,
  sessions_invalidated_at
`;

export function normalizeCpf(cpf: string): string {
  return String(cpf || '').replace(/\D/g, '');
}

export function normalizePhone(phone: string): string {
  return String(phone || '').replace(/\D/g, '');
}

export function isValidCpf(cpf: string): boolean {
  const normalized = normalizeCpf(cpf);

  if (normalized.length !== 11 || /^(\d)\1{10}$/.test(normalized)) {
    return false;
  }

  const calculateDigit = (sliceLength: number) => {
    let sum = 0;
    for (let index = 0; index < sliceLength; index += 1) {
      sum += Number(normalized[index]) * (sliceLength + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const firstDigit = calculateDigit(9);
  const secondDigit = calculateDigit(10);
  return firstDigit === Number(normalized[9]) && secondDigit === Number(normalized[10]);
}

function validateHealthFlags(healthFlags: HealthFlags) {
  const flags = [
    healthFlags.semHistoricoHipertensao,
    healthFlags.semHistoricoCardiaco,
    healthFlags.semRestricaoMedicaExercicio,
    healthFlags.aptoParaAtividadeFisica,
    healthFlags.aceitaResponsabilidadeInformacoes,
  ];

  if (flags.some((flag) => typeof flag !== 'boolean')) {
    throw new Error('Todas as declaracoes de saude sao obrigatorias.');
  }

  // O aceite de responsabilidade é o único obrigatoriamente `true`: sem ele a
  // evidência não vale.
  if (!healthFlags.aceitaResponsabilidadeInformacoes) {
    throw new Error('Voce precisa confirmar a responsabilidade pelas informacoes fornecidas.');
  }

  // As 4 condições de saúde podem ser gravadas como `false`. Antes, declarar
  // hipertensão (ou não se declarar apto) fazia a gravação FALHAR — o aluno com
  // condição real não conseguia nem salvar a triagem, e a única saída era mentir
  // no formulário. Agora a resposta honesta é aceita e a consequência fica na
  // camada de liberação: `deriveClearance` devolve `medical_clearance_required`
  // e o aluno segue após declarar a liberação médica.
}

function throwFriendlyUniqueError(error: any): never {
  const detail = String(error?.detail || '');
  const constraint = String(error?.constraint || '');

  // CPF/telefone NÃO confirmam existência de conta (QA final 02/ago/2026).
  // O cadastro é público e sem autenticação: devolver "CPF ja cadastrado."
  // transformava o endpoint num oráculo — dá para testar o CPF de qualquer
  // pessoa e descobrir se ela usa a plataforma (dado de saúde, por associação).
  // O e-mail continua explícito de propósito: é a chave de identidade do signup
  // e o próprio dono o conhece, então a mensagem específica é o que permite
  // oferecer "entre" ou "recupere a senha" em vez de deixar o usuário travado.
  if (detail.includes('(cpf)') || constraint.includes('cpf')) {
    const err: any = new Error(
      'Nao foi possivel concluir o cadastro com os dados informados. '
        + 'Se voce ja tem conta, entre com seu e-mail ou recupere a senha.',
    );
    err.code = 'REGISTRATION_CONFLICT';
    throw err;
  }

  if (detail.includes('(email)') || constraint.includes('email')) {
    throw new Error('Email ja cadastrado.');
  }

  throw new Error('Nao foi possivel concluir o cadastro por conflito de dados.');
}

// E-mail do personal padrão para o qual todo aluno que se cadastra direto no
// app (sem academia, sem convite) é vinculado automaticamente. Decisão de
// negócio de 25/ago/2026: aluno de signup público entra na carteira deste
// personal por padrão. Falha aqui nunca deve derrubar o cadastro do aluno.
const DEFAULT_SIGNUP_PERSONAL_EMAIL = 'personal@treinai.com';

export async function autoAssignDefaultPersonalForDirectSignup(studentId: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND role = 'personal' LIMIT 1`,
    [DEFAULT_SIGNUP_PERSONAL_EMAIL]
  );
  const personalId = rows[0]?.id;
  if (!personalId) {
    logger.warn(
      { studentId, email: DEFAULT_SIGNUP_PERSONAL_EMAIL },
      '[auth] default signup personal not found — skipping auto-assign'
    );
    return;
  }

  const gate = await checkStudentLimitGate(personalId);
  if (gate.over) {
    logger.warn(
      { studentId, personalId, limit: gate.limit, current: gate.current },
      '[auth] default signup personal at student limit — skipping auto-assign'
    );
    return;
  }

  await pool.query(
    `INSERT INTO personal_student_assignments (personal_id, student_id, status, initiated_by, created_at, updated_at)
     VALUES ($1, $2, 'active', 'student', NOW(), NOW())
     ON CONFLICT (personal_id, student_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
    [personalId, studentId]
  );

  await grantConsents(studentId, personalId, 'personal', DIRECT_INVITE_SCOPES_PERSONAL, pool);

  await grantMembership(studentId, 'personal', {
    professionalId: personalId,
    source: 'bonus_personal',
    metadata: { origin: 'default_personal_auto_assign' },
  });

  await grantMembership(studentId, 'app', {
    professionalId: personalId,
    source: 'bonus_personal',
    metadata: { origin: 'default_personal_auto_assign' },
  });
}

export async function registerUser(
  data: {
    email: string;
    password: string;
    name: string;
    cpf: string;
    phone: string;
    /** Se omitido, triagem fica pendente (NULL no banco) ate /auth/student-compliance. */
    healthFlags?: HealthFlags;
    /** Aceite dos Termos de Uso + Política de Privacidade (obrigatório no signup público). */
    acceptedTerms: boolean;
    /** IP de origem do aceite (evidência LGPD). */
    acceptedTermsIp?: string;
    /** 'YYYY-MM-DD'. Obrigatória: o cadastro é 18+ (ver utils/birthDate.ts). */
    birthDate: string;
  }
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  const email = data.email.toLowerCase().trim();
  const name = data.name.trim();
  const cpf = normalizeCpf(data.cpf);
  const phone = normalizePhone(data.phone);
  const role = 'user';

  if (!isValidCpf(cpf)) {
    throw new Error('CPF invalido.');
  }

  if (phone.length < 10 || phone.length > 11) {
    throw new Error('Telefone invalido.');
  }

  assertStrongPassword(data.password);

  // Base legal do tratamento (LGPD art. 8º): o aceite de Termos + Privacidade é
  // obrigatório e verificado no servidor, não só no cliente.
  if (data.acceptedTerms !== true) {
    const err: any = new Error('É necessário aceitar os Termos de Uso e a Política de Privacidade.');
    err.code = 'TERMS_NOT_ACCEPTED';
    throw err;
  }

  // 18+ verificado no servidor — o campo no formulário é conveniência, não regra.
  const birthDate = assertAdultBirthDate(data.birthDate);

  if (data.healthFlags) {
    validateHealthFlags(data.healthFlags);
  }

  // Signup público usa email como única chave de dedup via helper dedicado
  // (`findOrCreateUserForPublicSignup`). CPF/phone ficam apenas como atributos
  // do usuário — sem merge silencioso por identidade alheia. O helper força
  // `matchBy: ['email']` mesmo se um caller futuro esquecer de configurar.
  let identity;
  try {
    identity = await findOrCreateUserForPublicSignup({
      email,
      name,
      cpf,
      phone,
      password: data.password,
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      throwFriendlyUniqueError(error);
    }
    throw error;
  }

  if (!identity.isNew) {
    const err: any = new Error('Email ja cadastrado.');
    err.code = 'EMAIL_ALREADY_REGISTERED';
    throw err;
  }

  // Persistir health flags do PAR-Q (quando informados) e role/contexto que
  // ainda não passam pelo serviço de identidade.
  const hf = data.healthFlags;
  if (hf || role !== 'user') {
    await pool.query(
      `UPDATE users SET
         role = $2,
         sem_historico_hipertensao        = COALESCE($3, sem_historico_hipertensao),
         sem_historico_cardiaco           = COALESCE($4, sem_historico_cardiaco),
         sem_restricao_medica_exercicio   = COALESCE($5, sem_restricao_medica_exercicio),
         apto_para_atividade_fisica       = COALESCE($6, apto_para_atividade_fisica),
         aceita_responsabilidade_informacoes = COALESCE($7, aceita_responsabilidade_informacoes)
       WHERE id = $1`,
      [
        identity.user.id,
        role,
        hf ? hf.semHistoricoHipertensao : null,
        hf ? hf.semHistoricoCardiaco : null,
        hf ? hf.semRestricaoMedicaExercicio : null,
        hf ? hf.aptoParaAtividadeFisica : null,
        hf ? hf.aceitaResponsabilidadeInformacoes : null,
      ]
    );
  }

  // Carimba o aceite dos termos (evidência LGPD): quando, qual versão, de qual
  // IP. Versão vem do servidor (CURRENT_TERMS_VERSION) — o cliente não escolhe.
  await pool.query(
    `UPDATE users
        SET accepted_terms_at = NOW(),
            terms_version = $2,
            accepted_terms_ip = $3,
            birth_date = $4::date
      WHERE id = $1`,
    [identity.user.id, CURRENT_TERMS_VERSION, data.acceptedTermsIp ?? null, birthDate]
  );

  const refreshed = await pool.query(
    `SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = $1`,
    [identity.user.id]
  );
  const user = mapUserRow(refreshed.rows[0]);

  await assignFreeSubscription(user.id);

  await grantMembership(user.id, 'app', {
    source: 'direct_purchase',
    metadata: { signup: 'public', channel: 'self_signup' },
  }).catch((err) => logger.error({ err, userId: user.id }, '[auth] grantMembership app failed'));

  await autoAssignDefaultPersonalForDirectSignup(user.id).catch((err) =>
    logger.error({ err, userId: user.id }, '[auth] auto-assign default personal failed')
  );

  const products = await getUserProducts(user.id);
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    profileCompleted: user.profileCompleted,
    accessProfile: user.accessProfile,
    products,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email,
  });

  return { user, accessToken, refreshToken };
}

/**
 * Cadastro público de personal trainer (Spec 026).
 *
 * Função dedicada em vez de parametrizar `registerUser` com role: nenhum caminho
 * de código aceita role vinda de input externo — aqui ela é fixa e literal.
 *
 * Diferenças em relação ao cadastro de aluno: sem PAR-Q, sem assinatura Free de
 * aluno e sem produto `app`. O profissional recebe apenas o produto `personal` e
 * entra no plano Free implícito (nenhuma linha em `personal_platform_subscriptions`).
 */
export async function registerPersonalUser(
  data: {
    email: string;
    password: string;
    name: string;
    cpf: string;
    phone: string;
    /** CREF declarado pelo profissional. Texto livre, não verificado. */
    registryCode?: string;
    /** Aceite dos Termos de Uso + Política de Privacidade (obrigatório no signup público). */
    acceptedTerms: boolean;
    /** IP de origem do aceite (evidência LGPD). */
    acceptedTermsIp?: string;
    /** 'YYYY-MM-DD'. Obrigatória: o cadastro é 18+ (ver utils/birthDate.ts). */
    birthDate: string;
  }
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  const email = data.email.toLowerCase().trim();
  const name = data.name.trim();
  const cpf = normalizeCpf(data.cpf);
  const phone = normalizePhone(data.phone);

  if (!isValidCpf(cpf)) {
    throw new Error('CPF invalido.');
  }

  if (phone.length < 10 || phone.length > 11) {
    throw new Error('Telefone invalido.');
  }

  assertStrongPassword(data.password);

  if (data.acceptedTerms !== true) {
    const err: any = new Error('É necessário aceitar os Termos de Uso e a Política de Privacidade.');
    err.code = 'TERMS_NOT_ACCEPTED';
    throw err;
  }

  // 18+ verificado no servidor — o campo no formulário é conveniência, não regra.
  const birthDate = assertAdultBirthDate(data.birthDate);

  // Mesma regra do signup de aluno: dedup só por email, sem merge por CPF/telefone.
  let identity;
  try {
    identity = await findOrCreateUserForPublicSignup({
      email,
      name,
      cpf,
      phone,
      password: data.password,
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      throwFriendlyUniqueError(error);
    }
    throw error;
  }

  // Conta existente (aluno ou profissional) nunca é promovida silenciosamente.
  if (!identity.isNew) {
    const err: any = new Error('Email ja cadastrado.');
    err.code = 'EMAIL_ALREADY_REGISTERED';
    throw err;
  }

  // `profile_completed = TRUE` porque o fluxo de complete-profile é do aluno
  // (peso, altura, objetivo); o onboarding do personal acontece em /app/personal.
  // Sem `must_change_password`: o profissional escolheu a própria senha.
  await pool.query(
    `UPDATE users
        SET role              = 'personal',
            profile_completed = TRUE,
            registry_code     = NULLIF(TRIM($2), ''),
            accepted_terms_at = NOW(),
            terms_version     = $3,
            accepted_terms_ip = $4,
            birth_date        = $5::date,
            updated_at        = NOW()
      WHERE id = $1`,
    [
      identity.user.id,
      data.registryCode ? String(data.registryCode).trim() : '',
      CURRENT_TERMS_VERSION,
      data.acceptedTermsIp ?? null,
      birthDate,
    ]
  );

  // Código público do profissional — permite ao aluno conectar por "código" além
  // do e-mail no sheet "Adicionar profissional". Gerado após o UPDATE de role
  // (o helper só grava para role IN ('personal','nutri')).
  await ensureProfessionalCode(identity.user.id);

  const refreshed = await pool.query(
    `SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = $1`,
    [identity.user.id]
  );
  const user = mapUserRow(refreshed.rows[0]);

  // Diferente do produto `app` do aluno, aqui a falha propaga: sem este membership
  // o personal recebe 403 em toda a área /personal (requireProduct('personal')).
  await grantMembership(user.id, 'personal', {
    source: 'direct_purchase',
    metadata: { signup: 'public', channel: 'self_signup' },
  });

  const products = await getUserProducts(user.id);
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    profileCompleted: user.profileCompleted,
    accessProfile: user.accessProfile,
    products,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email,
  });

  return { user, accessToken, refreshToken };
}

export async function loginUser(
  email: string,
  password: string,
  /** When provided (login via tenant subdomain), restrict access to this academy only. */
  academyIdFromHost?: number
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  const result = await pool.query(
    `SELECT ${USER_SELECT_FIELDS}, password
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const userRow = result.rows[0];
  
  if (!userRow.password) {
    throw new Error('User registered via OAuth. Please use OAuth to login.');
  }

  const passwordMatch = await bcryptjs.compare(password, userRow.password);
  if (!passwordMatch) {
    throw new Error('Invalid email or password');
  }

  const user = mapUserRow(userRow);

  // Get subscription tier
  const subResult = await pool.query(
    `SELECT st.name FROM user_subscriptions us
     JOIN subscription_tiers st ON us.tier_id = st.id
     WHERE us.user_id = $1 AND us.status = 'active'
     LIMIT 1`,
    [user.id]
  );

  if (subResult.rows.length > 0) {
    user.subscriptionTier = subResult.rows[0].name;
  }

  // BE-1.7.4: if request comes from a tenant subdomain, validate user has active link to that academy
  if (academyIdFromHost) {
    const linkResult = await pool.query(
      `SELECT 1 FROM academy_users
       WHERE user_id = $1 AND academy_id = $2 AND is_active = TRUE AND status = 'active'
       LIMIT 1`,
      [user.id, academyIdFromHost]
    );
    if (linkResult.rows.length === 0) {
      throw new Error('Sem acesso a esta academia. Verifique suas credenciais ou contate o administrador.');
    }
  }

  const { activeAcademyId, academyRoleSlug } = await resolveAcademyContext(
    user.id,
    academyIdFromHost
  );
  // Academy role slug takes precedence over users.access_profile for routing
  const effectiveProfile = (academyRoleSlug as AccessProfile | undefined) ?? user.accessProfile;

  const products = await getUserProducts(user.id);
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    profileCompleted: user.profileCompleted,
    accessProfile: effectiveProfile,
    activeAcademyId,
    products,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email
  });

  // Spec 028 — telemetria de uso. Best-effort: nunca bloqueia o login.
  void touchUserActivity(user.id, true);

  return { user: { ...user, accessProfile: effectiveProfile }, accessToken, refreshToken };
}

export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<User> {
  const result = await pool.query(
    `SELECT password FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0 || !result.rows[0].password) {
    throw new Error("Nao foi possivel validar sua senha atual.");
  }

  const passwordMatch = await bcryptjs.compare(currentPassword, result.rows[0].password);
  if (!passwordMatch) {
    throw new Error("Senha atual incorreta.");
  }

  assertStrongPassword(newPassword);

  if (currentPassword === newPassword) {
    throw new Error("A nova senha deve ser diferente da senha temporaria.");
  }

  const hashedPassword = await bcryptjs.hash(newPassword, 10);
  const updated = await pool.query(
    `UPDATE users
        SET password = $1,
            must_change_password = FALSE
      WHERE id = $2
      RETURNING ${USER_SELECT_FIELDS}`,
    [hashedPassword, userId]
  );

  return mapUserRow(updated.rows[0]);
}

export async function loginOrCreateOAuthUser(
  provider: 'google' | 'apple',
  oauthId: string,
  email: string,
  name: string,
  photoUrl?: string
): Promise<{ user: User; accessToken: string; refreshToken: string; isNewUser: boolean }> {
  let isNewUser = false;

  try {
    // Check if user exists with this OAuth ID
    const oauthField = provider === 'google' ? 'oauth_google_id' : 'oauth_apple_id';
    let result = await pool.query(
      `SELECT ${USER_SELECT_FIELDS}
       FROM users WHERE ${oauthField} = $1`,
      [oauthId]
    );

    let userRow = result.rows[0];

    // If not found, check if email exists
    if (!userRow) {
      result = await pool.query(
        `SELECT ${USER_SELECT_FIELDS}
         FROM users WHERE email = $1`,
        [email.toLowerCase().trim()]
      );

      userRow = result.rows[0];

      if (!userRow) {
        // Create new user via OAuth — roteia via serviço de identidade para
        // garantir dedup (matchBy:['email']) + senha aleatória (skipPolicy).
        isNewUser = true;
        const sentinelPassword = `oauth!${provider}!${oauthId}!${Date.now()}`;
        const identity = await findOrCreateUserFromContext({
          email: email.toLowerCase().trim(),
          name: name || email.split('@')[0],
          password: sentinelPassword,
          skipPasswordPolicy: true,
          matchBy: ['email'],
        });

        // OAuth normalmente envia senha nula no banco; sentinel acima é só pra
        // satisfazer a politica de criação. Limpamos imediatamente e gravamos
        // o oauth_id correspondente.
        await pool.query(
          `UPDATE users
              SET password = NULL,
                  photo_url = COALESCE($2, photo_url),
                  ${oauthField} = $3,
                  oauth_provider = $4
            WHERE id = $1`,
          [identity.user.id, photoUrl ?? null, oauthId, provider]
        );

        const fetched = await pool.query(
          `SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = $1`,
          [identity.user.id]
        );
        userRow = fetched.rows[0];

        await grantMembership(userRow.id, 'app', {
          source: 'direct_purchase',
          metadata: { signup: 'oauth', provider },
        }).catch((err) => logger.error({ err, userId: userRow.id }, '[auth] grantMembership oauth failed'));
        await assignFreeSubscription(userRow.id);
      } else {
        // Update existing user with OAuth ID
        await pool.query(
          `UPDATE users SET ${oauthField} = $1, oauth_provider = $2 WHERE id = $3`,
          [oauthId, provider, userRow.id]
        );
        // Grant APP membership if not already granted (idempotent)
        await grantMembership(userRow.id, 'app', {
          metadata: { source: 'oauth_link', provider },
        }).catch((err) => logger.error({ err, userId: userRow.id }, '[auth] grantMembership oauth-link failed'));
      }
    }

    const user = mapUserRow(userRow);

    // Get subscription tier
    const subResult = await pool.query(
      `SELECT st.name FROM user_subscriptions us
       JOIN subscription_tiers st ON us.tier_id = st.id
       WHERE us.user_id = $1 AND us.status = 'active'
       LIMIT 1`,
      [user.id]
    );

    if (subResult.rows.length > 0) {
      user.subscriptionTier = subResult.rows[0].name;
    }

    const { activeAcademyId, academyRoleSlug } = await resolveAcademyContext(user.id);
    const effectiveProfile = (academyRoleSlug as AccessProfile | undefined) ?? user.accessProfile;

    const products = await getUserProducts(user.id);
    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      profileCompleted: user.profileCompleted,
      accessProfile: effectiveProfile,
      activeAcademyId,
      products,
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email
    });

    // Spec 028 — login por OAuth conta como login (critério de aceite explícito).
    void touchUserActivity(user.id, true);

    return { user: { ...user, accessProfile: effectiveProfile }, accessToken, refreshToken, isNewUser };
  } catch (error: any) {
    logger.error({ err: error }, 'OAuth login error');
    throw new Error('Failed to login with OAuth provider');
  }
}

export async function completeUserProfile(
  userId: number,
  data: {
    name: string;
    photoUrl?: string;
    fitnessGoal: string;
    experienceLevel: string;
    heightCm: number;
    weightKg: number;
    dietaryRestrictions?: string;
  }
): Promise<User> {
  const result = await pool.query(
    `UPDATE users SET name = $1, photo_url = $2, fitness_goal = $3, experience_level = $4, height_cm = $5, weight_kg = $6, dietary_restrictions = $7, profile_completed = TRUE
     WHERE id = $8
     RETURNING ${USER_SELECT_FIELDS}`,
    [data.name, data.photoUrl, data.fitnessGoal, data.experienceLevel, data.heightCm, data.weightKg, data.dietaryRestrictions, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  return mapUserRow(result.rows[0]);
}

export async function saveStudentCompliance(
  userId: number,
  payload: {
    healthFlags: HealthFlags;
    onboardingAnswers: unknown;
    parqAnswers: unknown;
    parqSignatureDataUrl: string;
    parqFormVersion?: string;
    meta?: { ip?: string; userAgent?: string };
  }
): Promise<User> {
  validateHealthFlags(payload.healthFlags);
  const onboarding = parseAndValidateOnboarding(payload.onboardingAnswers);
  const parq = parseAndValidateParqAnswers(payload.parqAnswers);
  assertParqSignature(payload.parqSignatureDataUrl);

  const version = String(payload.parqFormVersion || PARQ_FORM_VERSION).slice(0, 64);
  const anyYes = parq.some((a) => a.yes);
  const signedAt = new Date();
  const expiresAt = new Date(signedAt);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  // Level-1 evidence hash: SHA-256 of (formVersion + canonical answers + signature)
  const evidenceHash = crypto
    .createHash('sha256')
    .update(version + JSON.stringify(parq) + payload.parqSignatureDataUrl)
    .digest('hex');

  const healthFlagsSnapshot = {
    sem_historico_hipertensao: payload.healthFlags.semHistoricoHipertensao,
    sem_historico_cardiaco: payload.healthFlags.semHistoricoCardiaco,
    sem_restricao_medica_exercicio: payload.healthFlags.semRestricaoMedicaExercicio,
    apto_para_atividade_fisica: payload.healthFlags.aptoParaAtividadeFisica,
    aceita_responsabilidade_informacoes: payload.healthFlags.aceitaResponsabilidadeInformacoes,
  };

  const client = await pool.connect();
  let updatedRow: any;
  try {
    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE users SET
        sem_historico_hipertensao = $1,
        sem_historico_cardiaco = $2,
        sem_restricao_medica_exercicio = $3,
        apto_para_atividade_fisica = $4,
        aceita_responsabilidade_informacoes = $5,
        onboarding_answers = $6::jsonb,
        parq_answers = $7::jsonb,
        parq_form_version = $8,
        parq_signed_at = $9,
        parq_signature_data = $10,
        parq_any_yes = $11,
        parq_expires_at = $12,
        parq_signature_level = 1,
        -- Assinatura nova zera a liberação médica anterior: ela se referia às
        -- respostas antigas. Se o aluno voltar a marcar "sim", declara de novo.
        parq_medical_release_at = NULL
      WHERE id = $13 AND role = 'user'
      RETURNING ${USER_SELECT_FIELDS}`,
      [
        payload.healthFlags.semHistoricoHipertensao,
        payload.healthFlags.semHistoricoCardiaco,
        payload.healthFlags.semRestricaoMedicaExercicio,
        payload.healthFlags.aptoParaAtividadeFisica,
        payload.healthFlags.aceitaResponsabilidadeInformacoes,
        JSON.stringify(onboarding),
        JSON.stringify(parq),
        version,
        signedAt,
        payload.parqSignatureDataUrl,
        anyYes,
        expiresAt,
        userId,
      ]
    );

    if (updateResult.rows.length === 0) {
      throw new Error('Usuario nao encontrado ou sem permissao.');
    }
    updatedRow = updateResult.rows[0];

    await client.query(
      `INSERT INTO parq_signatures (
        user_id, form_version, parq_answers, parq_any_yes, health_flags,
        signature_data, acceptance_checkbox, evidence_hash, signature_level,
        signed_at, expires_at, ip, user_agent
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        userId,
        version,
        JSON.stringify(parq),
        anyYes,
        JSON.stringify(healthFlagsSnapshot),
        payload.parqSignatureDataUrl,
        true,
        evidenceHash,
        1,
        signedAt,
        expiresAt,
        payload.meta?.ip ?? null,
        payload.meta?.userAgent?.slice(0, 512) ?? null,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Post-commit: audit trail + cache invalidation (best-effort, non-blocking)
  void logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'parq.signed',
    eventPayload: {
      formVersion: version,
      anyYes,
      expiresAt: expiresAt.toISOString(),
      signatureLevel: 1,
      evidenceHash,
    },
    ip: payload.meta?.ip,
  });
  invalidateClearanceCache(userId);

  return mapUserRow(updatedRow);
}

/**
 * Aluno declara que obteve liberação médica para atividade física (P1-1).
 *
 * É a saída do estado `medical_clearance_required`: quem responde "sim" a
 * alguma pergunta do PAR-Q é orientado a procurar avaliação médica, e volta
 * aqui para registrar que a obteve. A declaração é do aluno (mesmo nível de
 * evidência do resto do PAR-Q, que também é auto-declaratório) — não é laudo,
 * e por isso fica auditada com data, IP e user agent.
 *
 * Só faz sentido para quem tem PAR-Q assinado com `parq_any_yes = true`;
 * chamar em qualquer outro estado é 409, para não criar liberação órfã.
 */
export async function declareParqMedicalRelease(
  userId: number,
  meta?: { ip?: string; userAgent?: string }
): Promise<User> {
  const current = await pool.query(
    `SELECT parq_signed_at, parq_any_yes,
            sem_historico_hipertensao, sem_historico_cardiaco,
            sem_restricao_medica_exercicio, apto_para_atividade_fisica
       FROM users WHERE id = $1 AND role = 'user' LIMIT 1`,
    [userId]
  );
  if (current.rows.length === 0) {
    throw new Error('Usuario nao encontrado ou sem permissao.');
  }
  const row = current.rows[0];
  if (!row.parq_signed_at) {
    const err = new Error('Assine o PAR-Q antes de declarar a liberacao medica.');
    (err as { code?: string }).code = 'PARQ_NOT_SIGNED';
    throw err;
  }
  // Precisa haver um motivo real: "sim" no PAR-Q OU condição de saúde declarada.
  const declaredHealthCondition = [
    row.sem_historico_hipertensao,
    row.sem_historico_cardiaco,
    row.sem_restricao_medica_exercicio,
    row.apto_para_atividade_fisica,
  ].some((v) => v === false);
  if (row.parq_any_yes !== true && !declaredHealthCondition) {
    const err = new Error('Sua triagem nao exige liberacao medica.');
    (err as { code?: string }).code = 'MEDICAL_RELEASE_NOT_REQUIRED';
    throw err;
  }

  const updated = await pool.query(
    `UPDATE users SET parq_medical_release_at = NOW()
      WHERE id = $1 AND role = 'user'
      RETURNING ${USER_SELECT_FIELDS}`,
    [userId]
  );

  await logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'parq.medical_release_declared',
    eventPayload: { declaredAt: new Date().toISOString() },
    ip: meta?.ip,
  });
  invalidateClearanceCache(userId);

  return mapUserRow(updated.rows[0]);
}

function rowHealthComplete(row: any): boolean {
  return (
    row.sem_historico_hipertensao === true &&
    row.sem_historico_cardiaco === true &&
    row.sem_restricao_medica_exercicio === true &&
    row.apto_para_atividade_fisica === true &&
    row.aceita_responsabilidade_informacoes === true
  );
}

function rowOnboardingComplete(row: any): boolean {
  try {
    parseAndValidateOnboarding(row.onboarding_answers);
    return true;
  } catch {
    return false;
  }
}

function rowParqComplete(row: any): boolean {
  if (!row.parq_signed_at || !row.parq_signature_data) {
    return false;
  }
  try {
    assertParqSignature(String(row.parq_signature_data));
    parseAndValidateParqAnswers(row.parq_answers);
    return true;
  } catch {
    return false;
  }
}

export async function getUserById(userId: number): Promise<User> {
  const result = await pool.query(
    `SELECT ${USER_SELECT_FIELDS}
     FROM users WHERE id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  const user = mapUserRow(result.rows[0]);

  // Get subscription tier
  const subResult = await pool.query(
    `SELECT st.name FROM user_subscriptions us
     JOIN subscription_tiers st ON us.tier_id = st.id
     WHERE us.user_id = $1 AND us.status = 'active'
     LIMIT 1`,
    [userId]
  );

  if (subResult.rows.length > 0) {
    user.subscriptionTier = subResult.rows[0].name;
  }

  return user;
}

export async function revokeRefreshToken(jti: string, userId: number, expiresAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO revoked_refresh_tokens (jti, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, userId, expiresAt]
  );
}

/**
 * Spec 031 — invalida TODOS os refresh tokens do usuário emitidos até agora.
 *
 * Usado no logout. Não depende do cliente enviar o token: o carimbo é comparado
 * com o `iat` do JWT na rotação, mesmo mecanismo de `password_changed_at`.
 *
 * Nota: o access token em curso continua válido até expirar (TTL 1h). Invalidá-lo
 * exigiria consulta ao banco a cada request autenticado — custo alto para uma
 * janela curta. Decisão consciente, registrada na spec.
 */
export async function invalidateUserSessions(userId: number): Promise<void> {
  await pool.query(`UPDATE users SET sessions_invalidated_at = NOW() WHERE id = $1`, [userId]);
}

export async function refreshWithRefreshToken(
  refreshToken: string
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  let payload: { jti: string; id: number; email: string; exp: number };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new Error('Invalid or expired refresh token');
  }

  // Check denylist
  const revoked = await pool.query(
    'SELECT 1 FROM revoked_refresh_tokens WHERE jti = $1',
    [payload.jti]
  );
  if (revoked.rows.length > 0) {
    throw new Error('Refresh token has been revoked');
  }

  const user = await getUserById(payload.id);
  if (user.email.toLowerCase() !== payload.email.toLowerCase()) {
    throw new Error('Invalid refresh token');
  }

  // Invalidação de sessão por troca/reset de senha: rejeita refresh tokens
  // emitidos ANTES do último `password_changed_at`. `iat` (segundos) já vem no
  // payload decodificado do JWT. Fecha o refresh roubado sem enumerar a denylist.
  if (user.passwordChangedAt) {
    const iat = (payload as { iat?: number }).iat;
    const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
    if (typeof iat === 'number' && iat < changedAtSec) {
      throw new Error('Refresh token invalidated by password change');
    }
  }

  // Spec 031 — mesmo mecanismo para o logout. Antes o logout só revogava o
  // token que o cliente mandasse no body; sem body, respondia 200 e a sessão
  // seguia viva por 7 dias. Agora o logout carimba `sessions_invalidated_at` e
  // todo refresh anterior morre, independente de o cliente cooperar.
  if (user.sessionsInvalidatedAt) {
    const iat = (payload as { iat?: number }).iat;
    const invalidatedAtSec = Math.floor(new Date(user.sessionsInvalidatedAt).getTime() / 1000);
    if (typeof iat === 'number' && iat < invalidatedAtSec) {
      throw new Error('Refresh token invalidated by logout');
    }
  }

  // Rotate: revoke the used token before issuing a new one
  await revokeRefreshToken(payload.jti, user.id, new Date(payload.exp * 1000));

  const { activeAcademyId, academyRoleSlug } = await resolveAcademyContext(user.id);
  const effectiveProfile = (academyRoleSlug as AccessProfile | undefined) ?? user.accessProfile;

  const products = await getUserProducts(user.id);
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    profileCompleted: user.profileCompleted,
    accessProfile: effectiveProfile,
    activeAcademyId,
    products,
  });

  const newRefreshToken = generateRefreshToken({
    id: user.id,
    email: user.email,
  });

  // Spec 028 — refresh renova sessão mas NÃO é login novo: só avança last_seen_at.
  // É o que captura o uso contínuo de quem fica dias sem redigitar senha.
  void touchUserActivity(user.id, false);

  return { user: { ...user, accessProfile: effectiveProfile }, accessToken, refreshToken: newRefreshToken };
}

/**
 * Retorna o contexto de academia ativa para incluir no JWT.
 * - 1 academia ativa → retorna id + roleSlug do papel nessa academia.
 * - 0 ou >1 → retorna undefined em ambos (seletor no frontend ou Admin CoreFit global).
 */
export async function resolveActiveAcademyId(userId: number): Promise<number | undefined> {
  const ctx = await resolveAcademyContext(userId);
  return ctx.activeAcademyId;
}

export async function resolveAcademyContext(
  userId: number,
  preferredAcademyId?: number
): Promise<{
  activeAcademyId?: number;
  academyRoleSlug?: string;
}> {
  try {
    // When a preferred academy is specified (tenant subdomain login), use it directly
    if (preferredAcademyId) {
      const res = await pool.query(
        `SELECT au.academy_id, ar.slug AS role_slug
         FROM academy_users au
         JOIN academy_roles ar ON ar.id = au.role_id
         WHERE au.user_id = $1 AND au.academy_id = $2 AND au.is_active = TRUE AND au.status = 'active'
         LIMIT 1`,
        [userId, preferredAcademyId]
      );
      if (res.rows.length === 1) {
        return {
          activeAcademyId: res.rows[0].academy_id as number,
          academyRoleSlug: res.rows[0].role_slug as string,
        };
      }
      return {};
    }

    const res = await pool.query(
      `SELECT au.academy_id, ar.slug AS role_slug
       FROM academy_users au
       JOIN academy_roles ar ON ar.id = au.role_id
       WHERE au.user_id = $1 AND au.is_active = TRUE AND au.status = 'active'`,
      [userId]
    );
    if (res.rows.length === 1) {
      return {
        activeAcademyId: res.rows[0].academy_id as number,
        academyRoleSlug: res.rows[0].role_slug as string,
      };
    }
    return {};
  } catch {
    return {};
  }
}

export interface AcademyForUser {
  id: number;
  slug: string;
  displayName: string;
  logoUrl?: string;
  roleSlug: string;
  roleLabel: string;
  status: string;
}

export async function getAcademiesForUser(userId: number): Promise<AcademyForUser[]> {
  const res = await pool.query(
    `SELECT
       a.id,
       a.slug,
       a.display_name,
       a.status,
       ab.logo_url,
       ar.slug   AS role_slug,
       ar.label  AS role_label
     FROM academy_users au
     JOIN academies        a  ON a.id  = au.academy_id
     JOIN academy_roles    ar ON ar.id = au.role_id
     LEFT JOIN academy_branding ab ON ab.academy_id = a.id
     WHERE au.user_id  = $1
       AND au.is_active = TRUE
       AND au.status    = 'active'
       AND a.status     = 'active'
     ORDER BY a.display_name`,
    [userId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    logoUrl: r.logo_url ?? undefined,
    roleSlug: r.role_slug,
    roleLabel: r.role_label,
    status: r.status,
  }));
}

async function assignFreeSubscription(userId: number): Promise<void> {
  // Get Free tier ID
  const tierResult = await pool.query(
    `SELECT id FROM subscription_tiers WHERE name = 'Free'`
  );

  if (tierResult.rows.length > 0) {
    const freeTierId = tierResult.rows[0].id;

    await pool.query(
      `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [userId, freeTierId, 'active']
    );
  }
}

function mapUserRow(row: any): User {
  const healthDefined =
    row.sem_historico_hipertensao !== null &&
    row.sem_historico_hipertensao !== undefined &&
    row.sem_historico_cardiaco !== null &&
    row.sem_historico_cardiaco !== undefined &&
    row.sem_restricao_medica_exercicio !== null &&
    row.sem_restricao_medica_exercicio !== undefined &&
    row.apto_para_atividade_fisica !== null &&
    row.apto_para_atividade_fisica !== undefined &&
    row.aceita_responsabilidade_informacoes !== null &&
    row.aceita_responsabilidade_informacoes !== undefined;

  let onboardingAnswers: OnboardingAnswersInput | undefined;
  if (row.onboarding_answers) {
    try {
      onboardingAnswers = parseAndValidateOnboarding(row.onboarding_answers);
    } catch {
      onboardingAnswers = undefined;
    }
  }

  let parqAnswers: ParqAnswerInput[] | undefined;
  if (row.parq_answers) {
    try {
      parqAnswers = parseAndValidateParqAnswers(row.parq_answers);
    } catch {
      parqAnswers = undefined;
    }
  }

  const studentComplianceComplete =
    row.role === 'user'
      ? rowHealthComplete(row) && rowOnboardingComplete(row) && rowParqComplete(row)
      : undefined;

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
    cpf: row.cpf,
    phone: row.phone,
    photoUrl: row.photo_url,
    fitnessGoal: row.fitness_goal,
    experienceLevel: row.experience_level,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    dietaryRestrictions: row.dietary_restrictions,
    healthFlags: healthDefined
      ? {
          semHistoricoHipertensao: row.sem_historico_hipertensao,
          semHistoricoCardiaco: row.sem_historico_cardiaco,
          semRestricaoMedicaExercicio: row.sem_restricao_medica_exercicio,
          aptoParaAtividadeFisica: row.apto_para_atividade_fisica,
          aceitaResponsabilidadeInformacoes: row.aceita_responsabilidade_informacoes,
        }
      : undefined,
    profileCompleted: row.profile_completed || false,
    mustChangePassword: row.must_change_password === true,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : null,
    sessionsInvalidatedAt: row.sessions_invalidated_at
      ? new Date(row.sessions_invalidated_at).toISOString()
      : null,
    accessProfile: row.access_profile || undefined,
    oauthGoogleId: row.oauth_google_id,
    oauthAppleId: row.oauth_apple_id,
    onboardingAnswers,
    parqAnswers,
    parqSignedAt: row.parq_signed_at ? new Date(row.parq_signed_at).toISOString() : undefined,
    parqFormVersion: row.parq_form_version || undefined,
    parqAnyYes: typeof row.parq_any_yes === 'boolean' ? row.parq_any_yes : undefined,
    parqExpiresAt: row.parq_expires_at ? new Date(row.parq_expires_at).toISOString() : undefined,
    parqSignatureLevel: row.parq_signature_level ?? undefined,
    physicalActivityClearance: row.role === 'user' ? deriveClearance(row) : undefined,
    studentComplianceComplete,
  };
}
