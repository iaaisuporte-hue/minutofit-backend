/**
 * Adds a non-destructive first-login password rotation flag.
 *
 * Existing users keep must_change_password=false. Direct-add flows can mark
 * newly created students as true so the temporary password is rotated before
 * the student enters the app.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    must_change_password: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['must_change_password']);
};
