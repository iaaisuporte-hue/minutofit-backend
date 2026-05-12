import pool from '../config/database';

export const PRODUCT_KEYS = ['app', 'personal', 'nutri', 'academia', 'metabolismo'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

const PRODUCT_CATALOG: Array<{ key: ProductKey; name: string; description: string }> = [
  { key: 'app', name: 'App MinutoFit', description: 'Acesso ao app do aluno: Today, Tracker GPS, Lab de Movimento, treinos diários, gamificação.' },
  { key: 'personal', name: 'Personal', description: 'Acompanhamento por personal trainer: plano atribuído, snapshot metabólico, chat.' },
  { key: 'nutri', name: 'Nutricionista', description: 'Acompanhamento por nutricionista: plano alimentar, chat.' },
  { key: 'academia', name: 'Academia', description: 'Vínculo com academia: área do aluno, frequência, comunicação com staff.' },
  { key: 'metabolismo', name: 'Metabolismo', description: 'Engine metabólica + insights agregados: tendência 7d/30d, Form Score histórico.' },
];

/**
 * Idempotente — cria as tabelas products e user_products, garante catálogo base.
 * Deve rodar após ensureTenantColumnsPhase2Lock.
 */
export async function ensureProductsSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      key         VARCHAR(40) UNIQUE NOT NULL,
      name        VARCHAR(80) NOT NULL,
      description TEXT,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_products (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_key         VARCHAR(40) NOT NULL REFERENCES products(key),
      status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended', 'cancelled')),
      source              VARCHAR(30) NOT NULL DEFAULT 'metacore'
                            CHECK (source IN ('metacore', 'academy_bootstrap', 'direct_purchase')),
      source_academy_id   INTEGER REFERENCES academies(id),
      granted_by_user_id  INTEGER REFERENCES users(id),
      granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ,
      revoked_by_user_id  INTEGER REFERENCES users(id),
      notes               TEXT,
      UNIQUE (user_id, product_key)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_products_user_id ON user_products(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_products_status ON user_products(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_products_source_academy ON user_products(source_academy_id)`);

  // Seed catálogo base — idempotente
  for (const product of PRODUCT_CATALOG) {
    await pool.query(
      `INSERT INTO products (key, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
      [product.key, product.name, product.description]
    );
  }

  console.log('[db] ensureProductsSchema: products + user_products tables ready, catalog seeded');
}

/**
 * Retorna os product_keys ativos para um usuário.
 * Defensivo: retorna [] se a tabela ainda não existir (primeiro deploy).
 */
export async function getUserProducts(userId: number): Promise<ProductKey[]> {
  try {
    const result = await pool.query<{ product_key: ProductKey }>(
      `SELECT product_key FROM user_products
       WHERE user_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId]
    );
    return result.rows.map((r) => r.product_key);
  } catch {
    return [];
  }
}

export interface UserProductMeta {
  product_key: ProductKey;
  status: string;
  source: string;
  granted_at: string;
  expires_at: string | null;
}

/**
 * Retorna produtos do usuário com metadados para o /auth/me endpoint.
 * Inclui somente os registros ativos e não expirados.
 */
export async function getUserProductsWithMeta(userId: number): Promise<UserProductMeta[]> {
  try {
    const result = await pool.query<UserProductMeta>(
      `SELECT product_key, status, source, granted_at, expires_at
       FROM user_products
       WHERE user_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY granted_at ASC`,
      [userId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

/** Concede um produto a um usuário (upsert). */
export async function grantUserProduct(input: {
  userId: number;
  productKey: ProductKey;
  source: 'metacore' | 'academy_bootstrap' | 'direct_purchase';
  sourceAcademyId?: number | null;
  grantedByUserId?: number | null;
  expiresAt?: Date | null;
  notes?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_products
       (user_id, product_key, status, source, source_academy_id, granted_by_user_id, expires_at, notes)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, product_key)
     DO UPDATE SET
       status = 'active',
       source = EXCLUDED.source,
       source_academy_id = COALESCE(EXCLUDED.source_academy_id, user_products.source_academy_id),
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       granted_at = NOW(),
       expires_at = EXCLUDED.expires_at,
       revoked_at = NULL,
       revoked_by_user_id = NULL,
       notes = EXCLUDED.notes`,
    [
      input.userId,
      input.productKey,
      input.source,
      input.sourceAcademyId ?? null,
      input.grantedByUserId ?? null,
      input.expiresAt ?? null,
      input.notes ?? null,
    ]
  );
}

/** Revoga um produto de um usuário. */
export async function revokeUserProduct(input: {
  userId: number;
  productKey: ProductKey;
  revokedByUserId: number;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_products
     SET status = 'cancelled', revoked_at = NOW(), revoked_by_user_id = $3
     WHERE user_id = $1 AND product_key = $2 AND status = 'active'`,
    [input.userId, input.productKey, input.revokedByUserId]
  );
  return (result.rowCount ?? 0) > 0;
}
