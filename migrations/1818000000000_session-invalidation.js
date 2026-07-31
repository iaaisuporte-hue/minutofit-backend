/**
 * Spec 031 — logout que realmente encerra a sessão.
 *
 * `POST /auth/logout` só revogava o refresh token quando o CLIENTE enviava
 * `refreshToken` no body. Sem body, respondia 200 e o refresh continuava válido
 * pelos 7 dias de TTL — ou seja, o logout não encerrava nada de fato, e não
 * havia forma de revogar por usuário.
 *
 * `users.sessions_invalidated_at` é o carimbo de "todos os refresh tokens
 * emitidos antes deste instante estão mortos". Espelha exatamente o mecanismo
 * já usado por `password_changed_at` na rotação de refresh — comparação com o
 * `iat` do JWT, sem precisar enumerar a denylist.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS sessions_invalidated_at TIMESTAMPTZ
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS sessions_invalidated_at
  `);
};
