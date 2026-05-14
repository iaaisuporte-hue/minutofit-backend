/**
 * Adiciona onboarding_answers (JSONB) à tabela users.
 * Persiste as respostas do wizard de onboarding do aluno —
 * preferências de treino, lesões, dias por semana, etc.
 * Substitui o armazenamento exclusivo em localStorage no frontend.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('users', {
    onboarding_answers: {
      type: 'jsonb',
      default: null,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'onboarding_answers');
};
