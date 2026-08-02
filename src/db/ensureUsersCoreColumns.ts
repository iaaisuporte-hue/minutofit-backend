import pool from '../config/database';

/**
 * Colunas de `users` usadas pelo authService / SELECT atual.
 * Idempotente — necessário em bancos criados antes desses campos (ex.: Render).
 */
const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf VARCHAR(11)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_profile VARCHAR(50)`,
  // Sem DEFAULT: NULL = "o aluno ainda não respondeu". Com `DEFAULT TRUE` todo
  // cadastro nascia declarando que não tem histórico cardíaco e está apto —
  // declaração que ninguém fez, já que o formulário de cadastro não pergunta.
  // Migration 1821000000000 remove o default de bancos existentes.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_hipertensao BOOLEAN`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_historico_cardiaco BOOLEAN`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sem_restricao_medica_exercicio BOOLEAN`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS apto_para_atividade_fisica BOOLEAN`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS aceita_responsabilidade_informacoes BOOLEAN`,
  // Liberação médica declarada pelo aluno que respondeu "sim" no PAR-Q (P1-1).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_medical_release_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(50)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_corefit_admin BOOLEAN NOT NULL DEFAULT FALSE`,
  // Segregação de função: super_admin (tudo) | support (read + ações reversíveis, sem delete/set-password)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_sub_role VARCHAR(20) NOT NULL DEFAULT 'super_admin'`,
];

export async function ensureUsersCoreColumns(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}
