/**
 * Adiciona onboarding_answers (JSONB) à tabela users.
 * Persiste as respostas do wizard de onboarding do aluno —
 * preferências de treino, lesões, dias por semana, etc.
 * Substitui o armazenamento exclusivo em localStorage no frontend.
 *
 * Idempotente: IF NOT EXISTS protege contra execução em BDs onde
 * ensureUsersCoreColumns.ts já adicionou a coluna.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarding_answers jsonb DEFAULT NULL
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'onboarding_answers');
};
