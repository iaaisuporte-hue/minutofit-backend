/**
 * academy_audit_log.academy_id → nullable.
 *
 * Bug latente: a coluna era NOT NULL, mas as ações de admin GLOBAL (CoreFit, fora de
 * qualquer academia) chamam logAcademyAction com academyId: null — o INSERT violava o
 * NOT NULL e era descartado silenciosamente pelo catch não-propagante do serviço.
 * Resultado: admin.password_set, product.grant/revoke, personal.plan.set e
 * membership.expire_graces NÃO estavam sendo auditados.
 *
 * Tornar nullable faz essas ações (e as novas: auth.password_changed/_reset,
 * admin.user_deleted) persistirem. A FK continua válida (NULL não referencia nada).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE academy_audit_log ALTER COLUMN academy_id DROP NOT NULL`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Reaplica NOT NULL apenas se não houver linhas com academy_id NULL (senão falharia).
  await pgm.db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM academy_audit_log WHERE academy_id IS NULL) THEN
        ALTER TABLE academy_audit_log ALTER COLUMN academy_id SET NOT NULL;
      END IF;
    END $$;
  `);
};
