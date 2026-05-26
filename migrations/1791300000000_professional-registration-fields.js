/**
 * Adds professional-specific profile columns to the users table so that
 * admin-created professionals (nutri/personal) can have their registry code,
 * specialty and bio persisted at registration time.
 *
 * These are nullable for regular users and populated only for professionals.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    registry_code: {
      type: 'VARCHAR(50)',
      notNull: false,
    },
    specialty: {
      type: 'VARCHAR(200)',
      notNull: false,
    },
    bio: {
      type: 'TEXT',
      notNull: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['registry_code', 'specialty', 'bio']);
};
