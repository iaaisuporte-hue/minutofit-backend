/**
 * Destrava a exclusão de conta (LGPD art. 18, VI).
 *
 * ## O defeito
 *
 * `DELETE /api/user/account` respondia **500 para 100% das contas**, desde o
 * instante do cadastro. Toda criação de usuário grava `identity.user_created`
 * em `data_access_audit` com `actor_id = subject_user_id = o próprio usuário`
 * (userIdentityService). As duas FKs eram `NO ACTION`, então o
 * `DELETE FROM users` da transação estourava:
 *
 *     update or delete on table "users" violates foreign key constraint
 *     "data_access_audit_actor_id_fkey" on table "data_access_audit"
 *
 * Não existia caminho alternativo: o delete do admin usa o mesmo serviço.
 * Levantamento completo encontrou **12 FKs** para `users` sem ação de delete —
 * além da auditoria, `user_product_memberships.professional_id` e
 * `workout_adaptation_log.personal_id` prendiam o **personal**.
 *
 * ## A decisão de semântica (não é tudo CASCADE)
 *
 * - `data_access_audit.subject_user_id` → **CASCADE**. A linha descreve acesso
 *   AOS DADOS DESTE titular: é dado pessoal dele, e apagá-la é a própria
 *   eliminação. A prova de que a exclusão aconteceu fica no tombstone
 *   `account_deletions` (sem PII), que continua intacto.
 * - `data_access_audit.actor_id` → **SET NULL**. Aqui a linha pertence à trilha
 *   de OUTRO titular (ex.: o personal leu o snapshot do aluno). Apagá-la
 *   destruiria a evidência de acesso aos dados de um terceiro que não pediu
 *   exclusão nenhuma. Anonimiza-se o ator e preserva-se o registro.
 * - Demais colunas ("quem convidou", "quem concedeu", "qual personal") →
 *   **SET NULL**: são referência a um ator, não o dado em si. O registro do
 *   outro titular sobrevive sem o vínculo com quem saiu.
 *
 * Colunas `NOT NULL` que passam a aceitar NULL ganham o significado explícito
 * "ator removido" — nunca "nunca houve ator".
 */

/**
 * [tabela, coluna, ação, precisa DROP NOT NULL]
 * @type {Array<[string, string, 'CASCADE'|'SET NULL', boolean]>}
 */
const FKS = [
  // Auditoria de acesso a dado sensível
  ['data_access_audit', 'subject_user_id', 'CASCADE', false],
  ['data_access_audit', 'actor_id', 'SET NULL', true],
  // Memberships (o bônus do aluno aponta para o personal)
  ['user_product_memberships', 'professional_id', 'SET NULL', false],
  ['user_product_memberships', 'granted_by_user_id', 'SET NULL', false],
  ['user_product_memberships', 'revoked_by_user_id', 'SET NULL', false],
  // Motor adaptativo
  ['workout_adaptation_log', 'personal_id', 'SET NULL', true],
  // Convites
  ['personal_direct_invites', 'accepted_user_id', 'SET NULL', false],
  ['nutri_direct_invites', 'accepted_user_id', 'SET NULL', false],
  // Academia (mesma classe de defeito; deixar de fora manteria o bloqueio
  // para qualquer usuário que tenha passado por uma academia)
  ['academy_users', 'invited_by', 'SET NULL', false],
  ['academy_invitations', 'invited_by', 'SET NULL', true],
  ['academy_audit_log', 'user_id', 'SET NULL', false],
  ['patient_dietary_profile_items', 'created_by', 'SET NULL', true],
];

async function tableExists(pgm, table) {
  const r = await pgm.db.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
  return r.rows[0]?.oid != null;
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  for (const [table, column, action, dropNotNull] of FKS) {
    if (!(await tableExists(pgm, table))) continue;

    // O nome da constraint varia (criada por `ensure*` legado ou por migration):
    // resolvemos pelo catálogo em vez de chutar `<tabela>_<coluna>_fkey`.
    const found = await pgm.db.query(
      `SELECT k.conname
         FROM pg_constraint k
         JOIN unnest(k.conkey) u(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
        WHERE k.contype = 'f'
          AND k.conrelid = $1::regclass
          AND k.confrelid = 'users'::regclass
          AND a.attname = $2
          AND array_length(k.conkey, 1) = 1`,
      [table, column],
    );
    if (found.rows.length === 0) continue;

    if (dropNotNull) {
      await pgm.db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
    }
    for (const { conname } of found.rows) {
      await pgm.db.query(`ALTER TABLE ${table} DROP CONSTRAINT "${conname}"`);
      await pgm.db.query(
        `ALTER TABLE ${table}
           ADD CONSTRAINT "${conname}"
           FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE ${action}`,
      );
    }
  }
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Volta as FKs para NO ACTION. O NOT NULL NÃO é restaurado: linhas
  // anonimizadas por uma exclusão já executada teriam NULL e o ALTER falharia.
  for (const [table, column] of FKS) {
    if (!(await tableExists(pgm, table))) continue;
    const found = await pgm.db.query(
      `SELECT k.conname
         FROM pg_constraint k
         JOIN unnest(k.conkey) u(attnum) ON true
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
        WHERE k.contype = 'f'
          AND k.conrelid = $1::regclass
          AND k.confrelid = 'users'::regclass
          AND a.attname = $2
          AND array_length(k.conkey, 1) = 1`,
      [table, column],
    );
    for (const { conname } of found.rows) {
      await pgm.db.query(`ALTER TABLE ${table} DROP CONSTRAINT "${conname}"`);
      await pgm.db.query(
        `ALTER TABLE ${table}
           ADD CONSTRAINT "${conname}" FOREIGN KEY (${column}) REFERENCES users(id)`,
      );
    }
  }
};
