/**
 * Remove a CHECK constraint órfã `user_products_source_check`.
 *
 * Bug latente (crítico): ao renomear `user_products` → `user_product_memberships`
 * (migration 1747250000000), a CHECK constraint original `user_products_source_check`
 * permaneceu anexada à tabela com o nome antigo, restringindo `source` a apenas
 * ('metacore', 'academy_bootstrap', 'direct_purchase'). A constraint canônica
 * `user_product_memberships_source_check` (que aceita 'corefit', 'bonus_*', etc.)
 * coexistia, então um INSERT precisava passar nas DUAS — e qualquer grant com
 * source='corefit' (default de grantMembership para vínculo AUTÔNOMO, sem academia)
 * era rejeitado silenciosamente.
 *
 * Efeito no produto: aluno de personal/nutri autônomo recebia o assignment mas NUNCA
 * o produto → aparecia "Ativo" em Minha Equipe e levava 403 ('produto não habilitado')
 * ao abrir a ficha. Também quebrava o grant manual de produto pelo Admin.
 *
 * A constraint canônica permanece e cobre todos os sources válidos. Em instalação
 * nova a tabela já nasce com o CHECK inline correto (ensureProductsSchema), então
 * esta órfã só existe em ambientes migrados a partir de `user_products`.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(
    `ALTER TABLE user_product_memberships DROP CONSTRAINT IF EXISTS user_products_source_check`
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async () => {
  // Intencionalmente irreversível: a constraint órfã era um bug. A constraint
  // canônica user_product_memberships_source_check continua protegendo a coluna.
};
