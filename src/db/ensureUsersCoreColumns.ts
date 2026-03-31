import pool from '../config/database';

/**
 * Colunas de `users` usadas pelo authService / SELECT atual.
 * Idempotente — necessário em bancos criados antes desses campos (ex.: Render).
 */
const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf VARCHAR(11)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_profile VARCHAR(50)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_hipertensao BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_cardiaco BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_restricao_medica_exercicio BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS apto_para_atividade_fisica BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS aceita_responsabilidade_informacoes BOOLEAN DEFAULT TRUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(50)`,
];

export async function ensureUsersCoreColumns(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}
