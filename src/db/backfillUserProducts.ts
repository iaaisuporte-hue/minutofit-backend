import pool from '../config/database';
import logger from '../lib/logger';

/**
 * Backfill de user_product_memberships para usuários existentes.
 *
 * Estratégia conservadora e idempotente:
 *  - Usuário com role='user' ou role='personal' ou role='nutri' → concede produto 'app'
 *  - Usuário com role='personal' → concede também 'personal'
 *  - Usuário com role='nutri' → concede também 'nutri'
 *  - Usuário vinculado a `academy_users` ativo → concede 'academia' (equipe ou aluno)
 *  - Todos os usuários existentes → concede 'metabolismo' (engine metabólica é feature universal)
 *
 * ON CONFLICT (user_id, product_key) DO NOTHING — idempotente.
 * Roda uma vez no boot após ensureProductsSchema.
 *
 * A migration 1747250000000 executa o backfill de academia/personal mais completo;
 * este backfill cobre o caso de usuários criados antes da migration.
 */
export async function backfillUserProducts(): Promise<void> {
  const tableExists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_product_memberships'
    LIMIT 1
  `);
  if (tableExists.rows.length === 0) {
    logger.info('[db] backfillUserProducts: user_product_memberships table not found, skipping');
    return;
  }

  // Produto 'app' para todos os usuários não-admin
  await pool.query(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, notes)
    SELECT u.id, 'app', 'active', 'metacore', 'Backfill inicial — produto app para todos os usuários'
    FROM users u
    WHERE u.role IN ('user', 'personal', 'nutri')
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'personal' para personal trainers
  await pool.query(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, notes)
    SELECT u.id, 'personal', 'active', 'metacore', 'Backfill inicial — produto personal para personal trainers'
    FROM users u
    WHERE u.role = 'personal'
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'nutri' para nutricionistas
  await pool.query(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, notes)
    SELECT u.id, 'nutri', 'active', 'metacore', 'Backfill inicial — produto nutri para nutricionistas'
    FROM users u
    WHERE u.role = 'nutri'
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'metabolismo' para todos os usuários (engine é universal na base atual)
  await pool.query(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, notes)
    SELECT u.id, 'metabolismo', 'active', 'metacore', 'Backfill inicial — metabolismo universal'
    FROM users u
    WHERE u.role IN ('user', 'personal', 'nutri')
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'academia' para qualquer vínculo ativo em academy_users (equipe + aluno)
  await pool.query(`
    INSERT INTO user_product_memberships (user_id, product_key, status, source, source_academy_id, academy_id, notes)
    SELECT DISTINCT ON (au.user_id)
      au.user_id,
      'academia',
      'active',
      'academy_bootstrap',
      au.academy_id,
      au.academy_id,
      'Backfill — academy_users ativo'
    FROM academy_users au
    WHERE au.is_active = TRUE AND au.status = 'active'
    ORDER BY au.user_id, au.academy_id
    ON CONFLICT (user_id, product_key) DO NOTHING
  `).catch(() => {
    // academy_users may not exist yet on very first deploy
  });

  logger.info('[db] backfillUserProducts: backfill concluído');
}
