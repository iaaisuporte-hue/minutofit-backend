import pool from '../config/database';

const featureCatalog = [
  ['today', 'Home', 'Painel da rotina diaria e atalhos.'],
  ['workouts_today', 'Treinos de Hoje', 'Conteudo de treino recomendado para o dia.'],
  ['workouts', 'Treinos', 'Biblioteca geral de treinos.'],
  ['home_workouts', 'Treinos em casa', 'Treinos com foco em praticidade para casa.'],
  ['tracker', 'Tracker', 'Registro de atividades e acompanhamento de progresso.'],
  ['training_ai', 'Treino Guiado por IA', 'Recursos de IA para guiar o treino.'],
  ['suggested_training', 'Treino Sugerido', 'Sugestoes personalizadas de treino.'],
  ['messages', 'Mensagens', 'Canal de mensagens com suporte/profissionais.'],
  ['workout_history', 'Historico', 'Historico de treinos e atividades realizadas.'],
  ['profile', 'Perfil do Usuario', 'Dados do perfil e preferencias do usuario.'],
  ['settings', 'Configuracoes', 'Configuracoes da conta e preferencias gerais.'],
  ['reports', 'Relatorios', 'Relatorios e insights de desempenho.'],
  ['diet', 'Dieta', 'Recursos de alimentacao e planejamento nutricional.'],
] as const;

/** Plano Free: sem catálogo geral de treinos / ficha — só Hoje, sugestão do dia, treinos em casa, perfil e config. */
const FREE_PRODUCT_FEATURES: string[] = ['today', 'workouts_today', 'home_workouts', 'profile', 'settings'];

const PRO_PRODUCT_FEATURES: string[] = [
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
  'training_ai',
];

const PREMIUM_PRODUCT_FEATURES: string[] = featureCatalog.map((row) => row[0]);

const defaultsByPlan: Record<string, string[]> = {
  Free: FREE_PRODUCT_FEATURES,
  Pro: PRO_PRODUCT_FEATURES,
  Premium: PREMIUM_PRODUCT_FEATURES,
};

export async function ensurePlanFeaturesSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      key VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_features (
      plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plan_id, feature_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plan_features_plan_id ON plan_features(plan_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plan_features_feature_id ON plan_features(feature_id)`);

  const plans = [
    ['Free', 'Plano gratuito com funcionalidades essenciais.'],
    ['Pro', 'Plano intermediario com recursos avancados.'],
    ['Premium', 'Plano completo com todos os recursos do app.'],
  ] as const;

  for (const [name, description] of plans) {
    await pool.query(
      `INSERT INTO plans (name, description)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, updated_at = CURRENT_TIMESTAMP`,
      [name, description]
    );
  }

  for (const [key, name, description] of featureCatalog) {
    await pool.query(
      `INSERT INTO features (key, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = CURRENT_TIMESTAMP`,
      [key, name, description]
    );
  }

  for (const [planName, featureKeys] of Object.entries(defaultsByPlan)) {
    const planRes = await pool.query(`SELECT id FROM plans WHERE name = $1 LIMIT 1`, [planName]);
    if (planRes.rows.length === 0) continue;
    const planId = planRes.rows[0].id;

    for (const [key] of featureCatalog) {
      const enabled = featureKeys.includes(key);
      await pool.query(
        `INSERT INTO plan_features (plan_id, feature_id, enabled)
         SELECT $1, f.id, $2
         FROM features f
         WHERE f.key = $3
         ON CONFLICT (plan_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`,
        [planId, enabled, key]
      );
    }
  }
}
