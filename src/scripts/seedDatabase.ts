import pool from '../config/database';
import bcryptjs from 'bcryptjs';

const schema = `
-- Users table with OAuth and profile fields
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'personal', 'nutri', 'admin')),
  access_profile VARCHAR(50),
  name VARCHAR(255),
  cpf VARCHAR(11) UNIQUE,
  phone VARCHAR(20),
  photo_url VARCHAR(500),
  fitness_goal VARCHAR(100),
  experience_level VARCHAR(50),
  height_cm DECIMAL(5,2),
  weight_kg DECIMAL(6,2),
  dietary_restrictions TEXT,
  sem_historico_hipertensao BOOLEAN DEFAULT TRUE,
  sem_historico_cardiaco BOOLEAN DEFAULT TRUE,
  sem_restricao_medica_exercicio BOOLEAN DEFAULT TRUE,
  apto_para_atividade_fisica BOOLEAN DEFAULT TRUE,
  aceita_responsabilidade_informacoes BOOLEAN DEFAULT TRUE,
  profile_completed BOOLEAN DEFAULT FALSE,
  oauth_google_id VARCHAR(255) UNIQUE,
  oauth_apple_id VARCHAR(255) UNIQUE,
  oauth_provider VARCHAR(50),
  onboarding_answers JSONB,
  parq_answers JSONB,
  parq_form_version VARCHAR(64),
  parq_signed_at TIMESTAMPTZ,
  parq_signature_data TEXT,
  parq_any_yes BOOLEAN,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription tiers
CREATE TABLE IF NOT EXISTS subscription_tiers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  price_brl DECIMAL(10,2) NOT NULL,
  max_videos_per_month INT,
  features JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User subscriptions
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES subscription_tiers(id),
  status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'trial')),
  mercado_pago_subscription_id VARCHAR(255),
  trial_ends_at TIMESTAMP,
  active_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_to TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Plans (ACL by plan)
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Features catalog
CREATE TABLE IF NOT EXISTS features (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  key VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Plan-feature matrix
CREATE TABLE IF NOT EXISTS plan_features (
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id, feature_id)
);

-- Payments ledger
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES user_subscriptions(id),
  mercado_pago_payment_id VARCHAR(255) UNIQUE,
  amount_brl DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'failed', 'refunded')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  url VARCHAR(500) NOT NULL,
  thumbnail_url VARCHAR(500),
  duration_seconds INTEGER,
  has_subtitles BOOLEAN NOT NULL DEFAULT FALSE,
  has_libras BOOLEAN NOT NULL DEFAULT FALSE,
  has_audio_description BOOLEAN NOT NULL DEFAULT FALSE,
  low_impact_friendly BOOLEAN NOT NULL DEFAULT FALSE,
  accessibility_notes TEXT,
  personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Video-Tags junction table
CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- Video access (which subscription tiers can access which videos)
CREATE TABLE IF NOT EXISTS video_access (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES subscription_tiers(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tier_id)
);

-- Gamification summary
CREATE TABLE IF NOT EXISTS user_gamification_stats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  last_checkin_date DATE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily check-ins
CREATE TABLE IF NOT EXISTS user_daily_checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_key DATE NOT NULL,
  source VARCHAR(20) NOT NULL CHECK (source IN ('workout', 'activity')),
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date_key)
);

-- Workout logs
CREATE TABLE IF NOT EXISTS user_workout_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  muscle_groups TEXT[] NOT NULL DEFAULT '{}',
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Activity logs
CREATE TABLE IF NOT EXISTS user_activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type VARCHAR(20) NOT NULL CHECK (activity_type IN ('walk', 'run', 'cycling')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  distance_km DECIMAL(10,2) NOT NULL DEFAULT 0,
  pace DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Personal-student assignments
CREATE TABLE IF NOT EXISTS personal_student_assignments (
  id SERIAL PRIMARY KEY,
  personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(personal_id, student_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_oauth_google ON users(oauth_google_id);
CREATE INDEX IF NOT EXISTS idx_users_oauth_apple ON users(oauth_apple_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_plan_features_plan_id ON plan_features(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_features_feature_id ON plan_features(feature_id);
CREATE INDEX IF NOT EXISTS idx_videos_personal_id ON videos(personal_id);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
CREATE INDEX IF NOT EXISTS idx_gamification_checkins_user_date ON user_daily_checkins(user_id, date_key);
CREATE INDEX IF NOT EXISTS idx_workout_logs_user_completed_at ON user_workout_logs(user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created_at ON user_activity_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personal_assignments_personal_id ON personal_student_assignments(personal_id, status);
CREATE INDEX IF NOT EXISTS idx_personal_assignments_student_id ON personal_student_assignments(student_id, status);
`;

async function runMigration() {
  try {
    console.log('Running database schema migration...');
    
    const statements = schema.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        await pool.query(statement);
      }
    }

    await ensureUserRegistrationFields();
    await ensureGamificationTables();
    await ensurePersonalTables();
    await ensureVideoAccessibilityFields();

    console.log('✅ Database schema created successfully');
    
    // Seed default subscription tiers
    await seedSubscriptionTiers();
    await seedPlansAndFeatures();
    
    // Seed default tags
    await seedTags();

    // Seed development users
    await seedUsers();
    await seedPersonalAssignments();
    await seedPersonalDashboardActivity();
    
    console.log('✅ Database seeded successfully');
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function ensureUserRegistrationFields() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf VARCHAR(11)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_profile VARCHAR(50)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_hipertensao BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_cardiaco BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_restricao_medica_exercicio BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apto_para_atividade_fisica BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS aceita_responsabilidade_informacoes BOOLEAN DEFAULT TRUE`);
}

async function ensureGamificationTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_gamification_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_date DATE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_daily_checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key DATE NOT NULL,
      source VARCHAR(20) NOT NULL CHECK (source IN ('workout', 'activity')),
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, date_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_workout_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workout_id VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      muscle_groups TEXT[] NOT NULL DEFAULT '{}',
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_activity_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_type VARCHAR(20) NOT NULL CHECK (activity_type IN ('walk', 'run', 'cycling')),
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      distance_km DECIMAL(10,2) NOT NULL DEFAULT 0,
      pace DECIMAL(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gamification_checkins_user_date ON user_daily_checkins(user_id, date_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workout_logs_user_completed_at ON user_workout_logs(user_id, completed_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created_at ON user_activity_logs(user_id, created_at DESC)`);
}

async function ensurePersonalTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_student_assignments (
      id SERIAL PRIMARY KEY,
      personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(personal_id, student_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_personal_assignments_personal_id ON personal_student_assignments(personal_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_personal_assignments_student_id ON personal_student_assignments(student_id, status)`);
}

async function ensureVideoAccessibilityFields() {
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS has_subtitles BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS has_libras BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS has_audio_description BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS low_impact_friendly BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS accessibility_notes TEXT`);
}

async function seedSubscriptionTiers() {
  const tiers = [
    { name: 'Free', price_brl: 0, max_videos_per_month: 10, features: { includes: ['limited_videos', 'basic_support'] } },
    { name: 'Pro', price_brl: 49.90, max_videos_per_month: 50, features: { includes: ['unlimited_search', 'workout_plans', 'email_support', 'personal_trainer_videos'] } },
    { name: 'Premium', price_brl: 99.90, max_videos_per_month: null, features: { includes: ['unlimited_videos', 'live_sessions', 'direct_messaging', 'priority_support'] } }
  ];

  for (const tier of tiers) {
    await pool.query(
      `INSERT INTO subscription_tiers (name, price_brl, max_videos_per_month, features)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [tier.name, tier.price_brl, tier.max_videos_per_month, JSON.stringify(tier.features)]
    );
  }
}

async function seedPlansAndFeatures() {
  const plans = [
    { name: 'Free', description: 'Plano gratuito com funcionalidades essenciais.' },
    { name: 'Pro', description: 'Plano intermediario com recursos avancados.' },
    { name: 'Premium', description: 'Plano completo com todos os recursos do app.' },
  ];

  for (const plan of plans) {
    await pool.query(
      `INSERT INTO plans (name, description)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, updated_at = CURRENT_TIMESTAMP`,
      [plan.name, plan.description]
    );
  }

  const features = [
    { key: 'today', name: 'Home', description: 'Painel da rotina diaria e atalhos.' },
    { key: 'workouts_today', name: 'Treinos de Hoje', description: 'Conteudo de treino recomendado para o dia.' },
    { key: 'workouts', name: 'Treinos', description: 'Biblioteca geral de treinos.' },
    { key: 'home_workouts', name: 'Treinos em casa', description: 'Treinos com foco em praticidade para casa.' },
    { key: 'tracker', name: 'Tracker', description: 'Registro de atividades e acompanhamento de progresso.' },
    { key: 'training_ai', name: 'Treino Guiado por IA', description: 'Recursos de IA para guiar o treino.' },
    { key: 'suggested_training', name: 'Treino Sugerido', description: 'Sugestoes personalizadas de treino.' },
    { key: 'messages', name: 'Mensagens', description: 'Canal de mensagens com suporte/profissionais.' },
    { key: 'workout_history', name: 'Historico', description: 'Historico de treinos e atividades realizadas.' },
    { key: 'profile', name: 'Perfil do Usuario', description: 'Dados do perfil e preferencias do usuario.' },
    { key: 'settings', name: 'Configuracoes', description: 'Configuracoes da conta e preferencias gerais.' },
    { key: 'reports', name: 'Relatorios', description: 'Relatorios e insights de desempenho.' },
    { key: 'diet', name: 'Dieta', description: 'Recursos de alimentacao e planejamento nutricional.' },
  ];

  for (const feature of features) {
    await pool.query(
      `INSERT INTO features (name, description, key)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         updated_at = CURRENT_TIMESTAMP`,
      [feature.name, feature.description, feature.key]
    );
  }

  const matrix: Record<string, string[]> = {
    Free: ['today', 'workouts_today', 'home_workouts', 'profile', 'settings'],
    Pro: [
      'today',
      'workouts_today',
      'home_workouts',
      'workouts',
      'tracker',
      'messages',
      'workout_history',
      'profile',
      'settings',
      'suggested_training',
    ],
    Premium: features.map((feature) => feature.key),
  };

  for (const planName of Object.keys(matrix)) {
    const planResult = await pool.query(`SELECT id FROM plans WHERE name = $1`, [planName]);
    if (planResult.rows.length === 0) continue;
    const planId = planResult.rows[0].id;

    for (const feature of features) {
      const enabled = matrix[planName].includes(feature.key);
      await pool.query(
        `INSERT INTO plan_features (plan_id, feature_id, enabled)
         SELECT $1, f.id, $2
         FROM features f
         WHERE f.key = $3
         ON CONFLICT (plan_id, feature_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           updated_at = CURRENT_TIMESTAMP`,
        [planId, enabled, feature.key]
      );
    }
  }
}

async function seedTags() {
  const tags = [
    { name: 'Perda de Peso', slug: 'perda-de-peso' },
    { name: 'Ganho de Massa', slug: 'ganho-de-massa' },
    { name: 'Aeróbico', slug: 'aerobico' },
    { name: 'Força', slug: 'forca' },
    { name: 'Iniciante', slug: 'iniciante' },
    { name: 'Intermediário', slug: 'intermediario' },
    { name: 'Avançado', slug: 'avancado' },
    { name: 'Flexibilidade', slug: 'flexibilidade' },
    { name: 'Yoga', slug: 'yoga' },
    { name: 'Pilates', slug: 'pilates' },
    { name: 'HIIT', slug: 'hiit' },
    { name: 'Cardio', slug: 'cardio' },
    { name: 'Peito', slug: 'peito' },
    { name: 'Perna', slug: 'perna' },
    { name: 'Costas', slug: 'costas' },
    { name: 'Braços', slug: 'bracos' },
    { name: 'Ombro', slug: 'ombro' },
    { name: 'Glúteo', slug: 'gluteo' }
  ];

  for (const tag of tags) {
    await pool.query(
      `INSERT INTO tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
      [tag.name, tag.slug]
    );
  }
}

async function seedUsers() {
  const users = [
    {
      email: 'admin@treinai.com',
      password: '123456',
      name: 'Admin MinutoFit',
      role: 'admin',
      cpf: '52998224725',
      phone: '85999990001',
    },
    {
      email: 'personal@treinai.com',
      password: '123456',
      name: 'Personal MinutoFit',
      role: 'personal',
      cpf: '11144477735',
      phone: '85999990002',
    },
    {
      email: 'teste1@treinai.com',
      password: '123456',
      name: 'Aluno Demo',
      role: 'user',
      cpf: '12345678909',
      phone: '85999990003',
      tierName: 'Premium',
    },
    {
      email: 'gerencia@minutofit.com.br',
      password: '123456',
      name: 'Gerencia MinutoFit',
      role: 'admin',
      accessProfile: 'admin_owner',
      cpf: '98765432100',
      phone: '85999990009',
      tierName: 'Premium',
    },
    {
      email: 'natalia.freitas@treinai.com',
      password: '123456',
      name: 'Natália Freitas',
      role: 'user',
      cpf: '12345678910',
      phone: '85999990004',
      tierName: 'Premium',
      fitnessGoal: 'hypertrophy',
      experienceLevel: 'advanced',
    },
    {
      email: 'sabrina.cardoso@treinai.com',
      password: '123456',
      name: 'Sabrina Cardoso',
      role: 'user',
      cpf: '12345678911',
      phone: '85999990005',
      tierName: 'Premium',
      fitnessGoal: 'weight_loss',
      experienceLevel: 'beginner',
    },
    {
      email: 'carla.nunes@treinai.com',
      password: '123456',
      name: 'Carla Nunes',
      role: 'user',
      cpf: '12345678912',
      phone: '85999990006',
      tierName: 'Pro',
      fitnessGoal: 'conditioning',
      experienceLevel: 'intermediate',
    },
    {
      email: 'pedro.lima@treinai.com',
      password: '123456',
      name: 'Pedro Lima',
      role: 'user',
      cpf: '12345678913',
      phone: '85999990007',
      tierName: 'Free',
      fitnessGoal: 'weight_loss',
      experienceLevel: 'beginner',
    },
    {
      email: 'helena.ribeiro@treinai.com',
      password: '123456',
      name: 'Helena Ribeiro',
      role: 'user',
      cpf: '12345678914',
      phone: '85999990008',
      tierName: 'Pro',
      fitnessGoal: 'hypertrophy',
      experienceLevel: 'intermediate',
    },
  ];

  for (const user of users) {
    const hashedPassword = await bcryptjs.hash(user.password, 10);

    const insertResult = await pool.query(
      `INSERT INTO users (
         email,
         password,
         role,
         access_profile,
         name,
         cpf,
         phone,
         fitness_goal,
         experience_level,
         sem_historico_hipertensao,
         sem_historico_cardiaco,
         sem_restricao_medica_exercicio,
         apto_para_atividade_fisica,
         aceita_responsabilidade_informacoes,
         profile_completed
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         password = EXCLUDED.password,
         role = EXCLUDED.role,
         access_profile = EXCLUDED.access_profile,
         name = EXCLUDED.name,
         cpf = EXCLUDED.cpf,
         phone = EXCLUDED.phone,
         fitness_goal = EXCLUDED.fitness_goal,
         experience_level = EXCLUDED.experience_level,
         sem_historico_hipertensao = EXCLUDED.sem_historico_hipertensao,
         sem_historico_cardiaco = EXCLUDED.sem_historico_cardiaco,
         sem_restricao_medica_exercicio = EXCLUDED.sem_restricao_medica_exercicio,
         apto_para_atividade_fisica = EXCLUDED.apto_para_atividade_fisica,
         aceita_responsabilidade_informacoes = EXCLUDED.aceita_responsabilidade_informacoes
       RETURNING id`,
      [
        user.email,
        hashedPassword,
        user.role,
        user.accessProfile || null,
        user.name,
        user.cpf,
        user.phone,
        user.fitnessGoal || null,
        user.experienceLevel || null,
      ]
    );

    const userId = insertResult.rows[0].id;
    const tierName = user.tierName || (user.role === 'user' ? 'Free' : 'Premium');
    const tierResult = await pool.query(`SELECT id FROM subscription_tiers WHERE name = $1`, [tierName]);

    if (tierResult.rows.length > 0) {
      const existingSubscription = await pool.query(
        `SELECT id FROM user_subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
        [userId]
      );

      if (existingSubscription.rows.length === 0) {
        await pool.query(
          `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
           VALUES ($1, $2, 'active', CURRENT_TIMESTAMP)`,
          [userId, tierResult.rows[0].id]
        );
      }
    }

    await pool.query(
      `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
       VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }

  await pool.query(`UPDATE users SET cpf = '52998224725' WHERE email = 'admin@treinai.com' AND (cpf IS NULL OR cpf = '')`);
  await pool.query(`UPDATE users SET cpf = '11144477735' WHERE email = 'personal@treinai.com' AND (cpf IS NULL OR cpf = '')`);
  await pool.query(`UPDATE users SET cpf = '12345678909' WHERE email = 'teste1@treinai.com' AND (cpf IS NULL OR cpf = '')`);
  await pool.query(`UPDATE users SET cpf = '98765432100' WHERE email = 'gerencia@minutofit.com.br' AND (cpf IS NULL OR cpf = '')`);
  await pool.query(`UPDATE users SET phone = '85999990001' WHERE email = 'admin@treinai.com' AND (phone IS NULL OR phone = '')`);
  await pool.query(`UPDATE users SET phone = '85999990002' WHERE email = 'personal@treinai.com' AND (phone IS NULL OR phone = '')`);
  await pool.query(`UPDATE users SET phone = '85999990003' WHERE email = 'teste1@treinai.com' AND (phone IS NULL OR phone = '')`);
  await pool.query(`UPDATE users SET phone = '85999990009' WHERE email = 'gerencia@minutofit.com.br' AND (phone IS NULL OR phone = '')`);
  // Conta demo: sem perfil restrito + assinatura Premium para liberar todas as features nas telas de aluno (QA)
  await pool.query(`UPDATE users SET access_profile = NULL WHERE email = 'teste1@treinai.com'`);
  await pool.query(
    `UPDATE user_subscriptions us
     SET tier_id = st.id, updated_at = COALESCE(us.updated_at, CURRENT_TIMESTAMP)
     FROM users u, subscription_tiers st
     WHERE u.id = us.user_id
       AND u.email = 'teste1@treinai.com'
       AND us.status = 'active'
       AND st.name = 'Premium'`,
  );
  await pool.query(`UPDATE users SET role = 'admin', access_profile = 'admin_owner' WHERE email = 'gerencia@minutofit.com.br'`);
  await pool.query(`UPDATE users SET sem_historico_hipertensao = TRUE WHERE sem_historico_hipertensao IS NULL`);
  await pool.query(`UPDATE users SET sem_historico_cardiaco = TRUE WHERE sem_historico_cardiaco IS NULL`);
  await pool.query(`UPDATE users SET sem_restricao_medica_exercicio = TRUE WHERE sem_restricao_medica_exercicio IS NULL`);
  await pool.query(`UPDATE users SET apto_para_atividade_fisica = TRUE WHERE apto_para_atividade_fisica IS NULL`);
  await pool.query(`UPDATE users SET aceita_responsabilidade_informacoes = TRUE WHERE aceita_responsabilidade_informacoes IS NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN cpf SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN phone SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN sem_historico_hipertensao SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN sem_historico_cardiaco SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN sem_restricao_medica_exercicio SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN apto_para_atividade_fisica SET NOT NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN aceita_responsabilidade_informacoes SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cpf ON users(cpf)`);
}

async function seedPersonalAssignments() {
  const personalResult = await pool.query(`SELECT id FROM users WHERE email = 'personal@treinai.com' LIMIT 1`);
  if (personalResult.rows.length === 0) return;

  const personalId = personalResult.rows[0].id;
  const studentEmails = [
    'teste1@treinai.com',
    'natalia.freitas@treinai.com',
    'sabrina.cardoso@treinai.com',
    'carla.nunes@treinai.com',
    'pedro.lima@treinai.com',
    'helena.ribeiro@treinai.com',
  ];

  for (const email of studentEmails) {
    const studentResult = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email]);
    if (studentResult.rows.length === 0) continue;

    await pool.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (personal_id, student_id)
       DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP`,
      [personalId, studentResult.rows[0].id]
    );
  }
}

async function seedPersonalDashboardActivity() {
  const students = [
    {
      email: 'natalia.freitas@treinai.com',
      xp: 220,
      streak: 9,
      dayOffsets: [1, 2, 4, 5, 6],
      lastWorkoutTitle: 'Treino A - Pernas e glúteo',
      muscleGroups: ['legs', 'glutes'],
    },
    {
      email: 'sabrina.cardoso@treinai.com',
      xp: 80,
      streak: 1,
      dayOffsets: [6],
      lastWorkoutTitle: 'Treino express',
      muscleGroups: ['cardio'],
    },
    {
      email: 'carla.nunes@treinai.com',
      xp: 160,
      streak: 4,
      dayOffsets: [2, 4, 6],
      lastWorkoutTitle: 'Treino funcional',
      muscleGroups: ['full_body'],
    },
    {
      email: 'pedro.lima@treinai.com',
      xp: 40,
      streak: 0,
      dayOffsets: [],
      lastWorkoutTitle: null,
      muscleGroups: [],
    },
    {
      email: 'helena.ribeiro@treinai.com',
      xp: 190,
      streak: 7,
      dayOffsets: [1, 3, 4, 6],
      lastWorkoutTitle: 'Treino B - Peito e costas',
      muscleGroups: ['chest', 'back'],
    },
    {
      email: 'teste1@treinai.com',
      xp: 60,
      streak: 2,
      dayOffsets: [3, 5],
      lastWorkoutTitle: 'Treino de adaptação',
      muscleGroups: ['mobility', 'core'],
    },
  ];

  for (const student of students) {
    const userResult = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [student.email]);
    if (userResult.rows.length === 0) continue;

    const userId = userResult.rows[0].id;
    await pool.query(`DELETE FROM user_daily_checkins WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_workout_logs WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_activity_logs WHERE user_id = $1`, [userId]);

    const latestOffset = student.dayOffsets[0] ?? null;
    const lastCheckinDate = latestOffset == null
      ? null
      : new Date(Date.now() - latestOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO user_gamification_stats (user_id, xp, current_streak, last_checkin_date, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         xp = EXCLUDED.xp,
         current_streak = EXCLUDED.current_streak,
         last_checkin_date = EXCLUDED.last_checkin_date,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, student.xp, student.streak, lastCheckinDate]
    );

    for (const [index, dayOffset] of student.dayOffsets.entries()) {
      const completedAt = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
      const dateKey = completedAt.toISOString().slice(0, 10);

      await pool.query(
        `INSERT INTO user_daily_checkins (user_id, date_key, source, xp_awarded)
         VALUES ($1, $2, 'workout', 20)
         ON CONFLICT (user_id, date_key) DO UPDATE SET xp_awarded = EXCLUDED.xp_awarded`,
        [userId, dateKey]
      );

      await pool.query(
        `INSERT INTO user_workout_logs (user_id, workout_id, title, muscle_groups, completed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userId,
          `${student.email}-workout-${index + 1}`,
          student.lastWorkoutTitle || 'Treino de acompanhamento',
          student.muscleGroups,
          completedAt.toISOString(),
        ]
      );
    }
  }
}

runMigration();
