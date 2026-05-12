import pool from '../config/database';

/**
 * Backfill de user_products para usuários existentes.
 *
 * Estratégia conservadora e idempotente:
 *  - Usuário com role='user' ou role='personal' ou role='nutri' → concede produto 'app'
 *  - Usuário com role='personal' → concede também 'personal'
 *  - Usuário com role='nutri' → concede também 'nutri'
 *  - Usuário vinculado a academia_users como 'academy_student' com enrollment ativo → concede 'academia'
 *  - Todos os usuários existentes → concede 'metabolismo' (engine metabólica é feature universal nesta base)
 *
 * ON CONFLICT (user_id, product_key) DO NOTHING — idempotente.
 * Roda uma vez no boot após ensureProductsSchema.
 */
export async function backfillUserProducts(): Promise<void> {
  const tableExists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_products'
    LIMIT 1
  `);
  if (tableExists.rows.length === 0) {
    console.log('[db] backfillUserProducts: user_products table not found, skipping');
    return;
  }

  const alreadyHasRecords = await pool.query(`SELECT 1 FROM user_products LIMIT 1`);
  if (alreadyHasRecords.rows.length > 0) {
    // Table already has records; run targeted inserts to cover any gaps
  }

  // Produto 'app' para todos os usuários não-admin
  await pool.query(`
    INSERT INTO user_products (user_id, product_key, status, source, notes)
    SELECT u.id, 'app', 'active', 'metacore', 'Backfill inicial — produto app para todos os usuários'
    FROM users u
    WHERE u.role IN ('user', 'personal', 'nutri')
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'personal' para personal trainers
  await pool.query(`
    INSERT INTO user_products (user_id, product_key, status, source, notes)
    SELECT u.id, 'personal', 'active', 'metacore', 'Backfill inicial — produto personal para personal trainers'
    FROM users u
    WHERE u.role = 'personal'
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'nutri' para nutricionistas
  await pool.query(`
    INSERT INTO user_products (user_id, product_key, status, source, notes)
    SELECT u.id, 'nutri', 'active', 'metacore', 'Backfill inicial — produto nutri para nutricionistas'
    FROM users u
    WHERE u.role = 'nutri'
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  // Produto 'academia' para alunos com matrícula ativa
  await pool.query(`
    INSERT INTO user_products (user_id, product_key, status, source, source_academy_id, notes)
    SELECT DISTINCT ae.user_id, 'academia', 'active', 'academy_bootstrap', ae.academy_id,
           'Backfill inicial — produto academia para alunos matriculados'
    FROM academy_enrollments ae
    WHERE ae.status = 'active'
    ON CONFLICT (user_id, product_key) DO NOTHING
  `).catch(() => {
    // academy_enrollments may not exist yet
  });

  // Produto 'metabolismo' para todos os usuários (engine é universal na base atual)
  await pool.query(`
    INSERT INTO user_products (user_id, product_key, status, source, notes)
    SELECT u.id, 'metabolismo', 'active', 'metacore', 'Backfill inicial — metabolismo universal'
    FROM users u
    WHERE u.role IN ('user', 'personal', 'nutri')
    ON CONFLICT (user_id, product_key) DO NOTHING
  `);

  console.log('[db] backfillUserProducts: backfill concluído');
}
