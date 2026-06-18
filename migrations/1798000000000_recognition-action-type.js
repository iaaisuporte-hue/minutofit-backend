/**
 * Adiciona 'recognition_sent' ao CHECK constraint de action_type
 * em personal_relationship_actions — Máquina de Reconhecimento (Fase A).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // O constraint foi criado inline — o nome gerado pelo PG é
  // personal_relationship_actions_action_type_check
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

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
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
        'quick_nudge'
      ))
  `);
};
