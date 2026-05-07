import pool from '../config/database';
import { getMetabolismForUser, getMetabolismHistoryForUser } from '../modules/metabolism/metabolic.service';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

type DashboardRisk = 'ok' | 'alerta' | 'critico';
type DashboardPlan = 'basic' | 'silver' | 'gold' | 'black';
type DashboardGoal = 'emagrecimento' | 'hipertrofia' | 'condicionamento';
type DashboardEngagementStatus = 'evolving' | 'on_track' | 'attention' | 'fading' | 'at_risk';
type DashboardAlertType = 'attention_load' | 'full_adherence' | 'silent_disappear' | 'overtraining';

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
  engagementStatus: DashboardEngagementStatus;
  lastCheckinISO: string | null;
  checkins7d: number;
};

type DashboardAlert = {
  type: DashboardAlertType;
  title: string;
  description: string;
  studentId: string | null;
  studentName: string | null;
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

function latestTouchpointDays(lastWorkoutISO: string | null, lastCheckinISO: string | null) {
  return Math.min(daysSince(lastWorkoutISO), daysSince(lastCheckinISO));
}

function resolveEngagementStatus(input: {
  risk: DashboardRisk;
  adherencePct: number;
  streakDays: number;
  workouts7d: number;
  lastWorkoutISO: string | null;
  lastCheckinISO: string | null;
}): DashboardEngagementStatus {
  const touchpointGap = latestTouchpointDays(input.lastWorkoutISO, input.lastCheckinISO);

  if (input.risk === 'critico' && touchpointGap >= 10) return 'at_risk';
  if (input.risk === 'critico' && touchpointGap >= 5) return 'fading';
  if (input.risk !== 'ok') return 'attention';
  if (input.streakDays >= 3 && input.adherencePct >= 80) return 'evolving';
  return 'on_track';
}

function buildIntelligentAlerts(students: DashboardStudent[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  const attentionLoad = students.filter(
    (student) => student.engagementStatus === 'attention' || student.engagementStatus === 'fading' || student.engagementStatus === 'at_risk'
  );
  if (attentionLoad.length >= 3) {
    alerts.push({
      type: 'attention_load',
      title: `${attentionLoad.length} alunos pedem atenção hoje`,
      description: 'A carteira já mostra sinais de baixa aderência ou ausência recente. Vale priorizar contato curto e ajuste rápido.',
      studentId: null,
      studentName: null,
    });
  }

  const fullAdherence = [...students]
    .filter((student) => student.adherencePct >= 100)
    .sort((a, b) => b.streakDays - a.streakDays)[0];
  if (fullAdherence) {
    alerts.push({
      type: 'full_adherence',
      title: `${fullAdherence.name} completou 100% da aderência`,
      description: 'Bom momento para reforço positivo e progressão de treino.',
      studentId: fullAdherence.id,
      studentName: fullAdherence.name,
    });
  }

  const silentDisappear = [...students]
    .filter((student) => latestTouchpointDays(student.lastWorkoutISO, student.lastCheckinISO) >= 5)
    .sort(
      (a, b) =>
        latestTouchpointDays(b.lastWorkoutISO, b.lastCheckinISO) -
        latestTouchpointDays(a.lastWorkoutISO, a.lastCheckinISO)
    )[0];
  if (silentDisappear) {
    alerts.push({
      type: 'silent_disappear',
      title: `${silentDisappear.name} está sumindo`,
      description: `Sem treino ou check-in recente há ${latestTouchpointDays(
        silentDisappear.lastWorkoutISO,
        silentDisappear.lastCheckinISO
      )} dias.`,
      studentId: silentDisappear.id,
      studentName: silentDisappear.name,
    });
  }

  const overtraining = [...students]
    .filter((student) => student.workouts7d > 5)
    .sort((a, b) => b.workouts7d - a.workouts7d)[0];
  if (overtraining) {
    alerts.push({
      type: 'overtraining',
      title: `${overtraining.name} treinou ${overtraining.workouts7d}x nesta semana`,
      description: 'Possível sobrecarga. Vale revisar volume, intensidade e recuperação.',
      studentId: overtraining.id,
      studentName: overtraining.name,
    });
  }

  return alerts.slice(0, 4);
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
        ) AS last_workout_at,
        (
          SELECT COUNT(*)
          FROM user_daily_checkins udc7
          WHERE udc7.user_id = u.id
            AND udc7.date_key >= CURRENT_DATE - INTERVAL '6 days'
        ) AS checkins_7d,
        (
          SELECT udcl.date_key
          FROM user_daily_checkins udcl
          WHERE udcl.user_id = u.id
          ORDER BY udcl.date_key DESC
          LIMIT 1
        ) AS last_checkin_date
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
    const lastCheckinISO = row.last_checkin_date ? new Date(row.last_checkin_date).toISOString() : null;
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
      engagementStatus: resolveEngagementStatus({
        risk,
        adherencePct,
        streakDays: Number(row.current_streak || 0),
        workouts7d: Number(row.workouts_7d || 0),
        lastWorkoutISO,
        lastCheckinISO,
      }),
      lastCheckinISO,
      checkins7d: Number(row.checkins_7d || 0),
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
    .filter((student) => student.engagementStatus !== 'on_track' && student.engagementStatus !== 'evolving')
    .sort((a, b) => {
      const weight: Record<DashboardEngagementStatus, number> = {
        at_risk: 0,
        fading: 1,
        attention: 2,
        on_track: 3,
        evolving: 4,
      };
      const diff = weight[a.engagementStatus] - weight[b.engagementStatus];
      if (diff !== 0) return diff;
      return a.adherencePct - b.adherencePct;
    })
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
      intelligentAlerts: buildIntelligentAlerts(students),
    },
    students,
    generatedAt: new Date().toISOString(),
  };
}

export async function getPersonalStudentSnapshot(personalId: number, studentId: number) {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const [dashboard, studentRow, latestActivity, latestWorkout, latestMovement, weekRows, activityTypeRows, xpRow, latestMessageRow, metabolism, metabolismHistory] =
    await Promise.all([
      getPersonalDashboard(personalId),
      pool.query(
        `SELECT
            u.id,
            u.name,
            u.fitness_goal,
            psa.notes,
            st.name AS subscription_tier,
            COALESCE(gs.current_streak, 0) AS current_streak,
            COALESCE(gs.xp, 0) AS xp
         FROM users u
         JOIN personal_student_assignments psa
           ON psa.student_id = u.id
          AND psa.personal_id = $1
          AND psa.status = 'active'
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
         WHERE u.id = $2
         LIMIT 1`,
        [personalId, studentId]
      ),
      pool.query(
        `SELECT activity_type, distance_km, duration_seconds, intensity, created_at
         FROM activity_sessions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [studentId]
      ),
      pool.query(
        `SELECT title, completed_at
         FROM user_workout_logs
         WHERE user_id = $1
         ORDER BY completed_at DESC
         LIMIT 1`,
        [studentId]
      ),
      pool.query(
        `SELECT
            AVG(avg_form_score)::int AS avg_form_score_7d,
            COUNT(*)::int AS movement_sessions_7d,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'date', created_at::date::text,
                  'score', avg_form_score,
                  'exerciseLabel', exercise_label
                )
                ORDER BY created_at DESC
              ) FILTER (WHERE created_at IS NOT NULL),
              '[]'::json
            ) AS recent_scores
         FROM (
           SELECT exercise_label, avg_form_score, created_at
           FROM movement_sessions
           WHERE user_id = $1
             AND created_at >= NOW() - INTERVAL '14 days'
           ORDER BY created_at DESC
           LIMIT 5
         ) recent_movement`,
        [studentId]
      ),
      pool.query(
        `WITH days AS (
            SELECT GENERATE_SERIES(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day')::date AS day
         )
         SELECT
           days.day::text AS date,
           EXISTS (
             SELECT 1 FROM user_workout_logs uwl
             WHERE uwl.user_id = $1
               AND uwl.completed_at::date = days.day
           ) AS worked_out,
           EXISTS (
             SELECT 1 FROM activity_sessions act
             WHERE act.user_id = $1
               AND act.created_at::date = days.day
           ) AS had_gps,
           EXISTS (
             SELECT 1 FROM user_daily_checkins chk
             WHERE chk.user_id = $1
               AND chk.date_key = days.day
           ) AS checked_in
         FROM days
         ORDER BY days.day ASC`,
        [studentId]
      ),
      pool.query(
        `SELECT activity_type AS type, COUNT(*)::int AS count
         FROM activity_sessions
         WHERE user_id = $1
           AND created_at >= NOW() - INTERVAL '14 days'
         GROUP BY activity_type
         ORDER BY COUNT(*) DESC, activity_type ASC`,
        [studentId]
      ),
      pool.query(
        `SELECT COALESCE(xp, 0)::int AS xp
         FROM user_gamification_stats
         WHERE user_id = $1
         LIMIT 1`,
        [studentId]
      ),
      pool.query(
        `SELECT cm.text, cm.created_at, cm.sender_role
         FROM chat_conversations cc
         JOIN chat_messages cm
           ON cm.conversation_id = cc.id
         WHERE cc.personal_id = $1
           AND cc.student_id = $2
         ORDER BY cm.created_at DESC
         LIMIT 1`,
        [personalId, studentId]
      ),
      getMetabolismForUser(studentId),
      getMetabolismHistoryForUser(studentId),
    ]);

  const student = dashboard.students.find((item) => item.id === String(studentId));
  const row = studentRow.rows[0];

  if (!row || !student) {
    throw new Error('Student snapshot not found');
  }

  const weeklyDays = weekRows.rows.map((entry) => ({
    date: entry.date,
    workedOut: Boolean(entry.worked_out),
    hadGps: Boolean(entry.had_gps),
    checkedIn: Boolean(entry.checked_in),
  }));

  const workoutDoneToday = weeklyDays[weeklyDays.length - 1]?.workedOut ?? false;
  const latestActivityRow = latestActivity.rows[0];
  const latestWorkoutRow = latestWorkout.rows[0];
  const latestMessage = latestMessageRow.rows[0];
  const movementRow = latestMovement.rows[0];

  return {
    id: String(row.id),
    name: row.name || `Aluno ${row.id}`,
    plan: student.plan,
    goal: student.goal,
    notes: row.notes || null,
    risk: student.risk,
    engagementStatus: student.engagementStatus,
    adherencePct: student.adherencePct,
    streakDays: Number(row.current_streak || 0),
    today: {
      checkedInToday: weeklyDays[weeklyDays.length - 1]?.checkedIn ?? false,
      lastCheckinISO: student.lastCheckinISO,
      moodAvailable: false,
      metabolism: metabolism
        ? {
            score: metabolism.score,
            status: metabolism.status,
            trend: metabolism.trend,
          }
        : null,
      latestActivity: latestActivityRow
        ? {
            type: latestActivityRow.activity_type,
            distanceKm: Number(latestActivityRow.distance_km || 0),
            durationMinutes: Math.round(Number(latestActivityRow.duration_seconds || 0) / 60),
            intensity: latestActivityRow.intensity || null,
            createdAt: new Date(latestActivityRow.created_at).toISOString(),
          }
        : null,
      latestWorkout: latestWorkoutRow
        ? {
            title: latestWorkoutRow.title,
            completedAt: new Date(latestWorkoutRow.completed_at).toISOString(),
          }
        : null,
      workoutStatus: workoutDoneToday ? 'completed' : 'not_started',
    },
    week: {
      days: weeklyDays,
      avgFormScore: movementRow?.avg_form_score_7d ? Number(movementRow.avg_form_score_7d) : null,
      movementSessions7d: Number(movementRow?.movement_sessions_7d || 0),
      latestMessagePreview: latestMessage
        ? {
            text: latestMessage.text,
            createdAt: new Date(latestMessage.created_at).toISOString(),
            senderRole: latestMessage.sender_role,
          }
        : null,
    },
    history: {
      adherence14d: metabolismHistory.map((item) => ({ date: item.date, score: item.score })),
      formScoreSeries: Array.isArray(movementRow?.recent_scores) ? movementRow.recent_scores : [],
      activityTypeCounts: activityTypeRows.rows.map((item) => ({
        type: item.type,
        count: Number(item.count || 0),
      })),
      xp: Number(xpRow.rows[0]?.xp || row.xp || 0),
    },
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
