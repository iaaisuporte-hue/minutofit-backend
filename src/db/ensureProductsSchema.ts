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
 * Idempotente — cria as tabelas products e user_product_memberships (antigo user_products),
 * garante catálogo base. Deve rodar após runMigrations (que executa o rename real).
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

  // Migration 1747250000000 renames user_products → user_product_memberships with full schema.
  // This CREATE TABLE IF NOT EXISTS is a safe no-op on existing deployments (table already renamed)
  // and creates the correct table on a fresh install before migrations run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_product_memberships (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_key         VARCHAR(40) NOT NULL REFERENCES products(key),
      status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'paused', 'suspended', 'cancelled', 'expired')),
      source              VARCHAR(30) NOT NULL DEFAULT 'metacore'
                            CHECK (source IN ('metacore', 'academy_bootstrap', 'direct_purchase')),
      source_academy_id   INTEGER REFERENCES academies(id),
      granted_by_user_id  INTEGER REFERENCES users(id),
      granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ,
      revoked_by_user_id  INTEGER REFERENCES users(id),
      notes               TEXT,
      academy_id          INTEGER REFERENCES academies(id),
      professional_id     INTEGER REFERENCES users(id),
      plan_id             INTEGER,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at            TIMESTAMPTZ,
      metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (user_id, product_key)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_upm_user_id       ON user_product_memberships(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_upm_status        ON user_product_memberships(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_upm_source_academy ON user_product_memberships(source_academy_id)`);

  // Seed catálogo base — idempotente
  for (const product of PRODUCT_CATALOG) {
    await pool.query(
      `INSERT INTO products (key, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
      [product.key, product.name, product.description]
    );
  }

  console.log('[db] ensureProductsSchema: products + user_product_memberships tables ready, catalog seeded');
}

/**
 * Retorna os product_keys ativos para um usuário.
 * Defensivo: retorna [] se a tabela ainda não existir (primeiro deploy).
 */
export async function getUserProducts(userId: number): Promise<ProductKey[]> {
  try {
    const result = await pool.query<{ product_key: ProductKey }>(
      `SELECT product_key FROM user_product_memberships
       WHERE user_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (ended_at IS NULL OR ended_at > NOW())`,
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
  academy_id: number | null;
  professional_id: number | null;
}

/**
 * Retorna produtos do usuário com metadados para o /auth/me endpoint.
 * Inclui somente os registros ativos e não expirados.
 */
export async function getUserProductsWithMeta(userId: number): Promise<UserProductMeta[]> {
  try {
    const result = await pool.query<UserProductMeta>(
      `SELECT product_key, status, source, granted_at, expires_at, academy_id, professional_id
       FROM user_product_memberships
       WHERE user_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (ended_at IS NULL OR ended_at > NOW())
       ORDER BY granted_at ASC`,
      [userId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

/** Concede um produto a um usuário (upsert idempotente). */
export async function grantUserProduct(input: {
  userId: number;
  productKey: ProductKey;
  source: 'metacore' | 'academy_bootstrap' | 'direct_purchase';
  sourceAcademyId?: number | null;
  academyId?: number | null;
  professionalId?: number | null;
  planId?: number | null;
  grantedByUserId?: number | null;
  expiresAt?: Date | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_product_memberships
       (user_id, product_key, status, source, source_academy_id, academy_id, professional_id, plan_id,
        granted_by_user_id, expires_at, notes, metadata, started_at)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
     ON CONFLICT (user_id, product_key)
     DO UPDATE SET
       status             = 'active',
       source             = EXCLUDED.source,
       source_academy_id  = COALESCE(EXCLUDED.source_academy_id, user_product_memberships.source_academy_id),
       academy_id         = COALESCE(EXCLUDED.academy_id, user_product_memberships.academy_id),
       professional_id    = COALESCE(EXCLUDED.professional_id, user_product_memberships.professional_id),
       plan_id            = COALESCE(EXCLUDED.plan_id, user_product_memberships.plan_id),
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       granted_at         = NOW(),
       expires_at         = EXCLUDED.expires_at,
       ended_at           = NULL,
       revoked_at         = NULL,
       revoked_by_user_id = NULL,
       notes              = EXCLUDED.notes,
       metadata           = user_product_memberships.metadata || EXCLUDED.metadata`,
    [
      input.userId,
      input.productKey,
      input.source,
      input.sourceAcademyId ?? null,
      input.academyId ?? null,
      input.professionalId ?? null,
      input.planId ?? null,
      input.grantedByUserId ?? null,
      input.expiresAt ?? null,
      input.notes ?? null,
      JSON.stringify(input.metadata ?? {}),
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
    `UPDATE user_product_memberships
     SET status = 'cancelled', revoked_at = NOW(), revoked_by_user_id = $3, ended_at = NOW()
     WHERE user_id = $1 AND product_key = $2 AND status = 'active'`,
    [input.userId, input.productKey, input.revokedByUserId]
  );
  return (result.rowCount ?? 0) > 0;
}
