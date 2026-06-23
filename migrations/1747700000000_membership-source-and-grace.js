/**
 * Extende a coluna `source` de `user_product_memberships` e adiciona o suporte
 * a "período de graça" para o App quando concedido como bônus de outro produto.
 *
 * O App pode ser concedido como bônus de Academia/Personal/Nutri. Quando o
 * produto pai é cancelado, o App entra em `grace_period` (30 dias) e o usuário
 * mantém acesso, com sinal para conversão em standalone.
 *
 * Mudanças:
 *  1. Estende CHECK de `source` com novos valores:
 *      - `bonus_academy`   (App concedido junto com Academia)
 *      - `bonus_personal`  (App concedido junto com Personal)
 *      - `bonus_nutri`     (App concedido junto com Nutri)
 *      - `discount_partner` (parceria comercial — reservado para Fase 2)
 *      - `trial`           (período de trial — reservado para Fase 2)
 *      - `grace_period`    (App pai cancelado; janela de conversão)
 *  2. Adiciona coluna `grace_until timestamptz` (NULL quando não em graça)
 *  3. Adiciona coluna `converted_from_source text` (preserva origem do bônus)
 *  4. Índice parcial para varredura eficiente de graças vencidas.
 *
 * Down: reverte para a constraint anterior e remove as colunas.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_product_memberships
      DROP CONSTRAINT IF EXISTS user_product_memberships_source_check
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      ADD CONSTRAINT user_product_memberships_source_check
      CHECK (source IN (
        'corefit',
        'academy_bootstrap',
        'direct_purchase',
        'bonus_academy',
        'bonus_personal',
        'bonus_nutri',
        'discount_partner',
        'trial',
        'grace_period'
      ))
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      ADD COLUMN IF NOT EXISTS converted_from_source TEXT
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_upm_grace_until
      ON user_product_memberships (grace_until)
      WHERE grace_until IS NOT NULL
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_upm_grace_until`);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      DROP COLUMN IF EXISTS converted_from_source
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      DROP COLUMN IF EXISTS grace_until
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      DROP CONSTRAINT IF EXISTS user_product_memberships_source_check
  `);

  pgm.sql(`
    ALTER TABLE user_product_memberships
      ADD CONSTRAINT user_product_memberships_source_check
      CHECK (source IN ('corefit', 'academy_bootstrap', 'direct_purchase'))
  `);
};
