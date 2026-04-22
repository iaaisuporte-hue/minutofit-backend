import pool from '../config/database';
import { normalizeToCanonicalPlanName } from '../utils/planNormalization';

export interface PlanRecord {
  id: number;
  name: string;
  description: string | null;
}

export interface FeatureRecord {
  id: number;
  key: string;
  name: string;
  description: string | null;
}

export async function listPlans(): Promise<PlanRecord[]> {
  const result = await pool.query(`SELECT id, name, description FROM plans ORDER BY id`);
  return result.rows;
}

export async function listFeatures(): Promise<FeatureRecord[]> {
  const result = await pool.query(`SELECT id, key, name, description FROM features ORDER BY key`);
  return result.rows;
}

export async function getPlanFeatures(planId: number) {
  const planResult = await pool.query(`SELECT id, name, description FROM plans WHERE id = $1 LIMIT 1`, [planId]);
  if (planResult.rows.length === 0) {
    throw new Error('PLAN_NOT_FOUND');
  }

  const featureResult = await pool.query(
    `SELECT f.id, f.key, f.name, f.description, COALESCE(pf.enabled, FALSE) AS enabled
     FROM features f
     LEFT JOIN plan_features pf ON pf.feature_id = f.id AND pf.plan_id = $1
     ORDER BY f.key`,
    [planId]
  );

  return {
    plan: planResult.rows[0],
    features: featureResult.rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      enabled: row.enabled === true,
    })),
  };
}

export async function updatePlanFeatures(
  planId: number,
  updates: Array<{ key: string; enabled: boolean }>
) {
  const planResult = await pool.query(`SELECT id FROM plans WHERE id = $1 LIMIT 1`, [planId]);
  if (planResult.rows.length === 0) {
    throw new Error('PLAN_NOT_FOUND');
  }
  if (updates.length === 0) {
    return { planId, updated: 0 };
  }

  const keys = updates.map((item) => item.key);
  const featuresResult = await pool.query(
    `SELECT id, key FROM features WHERE key = ANY($1::text[])`,
    [keys]
  );
  const featureIdByKey = new Map<string, number>(featuresResult.rows.map((row) => [row.key, row.id]));

  const missing = keys.filter((key) => !featureIdByKey.has(key));
  if (missing.length > 0) {
    throw new Error(`FEATURES_NOT_FOUND:${missing.join(',')}`);
  }

  let updated = 0;
  for (const item of updates) {
    const featureId = featureIdByKey.get(item.key)!;
    await pool.query(
      `INSERT INTO plan_features (plan_id, feature_id, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (plan_id, feature_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`,
      [planId, featureId, item.enabled]
    );
    updated += 1;
  }

  return { planId, updated };
}

export async function resolveCurrentPlanForUser(userId: number): Promise<PlanRecord | null> {
  const result = await pool.query(
    `SELECT p.id, p.name, p.description
     FROM user_subscriptions us
     JOIN subscription_tiers st ON st.id = us.tier_id
     JOIN plans p ON p.name = st.name
     WHERE us.user_id = $1 AND us.status = 'active'
     ORDER BY us.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const canonicalName = normalizeToCanonicalPlanName(row.name);
  const canonical = await pool.query(
    `SELECT id, name, description
     FROM plans
     WHERE LOWER(name) = LOWER($1)
     LIMIT 1`,
    [canonicalName]
  );
  return canonical.rows[0] || row;
}

export async function getFeatureMapByPlanId(planId: number): Promise<Record<string, boolean>> {
  const result = await pool.query(
    `SELECT f.key, COALESCE(pf.enabled, FALSE) AS enabled
     FROM features f
     LEFT JOIN plan_features pf ON pf.feature_id = f.id AND pf.plan_id = $1`,
    [planId]
  );
  const map: Record<string, boolean> = {};
  for (const row of result.rows) {
    map[row.key] = row.enabled === true;
  }
  return map;
}

/**
 * Mapa de features do usuário conforme o **plano ativo** na assinatura.
 * Se não houver assinatura resolvida, cai no plano Free.
 * (Antes: usava sempre Free e, para `clientes_sb`, cortava ainda mais recursos.)
 */
export async function getFeatureMapForUser(userId: number) {
  const resolved = await resolveCurrentPlanForUser(userId);
  const plan =
    resolved ??
    (await pool
      .query(`SELECT id, name, description FROM plans WHERE LOWER(name) = 'free' LIMIT 1`)
      .then((r) => (r.rows[0] ? (r.rows[0] as PlanRecord) : null)));

  if (!plan) {
    return { plan: null, features: {} as Record<string, boolean> };
  }

  const features = await getFeatureMapByPlanId(plan.id);
  return { plan, features };
}

