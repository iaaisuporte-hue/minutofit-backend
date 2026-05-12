import pool from '../config/database';

export interface AcademyPaymentRow {
  id: number;
  user_id: number;
  student_name: string | null;
  student_email: string;
  plan_name: string | null;
  amount: number;
  currency: string;
  status: string;
  paid_at: string | null;
  created_at: string;
}

export interface AcademyFinanceKPIs {
  totalPaid: number;
  totalPending: number;
  totalFailed: number;
  countPaid: number;
  countPending: number;
  countFailed: number;
}

/**
 * Lista pagamentos da academia filtrando por academy_id.
 * Parâmetros opcionais: from/to (ISO date) e status.
 */
export async function listAcademyPayments(params: {
  academyId: number;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: AcademyPaymentRow[]; total: number }> {
  const { academyId, from, to, status, limit = 50, offset = 0 } = params;

  const conditions: string[] = ['p.academy_id = $1'];
  const values: unknown[] = [academyId];
  let idx = 2;

  if (from) { conditions.push(`p.created_at >= $${idx++}`); values.push(from); }
  if (to)   { conditions.push(`p.created_at <= $${idx++}`); values.push(to); }
  if (status) { conditions.push(`p.status = $${idx++}`); values.push(status); }

  const where = conditions.join(' AND ');

  const [rowsRes, countRes] = await Promise.all([
    pool.query<AcademyPaymentRow>(
      `SELECT
         p.id,
         p.user_id,
         u.name  AS student_name,
         u.email AS student_email,
         st.name AS plan_name,
         p.amount,
         p.currency,
         p.status,
         p.paid_at,
         p.created_at
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_subscriptions us ON us.id = p.subscription_id
       LEFT JOIN subscription_tiers st ON st.id = us.tier_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments p WHERE ${where}`,
      values
    ),
  ]);

  return {
    rows: rowsRes.rows,
    total: Number(countRes.rows[0]?.count ?? 0),
  };
}

/**
 * KPIs financeiros do mês corrente para a academia.
 */
export async function getAcademyFinanceKPIs(academyId: number): Promise<AcademyFinanceKPIs> {
  const result = await pool.query<{
    status: string;
    total_amount: string;
    count: string;
  }>(
    `SELECT
       status,
       COALESCE(SUM(amount), 0) AS total_amount,
       COUNT(*)                 AS count
     FROM payments
     WHERE academy_id = $1
       AND created_at >= DATE_TRUNC('month', NOW())
     GROUP BY status`,
    [academyId]
  );

  const kpis: AcademyFinanceKPIs = {
    totalPaid: 0, countPaid: 0,
    totalPending: 0, countPending: 0,
    totalFailed: 0, countFailed: 0,
  };

  for (const row of result.rows) {
    const amt = parseFloat(row.total_amount);
    const cnt = Number(row.count);
    if (row.status === 'paid')    { kpis.totalPaid    = amt; kpis.countPaid    = cnt; }
    if (row.status === 'pending') { kpis.totalPending = amt; kpis.countPending = cnt; }
    if (row.status === 'failed')  { kpis.totalFailed  = amt; kpis.countFailed  = cnt; }
  }

  return kpis;
}
