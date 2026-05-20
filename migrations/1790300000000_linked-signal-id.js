/**
 * Adiciona linked_signal_id em personal_relationship_actions.
 *
 * Armazena o engagementStatus do aluno no momento da ação do personal
 * (ex: "at_risk", "fading"). Permite ao timeline mostrar:
 * "Você agiu quando o aluno estava em risco — ele voltou a treinar em 2d."
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('personal_relationship_actions', {
    linked_signal_id: {
      type: 'varchar(40)',
      notNull: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('personal_relationship_actions', 'linked_signal_id');
};
