import pool from '../config/database';

type DashboardRisk = 'ok' | 'alerta' | 'critico';
type DashboardPlan = 'basic' | 'silver' | 'gold' | 'black';
type DashboardGoal = 'emagrecimento' | 'hipertrofia' | 'condicionamento';

type DashboardStudent = {
  id: string;
  name: string;
  plan: DashboardPlan;
  workouts7d: number;
  workouts30d: number;
  streakDays: number;
  lastWorkoutISO: string | null;
  adherencePct: number;
  risk: DashboardRisk;
  goal: DashboardGoal;
  notes: string | null;
};

type ConsultingStatus = 'urgent' | 'warning' | 'on_track';
type ConsultingNextAction = 'refresh_today' | 'prepare_update' | 'review_adherence' | 'keep_progression';

type ConsultingStudent = {
  id: string;
  name: string;
  plan: DashboardPlan;
  planExpiresAt: string;
  lastWorkoutUpdateAt: string | null;
  workoutsDoneInCurrentPlan: number;
  workoutsPlannedInCurrentPlan: number;
  status: ConsultingStatus;
  nextAction: ConsultingNextAction;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mapPlan(subscriptionTier?: string | null): DashboardPlan {
  if (subscriptionTier === 'Premium') return 'black';
  if (subscriptionTier === 'Pro') return 'silver';
  return 'basic';
}

function mapGoal(goal?: string | null): DashboardGoal {
  if (goal === 'hypertrophy') return 'hipertrofia';
  if (goal === 'conditioning') return 'condicionamento';
  return 'emagrecimento';
}

function targetWorkoutsPerMonth(plan: DashboardPlan) {
  if (plan === 'black') return 10;
  if (plan === 'gold') return 9;
  if (plan === 'silver') return 8;
  return 6;
}

function daysSince(iso: string | null) {
  if (!iso) return 999;
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) return 999;
  return Math.floor((Date.now() - value) / (1000 * 60 * 60 * 24));
}

function addDays(baseISO: string | null, days: number) {
  const baseDate = baseISO ? new Date(baseISO) : new Date();
  const nextDate = new Date(baseDate.getTime());
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function addDaysToDate(date: Date, days: number) {
  const nextDate = new Date(date.getTime());
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysUntilDate(isoDate: string) {
  const value = new Date(`${isoDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(value)) return -999;
  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((value - todayUTC) / (1000 * 60 * 60 * 24));
}

function resolveRisk(input: { lastWorkoutISO: string | null; workouts7d: number; adherencePct: number }): DashboardRisk {
  const inactivityDays = daysSince(input.lastWorkoutISO);

  if (inactivityDays >= 10 || input.workouts7d === 0 || input.adherencePct < 15) {
    return 'critico';
  }

  if (inactivityDays >= 5 || input.workouts7d <= 1 || input.adherencePct < 45) {
    return 'alerta';
  }

  return 'ok';
}

export async function getPersonalDashboard(personalId: number) {
  const result = await pool.query(
    `SELECT
        u.id,
        u.name,
        u.fitness_goal,
        psa.notes,
        st.name AS subscription_tier,
        COALESCE(gs.current_streak, 0) AS current_streak,
        (
          SELECT COUNT(*)
          FROM user_workout_logs uwl7
          WHERE uwl7.user_id = u.id
            AND uwl7.completed_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        ) AS workouts_7d,
        (
          SELECT COUNT(*)
          FROM user_workout_logs uwl30
          WHERE uwl30.user_id = u.id
            AND uwl30.completed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
        ) AS workouts_30d,
        (
          SELECT uwll.completed_at
          FROM user_workout_logs uwll
          WHERE uwll.user_id = u.id
          ORDER BY uwll.completed_at DESC
          LIMIT 1
        ) AS last_workout_at
      FROM personal_student_assignments psa
      JOIN users u
        ON u.id = psa.student_id
      LEFT JOIN user_gamification_stats gs
        ON gs.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT ust.tier_id
        FROM user_subscriptions ust
        WHERE ust.user_id = u.id
          AND ust.status = 'active'
        ORDER BY ust.created_at DESC
        LIMIT 1
      ) active_subscription
        ON TRUE
      LEFT JOIN subscription_tiers st
        ON st.id = active_subscription.tier_id
      WHERE psa.personal_id = $1
        AND psa.status = 'active'
        AND u.role = 'user'
      ORDER BY u.name ASC`,
    [personalId]
  );

  const students: DashboardStudent[] = result.rows.map((row) => {
    const plan = mapPlan(row.subscription_tier);
    const workouts30d = Number(row.workouts_30d || 0);
    const target30d = targetWorkoutsPerMonth(plan);
    const adherencePct = clamp(Math.round((workouts30d / target30d) * 100), 0, 100);
    const lastWorkoutISO = row.last_workout_at ? new Date(row.last_workout_at).toISOString() : null;
    const risk = resolveRisk({
      lastWorkoutISO,
      workouts7d: Number(row.workouts_7d || 0),
      adherencePct,
    });

    return {
      id: String(row.id),
      name: row.name || `Aluno ${row.id}`,
      plan,
      workouts7d: Number(row.workouts_7d || 0),
      workouts30d,
      streakDays: Number(row.current_streak || 0),
      lastWorkoutISO,
      adherencePct,
      risk,
      goal: mapGoal(row.fitness_goal),
      notes: row.notes || null,
    };
  });

  const totalStudents = students.length;
  const total7d = students.reduce((acc, student) => acc + student.workouts7d, 0);
  const total30d = students.reduce((acc, student) => acc + student.workouts30d, 0);
  const most = [...students].sort((a, b) => b.workouts7d - a.workouts7d)[0] || null;
  const least = [...students].sort((a, b) => a.workouts7d - b.workouts7d)[0] || null;
  const criticalCount = students.filter((student) => student.risk === 'critico').length;
  const alertCount = students.filter((student) => student.risk === 'alerta').length;
  const okCount = students.filter((student) => student.risk === 'ok').length;
  const needsFollowUp = [...students]
    .filter((student) => student.risk !== 'ok')
    .sort((a, b) => a.adherencePct - b.adherencePct)
    .slice(0, 4);

  return {
    summary: {
      totalStudents,
      total7d,
      total30d,
      avg7d: totalStudents ? Math.round((total7d / totalStudents) * 10) / 10 : 0,
      avg30d: totalStudents ? Math.round((total30d / totalStudents) * 10) / 10 : 0,
      okCount,
      alertCount,
      criticalCount,
      most,
      least,
      needsFollowUp,
    },
    students,
    generatedAt: new Date().toISOString(),
  };
}

export async function getPersonalConsulting(personalId: number) {
  const result = await pool.query(
    `SELECT
        u.id,
        u.name,
        st.name AS subscription_tier,
        (
          SELECT COUNT(*)
          FROM user_workout_logs uwl30
          WHERE uwl30.user_id = u.id
            AND uwl30.completed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
        ) AS workouts_30d,
        (
          SELECT uwll.completed_at
          FROM user_workout_logs uwll
          WHERE uwll.user_id = u.id
          ORDER BY uwll.completed_at DESC
          LIMIT 1
        ) AS last_workout_at
      FROM personal_student_assignments psa
      JOIN users u
        ON u.id = psa.student_id
      LEFT JOIN LATERAL (
        SELECT ust.tier_id
        FROM user_subscriptions ust
        WHERE ust.user_id = u.id
          AND ust.status = 'active'
        ORDER BY ust.created_at DESC
        LIMIT 1
      ) active_subscription
        ON TRUE
      LEFT JOIN subscription_tiers st
        ON st.id = active_subscription.tier_id
      WHERE psa.personal_id = $1
        AND psa.status = 'active'
        AND u.role = 'user'
      ORDER BY u.name ASC`,
    [personalId]
  );

  const students: ConsultingStudent[] = result.rows.map((row) => {
    const plan = mapPlan(row.subscription_tier);
    const workoutsDoneInCurrentPlan = Number(row.workouts_30d || 0);
    const workoutsPlannedInCurrentPlan = targetWorkoutsPerMonth(plan);
    const lastWorkoutISO = row.last_workout_at ? new Date(row.last_workout_at).toISOString() : null;
    const fallbackLastWorkoutDate = addDaysToDate(new Date(), -30);
    const effectiveLastWorkoutDate = lastWorkoutISO ? new Date(lastWorkoutISO) : fallbackLastWorkoutDate;
    const lastWorkoutUpdateAt = toISODate(effectiveLastWorkoutDate);
    const planExpiresAt = toISODate(addDaysToDate(effectiveLastWorkoutDate, 30));
    const daysLeft = daysUntilDate(planExpiresAt);

    let status: ConsultingStatus = 'on_track';
    let nextAction: ConsultingNextAction = 'keep_progression';

    if (daysLeft <= 0) {
      status = 'urgent';
      nextAction = 'refresh_today';
    } else if (daysLeft <= 5) {
      status = 'warning';
      nextAction = 'prepare_update';
    } else if (workoutsDoneInCurrentPlan < Math.ceil(workoutsPlannedInCurrentPlan * 0.5)) {
      status = 'warning';
      nextAction = 'review_adherence';
    }

    return {
      id: String(row.id),
      name: row.name || `Aluno ${row.id}`,
      plan,
      planExpiresAt,
      lastWorkoutUpdateAt,
      workoutsDoneInCurrentPlan,
      workoutsPlannedInCurrentPlan,
      status,
      nextAction,
    };
  });

  const urgent = students.filter((student) => student.status === 'urgent').length;
  const warning = students.filter((student) => student.status === 'warning').length;
  const onTrack = students.filter((student) => student.status === 'on_track').length;

  return {
    summary: {
      total: students.length,
      urgent,
      warning,
      onTrack,
    },
    students,
    generatedAt: new Date().toISOString(),
  };
}
