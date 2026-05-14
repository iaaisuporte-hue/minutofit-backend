import pool from '../config/database';
import { getMetabolismForUser, getMetabolismHistoryForUser } from '../modules/metabolism/metabolic.service';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';
import { fetchTechnicalSnapshotData } from './studentExerciseNotesService';

type DashboardRisk = 'ok' | 'alerta' | 'critico';
type DashboardPlan = 'basic' | 'silver' | 'gold' | 'black';
type DashboardGoal = 'emagrecimento' | 'hipertrofia' | 'condicionamento';
type DashboardEngagementStatus = 'evolving' | 'on_track' | 'attention' | 'fading' | 'at_risk';
type DashboardAlertType =
  | 'attention_load'
  | 'cluster_low_sleep'
  | 'full_adherence'
  | 'silent_disappear'
  | 'overtraining'
  | 'metabolic_decline'
  | 'recovery_gap';
type MetabolicBand = 'low' | 'moderate' | 'high' | 'unknown';
type MetabolicTrend = 'up' | 'down' | 'stable' | 'unknown';

type DashboardStudent = {
  id: string;
  name: string;
  plan: DashboardPlan;
  workouts7d: number;
  workouts30d: number;
  streakDays: number;
  lastWorkoutISO: string | null;
  adherencePct: number;
  adherenceScore: number;
  engagementScore: number;
  riskScore: number;
  risk: DashboardRisk;
  goal: DashboardGoal;
  notes: string | null;
  engagementStatus: DashboardEngagementStatus;
  lastCheckinISO: string | null;
  checkins7d: number;
  metabolismScore: number | null;
  metabolismBand: MetabolicBand;
  metabolismTrend: MetabolicTrend;
  metabolismDelta7d: number | null;
  latestSleptWell: boolean | null;
  lastTechnicalNoteAt: string | null;
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

function computeEngagementScore(input: {
  adherencePct: number;
  workouts7d: number;
  streakDays: number;
  checkins7d: number;
}): number {
  const recency7d = clamp((input.workouts7d / 4) * 100, 0, 100);
  const streakNorm = clamp((input.streakDays / 14) * 100, 0, 100);
  const checkinFreq = clamp((input.checkins7d / 7) * 100, 0, 100);
  const score =
    0.45 * input.adherencePct +
    0.25 * recency7d +
    0.15 * streakNorm +
    0.15 * checkinFreq;
  return Math.round(clamp(score, 0, 100));
}

function computeRiskScore(input: {
  engagementScore: number;
  metabolismDelta7d: number | null;
  latestSleptWell: boolean | null;
  lastWorkoutISO: string | null;
  lastCheckinISO: string | null;
}): number {
  let score = 100 - input.engagementScore;
  if (input.metabolismDelta7d !== null && input.metabolismDelta7d <= -15) score += 15;
  if (input.latestSleptWell === false) score += 10;
  const touchpointGap = latestTouchpointDays(input.lastWorkoutISO, input.lastCheckinISO);
  if (touchpointGap >= 10) score += 10;
  return Math.round(clamp(score, 0, 100));
}

function bandFromScore(score: number | null): MetabolicBand {
  if (score === null) return 'unknown';
  if (score >= 70) return 'high';
  if (score >= 45) return 'moderate';
  return 'low';
}

function normalizeTrend(trend: unknown): MetabolicTrend {
  if (trend === 'up' || trend === 'down' || trend === 'stable') return trend;
  return 'unknown';
}

type MetabolismRow = {
  user_id: number;
  latest_score: number | null;
  latest_trend: string | null;
  baseline_score: number | null;
};

async function loadCarteiraMetabolism(studentIds: number[]): Promise<Map<number, MetabolismRow>> {
  const map = new Map<number, MetabolismRow>();
  if (studentIds.length === 0) return map;

  const result = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (user_id)
         user_id,
         score AS latest_score,
         trend AS latest_trend,
         snapshot_date AS latest_date
       FROM user_metabolism_snapshots
       WHERE user_id = ANY($1::int[])
       ORDER BY user_id, snapshot_date DESC
     ),
     baseline AS (
       SELECT DISTINCT ON (user_id)
         user_id,
         score AS baseline_score
       FROM user_metabolism_snapshots
       WHERE user_id = ANY($1::int[])
         AND snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY user_id, snapshot_date DESC
     )
     SELECT
       l.user_id,
       l.latest_score,
       l.latest_trend,
       b.baseline_score
     FROM latest l
     LEFT JOIN baseline b ON b.user_id = l.user_id`,
    [studentIds]
  );

  for (const row of result.rows) {
    map.set(Number(row.user_id), {
      user_id: Number(row.user_id),
      latest_score: row.latest_score !== null ? Number(row.latest_score) : null,
      latest_trend: row.latest_trend ?? null,
      baseline_score: row.baseline_score !== null ? Number(row.baseline_score) : null,
    });
  }

  return map;
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

  const clusterLowSleep = students.filter((student) => student.latestSleptWell === false);
  if (clusterLowSleep.length >= 3) {
    alerts.push({
      type: 'cluster_low_sleep',
      title: `${clusterLowSleep.length} alunos relataram sono ruim`,
      description:
        'Vários alunos indicaram sono ruim no check-in recente — revisar carga semanal, volume e janelas de recuperação pode evitar fadiga coletiva.',
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

  const metabolicDecline = [...students]
    .filter(
      (student) =>
        student.metabolismScore !== null &&
        student.metabolismDelta7d !== null &&
        student.metabolismDelta7d <= -15
    )
    .sort((a, b) => (a.metabolismDelta7d ?? 0) - (b.metabolismDelta7d ?? 0))[0];
  if (metabolicDecline && metabolicDecline.metabolismDelta7d !== null) {
    const dropAbs = Math.abs(metabolicDecline.metabolismDelta7d);
    alerts.push({
      type: 'metabolic_decline',
      title: `${metabolicDecline.name} com score em queda`,
      description: `Score metabólico caiu ${dropAbs} ponto(s) nos últimos 7 dias. Investigar fadiga, sono ou volume.`,
      studentId: metabolicDecline.id,
      studentName: metabolicDecline.name,
    });
  }

  const recoveryGap = [...students]
    .filter(
      (student) =>
        student.workouts7d >= 5 && student.metabolismScore !== null && student.metabolismScore < 55
    )
    .sort((a, b) => (a.metabolismScore ?? 0) - (b.metabolismScore ?? 0))[0];
  if (recoveryGap && recoveryGap.metabolismScore !== null) {
    alerts.push({
      type: 'recovery_gap',
      title: `${recoveryGap.name} com volume alto e recuperação baixa`,
      description: `${recoveryGap.workouts7d} treinos em 7 dias com score metabólico em ${recoveryGap.metabolismScore}. Sugerir descarga ou ajuste de carga.`,
      studentId: recoveryGap.id,
      studentName: recoveryGap.name,
    });
  }

  return alerts.slice(0, 6);
}

type RetentionInsight = {
  kind: 'adherence_correlation' | 'individual_drop' | 'portfolio_signal';
  title: string;
  body: string;
  studentId: string | null;
};

function computeRetentionInsights(students: DashboardStudent[]): RetentionInsight[] {
  if (students.length === 0) return [];
  const insights: RetentionInsight[] = [];

  // Correlação: alunos com 3+ treinos/sem vs demais
  const frequent = students.filter((s) => s.workouts7d >= 3);
  const infrequent = students.filter((s) => s.workouts7d < 3);
  if (frequent.length > 0 && infrequent.length > 0) {
    const avgFreq = Math.round(frequent.reduce((a, s) => a + s.adherencePct, 0) / frequent.length);
    const avgInfreq = Math.round(
      infrequent.reduce((a, s) => a + s.adherencePct, 0) / infrequent.length
    );
    if (avgFreq > avgInfreq + 10) {
      insights.push({
        kind: 'adherence_correlation',
        title: 'Frequência e aderência andam juntas',
        body: `Alunos com 3+ treinos/sem têm aderência média ${avgFreq}% — ${avgFreq - avgInfreq}pts acima dos demais. Vale incentivar esse ritmo.`,
        studentId: null,
      });
    }
  }

  // Sinal individual: aluno com maior queda de risco recente
  const worstDrop = [...students]
    .filter((s) => s.riskScore >= 60 && s.workouts7d <= 1)
    .sort((a, b) => b.riskScore - a.riskScore)[0];
  if (worstDrop) {
    const daysSince = daysSinceLastWorkout(worstDrop.lastWorkoutISO);
    insights.push({
      kind: 'individual_drop',
      title: `${worstDrop.name} com queda de aderência`,
      body: `Sem treino há ${daysSince} dias e engajamento baixo nas últimas 2 semanas. Um contato rápido pode fazer diferença.`,
      studentId: worstDrop.id,
    });
  }

  // Sinal de carteira: score metabólico em queda
  const metabolicDropCount = students.filter(
    (s) => s.metabolismDelta7d !== null && s.metabolismDelta7d <= -10
  ).length;
  if (metabolicDropCount >= 2) {
    insights.push({
      kind: 'portfolio_signal',
      title: `${metabolicDropCount} alunos com score metabólico em queda`,
      body: 'Vale revisar carga, volume e recuperação desta semana para evitar fadiga acumulada.',
      studentId: null,
    });
  }

  return insights.slice(0, 3);
}

function daysSinceLastWorkout(iso: string | null): number {
  if (!iso) return 999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export async function getPersonalDashboard(personalId: number, academyId?: number | null) {
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
            AND ($2::integer IS NULL OR uwl7.academy_id = $2)
        ) AS workouts_7d,
        (
          SELECT COUNT(*)
          FROM user_workout_logs uwl30
          WHERE uwl30.user_id = u.id
            AND uwl30.completed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
            AND ($2::integer IS NULL OR uwl30.academy_id = $2)
        ) AS workouts_30d,
        (
          SELECT uwll.completed_at
          FROM user_workout_logs uwll
          WHERE uwll.user_id = u.id
            AND ($2::integer IS NULL OR uwll.academy_id = $2)
          ORDER BY uwll.completed_at DESC
          LIMIT 1
        ) AS last_workout_at,
        (
          SELECT COUNT(*)
          FROM user_daily_checkins udc7
          WHERE udc7.user_id = u.id
            AND udc7.date_key >= CURRENT_DATE - INTERVAL '6 days'
            AND ($2::integer IS NULL OR udc7.academy_id = $2)
        ) AS checkins_7d,
        (
          SELECT udcl.date_key
          FROM user_daily_checkins udcl
          WHERE udcl.user_id = u.id
            AND ($2::integer IS NULL OR udcl.academy_id = $2)
          ORDER BY udcl.date_key DESC
          LIMIT 1
        ) AS last_checkin_date,
        (
          SELECT udc_last.slept_well
          FROM user_daily_checkins udc_last
          WHERE udc_last.user_id = u.id
            AND ($2::integer IS NULL OR udc_last.academy_id = $2)
          ORDER BY udc_last.date_key DESC, udc_last.created_at DESC
          LIMIT 1
        ) AS latest_slept_well,
        (
          SELECT MAX(sen.recorded_at)
          FROM student_exercise_notes sen
          WHERE sen.student_id = u.id
            AND sen.personal_id = $1
            AND ($2::integer IS NULL OR sen.academy_id IS NULL OR sen.academy_id = $2)
        ) AS last_technical_note_at
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
        AND ($2::integer IS NULL OR psa.academy_id = $2)
      ORDER BY u.name ASC`,
    [personalId, academyId ?? null]
  );

  const baseStudents = result.rows.map((row) => {
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
      numericId: Number(row.id),
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
      latestSleptWell: row.latest_slept_well === null || row.latest_slept_well === undefined ? null : Boolean(row.latest_slept_well),
      lastTechnicalNoteAt: row.last_technical_note_at
        ? new Date(row.last_technical_note_at).toISOString()
        : null,
    };
  });

  const metabolismMap = await loadCarteiraMetabolism(baseStudents.map((s) => s.numericId));

  const students: DashboardStudent[] = baseStudents.map((s) => {
    const m = metabolismMap.get(s.numericId);
    const latestScore = m?.latest_score ?? null;
    const baselineScore = m?.baseline_score ?? null;
    const delta =
      latestScore !== null && baselineScore !== null ? latestScore - baselineScore : null;
    const engagementScore = computeEngagementScore({
      adherencePct: s.adherencePct,
      workouts7d: s.workouts7d,
      streakDays: s.streakDays,
      checkins7d: s.checkins7d,
    });
    const riskScore = computeRiskScore({
      engagementScore,
      metabolismDelta7d: delta,
      latestSleptWell: s.latestSleptWell,
      lastWorkoutISO: s.lastWorkoutISO,
      lastCheckinISO: s.lastCheckinISO,
    });
    const { numericId: _omit, ...rest } = s;
    void _omit;
    return {
      ...rest,
      adherenceScore: s.adherencePct,
      engagementScore,
      riskScore,
      metabolismScore: latestScore,
      metabolismBand: bandFromScore(latestScore),
      metabolismTrend: normalizeTrend(m?.latest_trend),
      metabolismDelta7d: delta,
      latestSleptWell: s.latestSleptWell,
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

  const metabolismDistribution = students.reduce(
    (acc, student) => {
      acc[student.metabolismBand] += 1;
      return acc;
    },
    { low: 0, moderate: 0, high: 0, unknown: 0 }
  );

  const atRiskTop = [...students]
    .filter((s) => s.riskScore >= 55)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 8);

  const insights = computeRetentionInsights(students);

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
      metabolismDistribution,
      atRiskTop,
      insights,
    },
    students,
    generatedAt: new Date().toISOString(),
  };
}

export async function getPersonalStudentSnapshot(
  personalId: number,
  studentId: number,
  academyId?: number | null
) {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const [
    dashboard,
    studentRow,
    latestActivity,
    latestWorkout,
    latestMovement,
    weekRows,
    activityTypeRows,
    xpRow,
    latestMessageRow,
    metabolism,
    metabolismHistory,
    muscleGroupRows,
    latestWellbeingRow,
    wellbeingHistoryRows,
    technicalData,
  ] =
    await Promise.all([
      getPersonalDashboard(personalId, academyId ?? null),
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
           AND ($3::integer IS NULL OR psa.academy_id = $3)
         LIMIT 1`,
        [personalId, studentId, academyId ?? null]
      ),
      pool.query(
        `SELECT activity_type, distance_km, duration_seconds, intensity, score, calories_estimated, validation_flag, created_at
         FROM activity_sessions
         WHERE user_id = $1
           AND ($2::integer IS NULL OR academy_id = $2)
         ORDER BY created_at DESC
         LIMIT 1`,
        [studentId, academyId ?? null]
      ),
      pool.query(
        `SELECT title, completed_at
         FROM user_workout_logs
         WHERE user_id = $1
           AND ($2::integer IS NULL OR academy_id = $2)
         ORDER BY completed_at DESC
         LIMIT 1`,
        [studentId, academyId ?? null]
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
             AND ($2::integer IS NULL OR academy_id = $2)
           ORDER BY created_at DESC
           LIMIT 5
         ) recent_movement`,
        [studentId, academyId ?? null]
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
               AND ($2::integer IS NULL OR uwl.academy_id = $2)
           ) AS worked_out,
           EXISTS (
             SELECT 1 FROM activity_sessions act
             WHERE act.user_id = $1
               AND act.created_at::date = days.day
               AND ($2::integer IS NULL OR act.academy_id = $2)
           ) AS had_gps,
           EXISTS (
             SELECT 1 FROM user_daily_checkins chk
             WHERE chk.user_id = $1
               AND chk.date_key = days.day
               AND ($2::integer IS NULL OR chk.academy_id = $2)
           ) AS checked_in
         FROM days
         ORDER BY days.day ASC`,
        [studentId, academyId ?? null]
      ),
      pool.query(
        `SELECT activity_type AS type, COUNT(*)::int AS count
         FROM activity_sessions
         WHERE user_id = $1
           AND created_at >= NOW() - INTERVAL '14 days'
           AND ($2::integer IS NULL OR academy_id = $2)
         GROUP BY activity_type
         ORDER BY COUNT(*) DESC, activity_type ASC`,
        [studentId, academyId ?? null]
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
           AND ($3::integer IS NULL OR cc.academy_id = $3)
         ORDER BY cm.created_at DESC
         LIMIT 1`,
        [personalId, studentId, academyId ?? null]
      ),
      getMetabolismForUser(studentId),
      getMetabolismHistoryForUser(studentId),
      pool.query(
        `SELECT muscle_group, COUNT(*)::int AS count
         FROM (
           SELECT UNNEST(muscle_groups) AS muscle_group
           FROM user_workout_logs
           WHERE user_id = $1
             AND completed_at >= NOW() - INTERVAL '30 days'
             AND ($2::integer IS NULL OR academy_id = $2)
         ) expanded
         WHERE muscle_group IS NOT NULL AND muscle_group <> ''
         GROUP BY muscle_group
         ORDER BY count DESC, muscle_group ASC`,
        [studentId, academyId ?? null]
      ),
      pool.query(
        `SELECT feeling, slept_well, in_pain, stressed, notes, date_key::text AS date_key
         FROM user_daily_checkins
         WHERE user_id = $1
           AND ($2::integer IS NULL OR academy_id = $2)
         ORDER BY date_key DESC, created_at DESC
         LIMIT 1`,
        [studentId, academyId ?? null]
      ),
      pool.query(
        `SELECT date_key::text AS date_key, feeling, slept_well, in_pain, stressed
         FROM user_daily_checkins
         WHERE user_id = $1
           AND ($2::integer IS NULL OR academy_id = $2)
           AND date_key >= CURRENT_DATE - INTERVAL '13 days'
         ORDER BY date_key ASC, created_at ASC`,
        [studentId, academyId ?? null]
      ),
      fetchTechnicalSnapshotData(studentId, academyId ?? null),
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
  const wRow = latestWellbeingRow.rows[0];
  const wellbeing =
    wRow &&
    (wRow.feeling != null ||
      wRow.slept_well != null ||
      wRow.in_pain != null ||
      wRow.stressed != null ||
      (wRow.notes != null && String(wRow.notes).trim().length > 0))
      ? {
          feeling: wRow.feeling as string | null,
          sleptWell: wRow.slept_well === null ? null : Boolean(wRow.slept_well),
          inPain: wRow.in_pain === null ? null : Boolean(wRow.in_pain),
          stressed: wRow.stressed === null ? null : Boolean(wRow.stressed),
          notes: wRow.notes ? String(wRow.notes) : null,
          dateKey: wRow.date_key,
        }
      : null;

  const wellbeingHistory14d = wellbeingHistoryRows.rows.map((h) => ({
    dateKey: String(h.date_key),
    feeling: h.feeling as string | null,
    sleptWell: h.slept_well === null || h.slept_well === undefined ? null : Boolean(h.slept_well),
    inPain: h.in_pain === null || h.in_pain === undefined ? null : Boolean(h.in_pain),
    stressed: h.stressed === null || h.stressed === undefined ? null : Boolean(h.stressed),
  }));

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
    metabolismDetail: metabolism
      ? {
          score: metabolism.score,
          status: metabolism.status,
          trend: metabolism.trend,
          factors: metabolism.factors,
          recommendations: metabolism.recommendations,
          trend7d: metabolism.trend7d,
          trend30d: metabolism.trend30d,
        }
      : null,
    today: {
      checkedInToday: weeklyDays[weeklyDays.length - 1]?.checkedIn ?? false,
      lastCheckinISO: student.lastCheckinISO,
      moodAvailable: Boolean(wellbeing),
      wellbeing,
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
            score: latestActivityRow.score != null ? Number(latestActivityRow.score) : null,
            caloriesEstimated:
              latestActivityRow.calories_estimated != null
                ? Number(latestActivityRow.calories_estimated)
                : null,
            validationFlag: Boolean(latestActivityRow.validation_flag),
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
      muscleGroupCounts: muscleGroupRows.rows.map((item) => ({
        group: String(item.muscle_group),
        count: Number(item.count || 0),
      })),
      xp: Number(xpRow.rows[0]?.xp || row.xp || 0),
      wellbeingHistory14d,
    },
    technical: {
      highlights: technicalData.highlights.map((h) => ({
        exerciseName: h.exerciseName,
        kind: h.kind,
        count: h.count,
        lastNoteAt: h.lastNoteAt,
      })),
      recentNotes: technicalData.recentNotes.map((n) => ({
        id: n.id,
        exerciseName: n.exerciseName,
        exerciseKey: n.exerciseKey,
        kind: n.kind,
        note: n.note,
        recordedAt: n.recordedAt,
        loadKg: n.loadKg,
        reps: n.reps,
        sets: n.sets,
        severity: n.severity,
        personalId: n.personalId,
      })),
    },
  };
}

export async function listPersonalStudentActivities(
  personalId: number,
  studentId: number,
  academyId: number | null | undefined,
  limitRaw: number
) {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 10, 1), 50);
  const result = await pool.query(
    `SELECT
        id,
        activity_type,
        duration_seconds,
        distance_km,
        calories_estimated,
        avg_pace,
        intensity,
        score,
        validation_flag,
        created_at
     FROM activity_sessions
     WHERE user_id = $1
       AND ($2::integer IS NULL OR academy_id = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [studentId, academyId ?? null, limit]
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    activityType: String(r.activity_type),
    durationSeconds: Number(r.duration_seconds || 0),
    distanceKm: Number(r.distance_km || 0),
    caloriesEstimated: Number(r.calories_estimated || 0),
    avgPace: r.avg_pace != null ? Number(r.avg_pace) : null,
    intensity: r.intensity ? String(r.intensity) : null,
    score: r.score != null ? Number(r.score) : null,
    validationFlag: Boolean(r.validation_flag),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function getPersonalConsulting(personalId: number, academyId?: number | null) {
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
            AND ($2::integer IS NULL OR uwl30.academy_id = $2)
        ) AS workouts_30d,
        (
          SELECT uwll.completed_at
          FROM user_workout_logs uwll
          WHERE uwll.user_id = u.id
            AND ($2::integer IS NULL OR uwll.academy_id = $2)
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
        AND ($2::integer IS NULL OR psa.academy_id = $2)
      ORDER BY u.name ASC`,
    [personalId, academyId ?? null]
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
