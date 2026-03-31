import pool from '../config/database';

const STATEMENTS = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_answers JSONB',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_answers JSONB',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_form_version VARCHAR(64)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_signed_at TIMESTAMPTZ',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_signature_data TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS parq_any_yes BOOLEAN',
];

/**
 * Colunas para onboarding persistido, PAR-Q e assinatura (idempotente).
 * Executado na subida do servidor para bancos já existentes.
 */
export async function ensureComplianceSchema(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}
