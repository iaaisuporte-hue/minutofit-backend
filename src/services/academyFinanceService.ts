import pool from '../config/database';

export interface AcademyPaymentRow {
  id: number;
  user_id: number;
  student_name: string | null;
  student_email: string;
  plan_name: string | null;
  /** Valor em reais (BRL), alinhado a `payments.amount_brl` */
  amount: number;
  currency: string;
  /** Normalizado para UI: `paid` inclui `approved` do Mercado Pago */
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

/** Normaliza status do ledger (MP) para filtros e KPIs da UI */
function normalizePaymentStatusForFilter(status: string | undefined): string | undefined {
  if (!status) return undefined;
  if (status === 'paid') return 'approved';
  return status;
}

/**
 * Lista pagamentos da academia filtrando por academy_id.
 * Parâmetros opcionais: from/to (ISO date) e status (UI: paid | pending | failed | refunded — `paid` inclui `approved`).
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

  if (from) {
    conditions.push(`p.created_at >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`p.created_at <= $${idx++}`);
    values.push(to);
  }
  const rawStatus = normalizePaymentStatusForFilter(status);
  if (rawStatus) {
    if (rawStatus === 'approved') {
      conditions.push(`(p.status = 'approved' OR p.status = 'paid')`);
    } else {
      conditions.push(`p.status = $${idx++}`);
      values.push(rawStatus);
    }
  }

  const where = conditions.join(' AND ');
  const limitPh = `$${idx++}`;
  const offsetPh = `$${idx++}`;
  values.push(limit, offset);

  const [rowsRes, countRes] = await Promise.all([
    pool.query<AcademyPaymentRow>(
      `SELECT
         p.id,
         p.user_id,
         u.name  AS student_name,
         u.email AS student_email,
         st.name AS plan_name,
         p.amount_brl::float8 AS amount,
         'BRL'::text          AS currency,
         CASE
           WHEN p.status IN ('approved', 'paid') THEN 'paid'
           ELSE p.status
         END AS status,
         CASE
           WHEN p.status IN ('approved', 'paid') THEN COALESCE(p.updated_at, p.created_at)
           ELSE NULL
         END AS paid_at,
         p.created_at
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_subscriptions us ON us.id = p.subscription_id
       LEFT JOIN subscription_tiers st ON st.id = us.tier_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      values
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM payments p WHERE ${where}`,
      values.slice(0, values.length - 2)
    ),
  ]);

  return {
    rows: rowsRes.rows,
    total: Number(countRes.rows[0]?.count ?? 0),
  };
}

/**
 * KPIs financeiros do mês corrente para a academia.
 * Usa `amount_brl` e trata `approved` como receita confirmada (equivalente a "paid" na UI).
 */
export async function getAcademyFinanceKPIs(academyId: number): Promise<AcademyFinanceKPIs> {
  const result = await pool.query<{
    total_paid: string;
    count_paid: string;
    total_pending: string;
    count_pending: string;
    total_failed: string;
    count_failed: string;
  }>(
    `SELECT
       COALESCE(SUM(p.amount_brl) FILTER (WHERE p.status IN ('approved', 'paid')), 0)::text AS total_paid,
       COUNT(*) FILTER (WHERE p.status IN ('approved', 'paid'))::text AS count_paid,
       COALESCE(SUM(p.amount_brl) FILTER (WHERE p.status = 'pending'), 0)::text AS total_pending,
       COUNT(*) FILTER (WHERE p.status = 'pending')::text AS count_pending,
       COALESCE(SUM(p.amount_brl) FILTER (WHERE p.status IN ('failed', 'refunded')), 0)::text AS total_failed,
       COUNT(*) FILTER (WHERE p.status IN ('failed', 'refunded'))::text AS count_failed
     FROM payments p
     WHERE p.academy_id = $1
       AND p.created_at >= DATE_TRUNC('month', NOW())`,
    [academyId]
  );

  const row = result.rows[0];
  return {
    totalPaid:    parseFloat(row?.total_paid    ?? '0'),
    countPaid:    Number(row?.count_paid    ?? 0),
    totalPending: parseFloat(row?.total_pending ?? '0'),
    countPending: Number(row?.count_pending ?? 0),
    totalFailed:  parseFloat(row?.total_failed  ?? '0'),
    countFailed:  Number(row?.count_failed  ?? 0),
  };
}
