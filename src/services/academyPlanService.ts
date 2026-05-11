import pool from '../config/database';
import { auditLog } from '../utils/auditLog';

export interface AcademyPlan {
  id: number;
  academyId: number;
  name: string;
  description: string | null;
  monthlyPrice: number;
  billingCycleDays: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

function mapPlan(row: any): AcademyPlan {
  return {
    id: row.id,
    academyId: row.academy_id,
    name: row.name,
    description: row.description ?? null,
    monthlyPrice: Number(row.monthly_price),
    billingCycleDays: row.billing_cycle_days,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listPlans(academyId: number, includeArchived = false): Promise<AcademyPlan[]> {
  const res = await pool.query(
    `SELECT * FROM academy_plans
     WHERE academy_id = $1 ${includeArchived ? '' : "AND status = 'active'"}
     ORDER BY name`,
    [academyId]
  );
  return res.rows.map(mapPlan);
}

export async function getPlan(academyId: number, planId: number): Promise<AcademyPlan> {
  const res = await pool.query(
    `SELECT * FROM academy_plans WHERE id = $1 AND academy_id = $2`,
    [planId, academyId]
  );
  if (res.rows.length === 0) throw new Error('Plano não encontrado.');
  return mapPlan(res.rows[0]);
}

export async function createPlan(
  academyId: number,
  actorUserId: number,
  params: { name: string; description?: string; monthlyPrice: number; billingCycleDays?: number }
): Promise<AcademyPlan> {
  const res = await pool.query(
    `INSERT INTO academy_plans (academy_id, name, description, monthly_price, billing_cycle_days)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      academyId,
      String(params.name).trim(),
      params.description ?? null,
      params.monthlyPrice,
      params.billingCycleDays ?? 30,
    ]
  );
  const plan = mapPlan(res.rows[0]);
  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'plan.created',
    entityType: 'plan',
    entityId: plan.id,
    meta: { name: plan.name, monthlyPrice: plan.monthlyPrice },
  });
  return plan;
}

export async function updatePlan(
  academyId: number,
  actorUserId: number,
  planId: number,
  params: { name?: string; description?: string; monthlyPrice?: number; billingCycleDays?: number }
): Promise<AcademyPlan> {
  const existing = await getPlan(academyId, planId);
  if (!existing) throw new Error('Plano não encontrado.');

  const updates: string[] = [];
  const vals: unknown[] = [];

  if (params.name !== undefined) { updates.push(`name = $${vals.length + 1}`); vals.push(String(params.name).trim()); }
  if (params.description !== undefined) { updates.push(`description = $${vals.length + 1}`); vals.push(params.description); }
  if (params.monthlyPrice !== undefined) { updates.push(`monthly_price = $${vals.length + 1}`); vals.push(params.monthlyPrice); }
  if (params.billingCycleDays !== undefined) { updates.push(`billing_cycle_days = $${vals.length + 1}`); vals.push(params.billingCycleDays); }

  if (updates.length === 0) return existing;
  updates.push('updated_at = NOW()');
  vals.push(planId, academyId);

  const res = await pool.query(
    `UPDATE academy_plans SET ${updates.join(', ')}
     WHERE id = $${vals.length - 1} AND academy_id = $${vals.length}
     RETURNING *`,
    vals
  );

  const plan = mapPlan(res.rows[0]);
  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'plan.updated',
    entityType: 'plan',
    entityId: plan.id,
    meta: params as Record<string, unknown>,
  });
  return plan;
}

export async function archivePlan(
  academyId: number,
  actorUserId: number,
  planId: number
): Promise<void> {
  const res = await pool.query(
    `UPDATE academy_plans SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND academy_id = $2
     RETURNING id`,
    [planId, academyId]
  );
  if (res.rows.length === 0) throw new Error('Plano não encontrado.');
  await auditLog(pool, {
    academyId,
    userId: actorUserId,
    action: 'plan.archived',
    entityType: 'plan',
    entityId: planId,
  });
}
