import pool from '../config/database';
import bcryptjs from 'bcryptjs';
import { generateAccessToken, generateRefreshToken, JWTPayload } from '../utils/jwt';

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
  oauth_google_id,
  oauth_apple_id,
  oauth_provider
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

  if (!healthFlags.aceitaResponsabilidadeInformacoes) {
    throw new Error('Voce precisa confirmar a responsabilidade pelas informacoes fornecidas.');
  }

  if (!healthFlags.aptoParaAtividadeFisica) {
    throw new Error('Antes de seguir, procure avaliacao medica para confirmar sua aptidao fisica.');
  }

  if (
    !healthFlags.semHistoricoHipertensao ||
    !healthFlags.semHistoricoCardiaco ||
    !healthFlags.semRestricaoMedicaExercicio
  ) {
    throw new Error('Para comecar com seguranca, regularize suas restricoes de saude e procure orientacao medica antes do cadastro.');
  }
}

function throwFriendlyUniqueError(error: any): never {
  const detail = String(error?.detail || '');
  const constraint = String(error?.constraint || '');

  if (detail.includes('(cpf)') || constraint.includes('cpf')) {
    throw new Error('CPF ja cadastrado.');
  }

  if (detail.includes('(email)') || constraint.includes('email')) {
    throw new Error('Email ja cadastrado.');
  }

  throw new Error('Nao foi possivel concluir o cadastro por conflito de dados.');
}

export async function registerUser(
  data: {
    email: string;
    password: string;
    name: string;
    cpf: string;
    phone: string;
    role?: 'user' | 'personal' | 'nutri' | 'admin';
    healthFlags: HealthFlags;
  }
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  const email = data.email.toLowerCase().trim();
  const name = data.name.trim();
  const cpf = normalizeCpf(data.cpf);
  const phone = normalizePhone(data.phone);
  const role = data.role || 'user';

  if (!isValidCpf(cpf)) {
    throw new Error('CPF invalido.');
  }

  if (phone.length < 10 || phone.length > 11) {
    throw new Error('Telefone invalido.');
  }

  validateHealthFlags(data.healthFlags);

  const hashedPassword = await bcryptjs.hash(data.password, 10);

  try {
    const result = await pool.query(
      `INSERT INTO users (
        email,
        password,
        role,
        name,
        cpf,
        phone,
        sem_historico_hipertensao,
        sem_historico_cardiaco,
        sem_restricao_medica_exercicio,
        apto_para_atividade_fisica,
        aceita_responsabilidade_informacoes,
        profile_completed
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${USER_SELECT_FIELDS}`,
      [
        email,
        hashedPassword,
        role,
        name,
        cpf,
        phone,
        data.healthFlags.semHistoricoHipertensao,
        data.healthFlags.semHistoricoCardiaco,
        data.healthFlags.semRestricaoMedicaExercicio,
        data.healthFlags.aptoParaAtividadeFisica,
        data.healthFlags.aceitaResponsabilidadeInformacoes,
        false,
      ]
    );

    const user = mapUserRow(result.rows[0]);

    // Create free tier subscription
    await assignFreeSubscription(user.id);

    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      profileCompleted: user.profileCompleted
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email
    });

    return { user, accessToken, refreshToken };
  } catch (error: any) {
    if (error.code === '23505') {
      throwFriendlyUniqueError(error);
    }
    throw error;
  }
}

export async function loginUser(
  email: string,
  password: string
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

  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    profileCompleted: user.profileCompleted
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email
  });

  return { user, accessToken, refreshToken };
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
        throw new Error('Cadastro via OAuth esta temporariamente indisponivel. Use email e senha.');
      } else {
        // Update existing user with OAuth ID
        await pool.query(
          `UPDATE users SET ${oauthField} = $1, oauth_provider = $2 WHERE id = $3`,
          [oauthId, provider, userRow.id]
        );
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

    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      profileCompleted: user.profileCompleted
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email
    });

    return { user, accessToken, refreshToken, isNewUser };
  } catch (error: any) {
    console.error('OAuth login error:', error);
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
    healthFlags: {
      semHistoricoHipertensao: row.sem_historico_hipertensao,
      semHistoricoCardiaco: row.sem_historico_cardiaco,
      semRestricaoMedicaExercicio: row.sem_restricao_medica_exercicio,
      aptoParaAtividadeFisica: row.apto_para_atividade_fisica,
      aceitaResponsabilidadeInformacoes: row.aceita_responsabilidade_informacoes,
    },
    profileCompleted: row.profile_completed || false,
    oauthGoogleId: row.oauth_google_id,
    oauthAppleId: row.oauth_apple_id
  };
}
