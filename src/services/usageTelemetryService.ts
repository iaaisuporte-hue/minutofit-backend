/**
 * Spec 028 — Telemetria de Uso.
 *
 * Registra que um usuário usou o app, com granularidade diária. É o substrato
 * de DAU/MAU, retenção e funil de ativação.
 *
 * REGRA: telemetria NUNCA derruba a requisição do usuário. Toda falha é
 * logada e engolida — medir é importante, mas não ao ponto de quebrar login.
 */
import pool from '../config/database';
import logger from '../lib/logger';

/**
 * Marca atividade do usuário no dia corrente.
 *
 * @param userId  id do usuário
 * @param isLogin true quando a chamada vem de uma emissão de token por
 *                credencial/OAuth (não de refresh) — só então `last_login_at`
 *                avança. Refresh renova sessão, não é um login novo.
 */
export async function touchUserActivity(userId: number, isLogin = false): Promise<void> {
  try {
    // Idempotente por (user_id, day): duas requisições no mesmo dia = uma linha.
    await pool.query(
      `INSERT INTO user_activity_days (user_id, day)
       VALUES ($1, CURRENT_DATE)
       ON CONFLICT (user_id, day) DO NOTHING`,
      [userId]
    );

    await pool.query(
      isLogin
        ? `UPDATE users SET last_seen_at = NOW(), last_login_at = NOW() WHERE id = $1`
        : `UPDATE users SET last_seen_at = NOW() WHERE id = $1`,
      [userId]
    );
  } catch (error) {
    logger.error({ err: error, userId, isLogin }, '[telemetry] falha ao registrar atividade');
  }
}

export interface UsageAggregates {
  dau: number;
  wau: number;
  mau: number;
  /** Razão DAU/MAU — proxy clássico de "stickiness". null quando MAU = 0. */
  dauMauRatio: number | null;
}

export async function getUsageAggregates(): Promise<UsageAggregates> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(DISTINCT user_id) FILTER (WHERE day = CURRENT_DATE)               AS dau,
       COUNT(DISTINCT user_id) FILTER (WHERE day >= CURRENT_DATE - 6)          AS wau,
       COUNT(DISTINCT user_id) FILTER (WHERE day >= CURRENT_DATE - 29)         AS mau
     FROM user_activity_days
     WHERE day >= CURRENT_DATE - 29`
  );

  const dau = Number(rows[0]?.dau ?? 0);
  const wau = Number(rows[0]?.wau ?? 0);
  const mau = Number(rows[0]?.mau ?? 0);

  return {
    dau,
    wau,
    mau,
    dauMauRatio: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : null,
  };
}

export interface RetentionD30 {
  /** Usuários com ≥30d de conta que tiveram atividade nos últimos 30d. */
  personalD30: number | null;
  studentD30: number | null;
}

export async function getRetentionD30(): Promise<RetentionD30> {
  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT u.id, u.role,
              EXISTS (
                SELECT 1 FROM user_activity_days uad
                WHERE uad.user_id = u.id AND uad.day >= CURRENT_DATE - 29
              ) AS active_30d
       FROM users u
       WHERE u.created_at <= NOW() - INTERVAL '30 days'
     )
     SELECT
       COUNT(*) FILTER (WHERE role = 'personal')                     AS personal_n,
       COUNT(*) FILTER (WHERE role = 'personal' AND active_30d)      AS personal_active,
       COUNT(*) FILTER (WHERE role = 'user')                         AS student_n,
       COUNT(*) FILTER (WHERE role = 'user'     AND active_30d)      AS student_active
     FROM cohort`
  );

  const r = rows[0] ?? {};
  const pct = (active: unknown, total: unknown): number | null => {
    const t = Number(total ?? 0);
    if (t === 0) return null;
    return Math.round((Number(active ?? 0) / t) * 1000) / 10;
  };

  return {
    personalD30: pct(r.personal_active, r.personal_n),
    studentD30: pct(r.student_active, r.student_n),
  };
}

export interface FunnelStep {
  step: string;
  label: string;
  count: number;
}

/**
 * Funil de ativação do personal — o KPI que o parecer do wedge aponta como
 * ausente (`docs/parecer_personal_wedge_2026-06.md:216-218`).
 *
 * Os quatro primeiros degraus são encaixados (quem publicou ficha tem aluno),
 * mas `active_7d` é um corte ORTOGONAL — mede uso recente, não progressão. Pode
 * ser maior que `first_session` (personal que abre o app sem registrar sessão)
 * ou menor (quem ativou e sumiu). Ler como indicador ao lado do funil, não como
 * o último degrau dele.
 */
export async function getPersonalActivationFunnel(): Promise<FunnelStep[]> {
  const { rows } = await pool.query(
    `WITH personals AS (
       SELECT id FROM users WHERE role = 'personal'
     ),
     with_student AS (
       SELECT DISTINCT personal_id AS id FROM personal_student_assignments
     ),
     with_plan AS (
       SELECT DISTINCT personal_id AS id FROM personal_workout_plans
     ),
     with_session AS (
       SELECT DISTINCT personal_id AS id FROM personal_session_logs
     ),
     active_7d AS (
       SELECT DISTINCT uad.user_id AS id
       FROM user_activity_days uad
       WHERE uad.day >= CURRENT_DATE - 6
     )
     SELECT
       (SELECT COUNT(*) FROM personals)                                            AS signup,
       (SELECT COUNT(*) FROM personals p WHERE p.id IN (SELECT id FROM with_student))  AS first_student,
       (SELECT COUNT(*) FROM personals p WHERE p.id IN (SELECT id FROM with_plan))     AS first_plan,
       (SELECT COUNT(*) FROM personals p WHERE p.id IN (SELECT id FROM with_session))  AS first_session,
       (SELECT COUNT(*) FROM personals p WHERE p.id IN (SELECT id FROM active_7d))     AS active_7d`
  );

  const r = rows[0] ?? {};
  return [
    { step: 'signup',        label: 'Cadastro',            count: Number(r.signup ?? 0) },
    { step: 'first_student', label: 'Primeiro aluno',      count: Number(r.first_student ?? 0) },
    { step: 'first_plan',    label: 'Primeira ficha',      count: Number(r.first_plan ?? 0) },
    { step: 'first_session', label: 'Primeira sessão',     count: Number(r.first_session ?? 0) },
    { step: 'active_7d',     label: 'Ativo nos últimos 7d', count: Number(r.active_7d ?? 0) },
  ];
}
