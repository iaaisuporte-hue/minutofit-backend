import type { WorkoutPlanItemPayload } from '../../../services/personalWorkoutPlanService';
import type { ReadinessLens } from '../../readiness/readiness.engine';

export type WorkoutSourceKind =
  | 'personal_prescription'
  | 'academy_published'
  | 'metacore_suggested';

export interface AdaptableWorkoutDay {
  sourceKind: WorkoutSourceKind;
  sourceRef: { planId?: number; dayIndex: number };
  responsibleParty:
    | { kind: 'personal'; personalId: number }
    | { kind: 'academy'; academyId: number }
    | { kind: 'system' };
  academyId: number | null;
  name: string;
  focus: string | null;
  items: WorkoutPlanItemPayload[];
}

export interface AdaptationPolicy {
  personalId: number;
  studentId: number;
  academyId: number | null;
  version: number;
  masterEnabled: boolean;
  allowVolumeReduction: boolean;
  allowRestIncrease: boolean;
  allowIntensityReduction: boolean;
  allowActiveRecoverySubstitution: boolean;
  allowMobilitySuggestion: boolean;
  maxSetReductionPct: number;
  maxRestIncreasePct: number;
  minIntensityPct: number;
}

export interface AdaptationChange {
  exerciseId: string;
  field: 'sets' | 'reps' | 'rest' | 'rpe' | 'technique';
  original: string;
  adapted: string;
  reason: string;
}

export interface RecoverySuggestion {
  kind: 'active_recovery' | 'mobility';
  microcopy: string;
}

export interface AdaptationResult {
  adaptedItems: WorkoutPlanItemPayload[];
  changes: AdaptationChange[];
  recoverySuggestion: RecoverySuggestion | null;
  appliedLevel: string;
  policyVersion: number;
}

export interface AdaptiveContext {
  readiness: ReadinessLens;
  policy: AdaptationPolicy;
}

export interface WorkoutSourceProvider {
  loadTodayDay(userId: number, planId?: number, dayIndex?: number): Promise<AdaptableWorkoutDay | null>;
  resolvePolicy(day: AdaptableWorkoutDay, userId: number): Promise<AdaptationPolicy>;
}

export const DEFAULT_POLICY: Omit<AdaptationPolicy, 'personalId' | 'studentId' | 'academyId'> = {
  version: 0,
  masterEnabled: false,
  allowVolumeReduction: false,
  allowRestIncrease: false,
  allowIntensityReduction: false,
  allowActiveRecoverySubstitution: false,
  allowMobilitySuggestion: false,
  maxSetReductionPct: 25,
  maxRestIncreasePct: 30,
  minIntensityPct: 70,
};
