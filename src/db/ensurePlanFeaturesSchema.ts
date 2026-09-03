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
  ['performance', 'Performance', 'Progressao por exercicio, recordes pessoais e evolucao de carga.'],
  ['reports', 'Relatorios', 'Relatorios e insights de desempenho.'],
  ['diet', 'Dieta', 'Recursos de alimentacao e planejamento nutricional.'],
  ['movement_lab', 'Lab de Movimento', 'Analise de execucao por camera (beta). Recurso pago — saiu do Free em ago/2026.'],
  ['movement_lab_guided', 'Lab de Movimento — Guiado pela ficha', 'Abrir o Lab de um exercicio da ficha, contar series/reps e gravar execucao real (Spec 022). Recurso pago — saiu do Free em ago/2026.'],
  ['retro_workout_enabled', 'Registro Retroativo de Treino', 'Registrar treino feito nos ultimos 3 dias que o aluno esqueceu de marcar (Spec 024). Flag = kill-switch; liberada no Free.'],
  ['challenges', 'Desafios', 'Participar de desafio criado pelo personal (Spec 034 C2). Liberada no Free por decisao de produto: cobrar do aluno para participar de um desafio que o personal dele criou quebraria o compromisso assumido com a turma.'],
  ['free_workout', 'Treino Livre', 'Aluno monta treino ad-hoc e executa com a engine de series. Kill-switch; liberada no Free.'],
  ['readiness', 'Prontidao (S2CORE Readiness)', 'Motor de prontidao diaria: score, motivos, confianca e recomendacao de intensidade (SPEC P3). NAO liberada por padrao — rollout gradual exigido pela SPEC §74/§75.'],
] as const;

/**
 * Plano Free: sem catálogo geral de treinos, sem ficha do personal, sem IA e sem
 * histórico — o resto do essencial entra.
 *
 * `tracker` entra no Free (ago/2026): o item já aparecia no menu de todo aluno e
 * a corrida já era gravada em `activity_sessions`, mas o check-in que alimenta
 * streak/XP/score tomava 403 e morria num catch silencioso — o aluno registrava
 * dado que nenhum motor lia. Ou liberava, ou escondia; liberar é coerente com a
 * tese (o Tracker é insumo do score, não capacidade premium).
 *
 * `movement_lab*` sai do Free na mesma troca — o beta de validação cumpriu o
 * papel e o recurso vira pago. A flag continua sendo o kill-switch: devolver as
 * duas chaves a esta lista religa o Lab no Free sem migration.
 *
 * `free_workout` nasce no Free pelo mesmo argumento do tracker: montar o próprio
 * treino é insumo do score (execução real, com séries e carga), não capacidade
 * premium. A flag é só kill-switch de UI — a API de registro de sessão não é
 * gateada por ela, porque `source: 'free'` já é o caminho do registro retroativo.
 *
 * `readiness` NÃO entra em nenhum plano por padrão, nem no Free nem no pago. A
 * SPEC P3 §74/§75 exige rollout gradual (interno → beta fechado → 10% → …), e a
 * flag é o mecanismo. Liberar para todo mundo no primeiro deploy contrariaria a
 * própria SPEC — e um motor de decisão fisiológica é a última coisa que se
 * solta sem observar comportamento antes.
 */
const FREE_PRODUCT_FEATURES: string[] = ['today', 'workouts_today', 'home_workouts', 'profile', 'settings', 'tracker', 'retro_workout_enabled', 'challenges', 'free_workout'];

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
  'movement_lab',
  'movement_lab_guided',
  'retro_workout_enabled',
  'challenges',
  'free_workout',
];

/**
 * Features que NÃO entram em nenhum plano por padrão — nem no Premium.
 *
 * `readiness` está aqui porque a SPEC Mobile P3 §74/§75 exige rollout gradual
 * (interno → beta fechado → 10% → …), e o Premium liga tudo do catálogo. Sem
 * esta exclusão a feature nasceria ativa para todo assinante Premium no
 * primeiro deploy — exatamente o que a SPEC proíbe, e a última coisa que se
 * solta sem observar comportamento quando o recurso é um motor de decisão
 * fisiológica.
 *
 * Liberar é operação de admin (`POST /api/plans/...`), coorte por coorte.
 */
const ROLLOUT_ONLY_FEATURES: string[] = ['readiness'];

const PREMIUM_PRODUCT_FEATURES: string[] = featureCatalog
  .map((row) => row[0] as string)
  .filter((key) => !ROLLOUT_ONLY_FEATURES.includes(key));

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
