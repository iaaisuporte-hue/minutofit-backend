/**
 * Personal Dashboard — tipos canônicos.
 *
 * **NÃO EDITE SEM ATUALIZAR O CONTRATO.**
 * Source-of-truth: `/shared/contract-personal-dashboard.md` no monorepo parent.
 *
 * Espelhos:
 * - `corefit-backend/src/shared/types/personal-dashboard.ts` (este arquivo, produtor)
 * - `corefit-app/src/shared/types/personal-dashboard.ts` (consumidor)
 *
 * Mudanças neste arquivo SEM atualizar o frontend e o markdown causam drift
 * silencioso. Workflow detalhado no contrato.
 */

export type PersonalDashboardPlan = 'basic' | 'silver' | 'gold' | 'black';
export type PersonalDashboardRisk = 'ok' | 'alerta' | 'critico';
export type PersonalDashboardGoal = 'emagrecimento' | 'hipertrofia' | 'condicionamento';
export type PersonalDashboardEngagementStatus =
  | 'evolving'
  | 'on_track'
  | 'attention'
  | 'fading'
  | 'at_risk';

export type PersonalDashboardAlertType =
  | 'attention_load'
  | 'cluster_low_sleep'
  | 'full_adherence'
  | 'silent_disappear'
  | 'overtraining'
  | 'metabolic_decline'
  | 'recovery_gap';

export type PersonalMetabolicBand = 'low' | 'moderate' | 'high' | 'unknown';
export type PersonalMetabolicTrend = 'up' | 'down' | 'stable' | 'unknown';

export type PersonalConsultingStatus = 'urgent' | 'warning' | 'on_track';
export type PersonalConsultingNextAction =
  | 'refresh_today'
  | 'prepare_update'
  | 'review_adherence'
  | 'keep_progression';

export type PersonalDashboardStudent = {
  id: string;
  name: string;
  plan: PersonalDashboardPlan;
  workouts7d: number;
  workouts30d: number;
  streakDays: number;
  lastWorkoutISO: string | null;
  adherencePct: number;
  adherenceScore: number;
  /** `null` = aluno em carência de onboarding: sem sinal para pontuar ainda. */
  engagementScore: number | null;
  /** `null` = aluno em carência de onboarding — NÃO tratar como risco máximo. */
  riskScore: number | null;
  risk: PersonalDashboardRisk;
  goal: PersonalDashboardGoal;
  notes: string | null;
  engagementStatus: PersonalDashboardEngagementStatus;
  lastCheckinISO: string | null;
  checkins7d: number;
  metabolismScore: number | null;
  metabolismBand: PersonalMetabolicBand;
  metabolismTrend: PersonalMetabolicTrend;
  metabolismDelta7d: number | null;
  latestSleptWell: boolean | null;
  lastTechnicalNoteAt: string | null;
  assignedAtISO: string | null;
};

export type PersonalDashboardAlert = {
  type: PersonalDashboardAlertType;
  title: string;
  description: string;
  studentId: string | null;
  studentName: string | null;
};
