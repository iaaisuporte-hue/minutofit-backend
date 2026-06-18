import pool from '../config/database';

export type PersonalPlan = 'free' | 'starter' | 'pro';
export type PersonalPlanStatus = 'active' | 'trial' | 'expired' | 'cancelled';

export interface PersonalPlanConfig {
  plan: PersonalPlan;
  status: PersonalPlanStatus;
  studentLimit: number | null;
  aiEnabled: boolean;
  currentPeriodEnd: Date | null;
}

const PLAN_DEFAULTS: Record<PersonalPlan, Pick<PersonalPlanConfig, 'studentLimit' | 'aiEnabled'>> = {
  free:    { studentLimit: 3,    aiEnabled: false },
  starter: { studentLimit: 15,   aiEnabled: false },
  pro:     { studentLimit: null, aiEnabled: true  },
};

const FREE_DEFAULT: PersonalPlanConfig = {
  plan: 'free',
  status: 'active',
  studentLimit: PLAN_DEFAULTS.free.studentLimit,
  aiEnabled: PLAN_DEFAULTS.free.aiEnabled,
  currentPeriodEnd: null,
};

export async function getPersonalPlan(personalId: number): Promise<PersonalPlanConfig> {
  const result = await pool.query(
    `SELECT plan, status, student_limit, ai_enabled, current_period_end
     FROM personal_platform_subscriptions
     WHERE personal_id = $1`,
    [personalId]
  );

  if (result.rows.length === 0) return FREE_DEFAULT;

  const row = result.rows[0];
  return {
    plan: row.plan as PersonalPlan,
    status: row.status as PersonalPlanStatus,
    studentLimit: row.student_limit ?? PLAN_DEFAULTS[row.plan as PersonalPlan].studentLimit,
    aiEnabled: row.ai_enabled,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
  };
}

export async function setPersonalPlan(
  personalId: number,
  plan: PersonalPlan,
  opts: { periodDays?: number; notes?: string; setBy: number }
): Promise<void> {
  const defaults = PLAN_DEFAULTS[plan];
  const currentPeriodEnd = opts.periodDays
    ? new Date(Date.now() + opts.periodDays * 24 * 60 * 60 * 1000)
    : null;

  await pool.query(
    `INSERT INTO personal_platform_subscriptions
       (personal_id, plan, status, student_limit, ai_enabled, current_period_end, notes, set_by_user_id)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
     ON CONFLICT (personal_id) DO UPDATE SET
       plan               = EXCLUDED.plan,
       status             = 'active',
       student_limit      = EXCLUDED.student_limit,
       ai_enabled         = EXCLUDED.ai_enabled,
       current_period_end = EXCLUDED.current_period_end,
       notes              = EXCLUDED.notes,
       set_by_user_id     = EXCLUDED.set_by_user_id,
       updated_at         = NOW()`,
    [personalId, plan, defaults.studentLimit, defaults.aiEnabled, currentPeriodEnd, opts.notes ?? null, opts.setBy]
  );
}

export async function countActiveStudents(personalId: number): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM personal_student_assignments
     WHERE personal_id = $1 AND status = 'active'`,
    [personalId]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

export async function checkStudentLimitGate(
  personalId: number
): Promise<{ over: boolean; limit: number | null; current: number }> {
  const [config, current] = await Promise.all([
    getPersonalPlan(personalId),
    countActiveStudents(personalId),
  ]);

  if (config.studentLimit === null) {
    return { over: false, limit: null, current };
  }

  return { over: current >= config.studentLimit, limit: config.studentLimit, current };
}
