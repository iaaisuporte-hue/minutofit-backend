/**
 * Adiciona 'payment_reminder_sent' ao CHECK de action_type em
 * personal_relationship_actions — módulo Financeiro do personal (Onda F1).
 *
 * O lembrete de cobrança é ação de relacionamento como qualquer outra: entra na
 * mesma timeline do aluno, pelo mesmo endpoint, e continua sendo disparado por
 * toque humano (wa.me). Uma tabela separada só para "lembretes" quebraria a
 * timeline única sem ganhar nada.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE personal_relationship_actions
      DROP CONSTRAINT IF EXISTS personal_relationship_actions_action_type_check
  `);

  await pgm.db.query(`
    ALTER TABLE personal_relationship_actions
      ADD CONSTRAINT personal_relationship_actions_action_type_check
      CHECK (action_type IN (
        'follow_up_marked',
        'observation',
        'bonus_offered',
        'light_workout_offered',
        'gradual_return_offered',
        'message_sent',
        'quick_nudge',
        'recognition_sent',
        'payment_reminder_sent'
      ))
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // As linhas do tipo novo violariam o CHECK anterior — saem antes dele voltar.
  await pgm.db.query(`
    DELETE FROM personal_relationship_actions WHERE action_type = 'payment_reminder_sent'
  `);

  await pgm.db.query(`
    ALTER TABLE personal_relationship_actions
      DROP CONSTRAINT IF EXISTS personal_relationship_actions_action_type_check
  `);

  await pgm.db.query(`
    ALTER TABLE personal_relationship_actions
      ADD CONSTRAINT personal_relationship_actions_action_type_check
      CHECK (action_type IN (
        'follow_up_marked',
        'observation',
        'bonus_offered',
        'light_workout_offered',
        'gradual_return_offered',
        'message_sent',
        'quick_nudge',
        'recognition_sent'
      ))
  `);
};
