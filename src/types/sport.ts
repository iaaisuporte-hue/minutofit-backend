export type SportKey = 'jiu_jitsu' | 'running' | 'crossfit' | 'cycling' | 'triathlon' | string;

export type SportLevel = 'beginner' | 'intermediate' | 'advanced' | 'competitor';

export type SportGoal =
  | 'performance'
  | 'competition'
  | 'strength'
  | 'endurance'
  | 'weight_loss'
  | 'recovery'
  | 'health';

export type CampPhase = 'base' | 'specific' | 'peak' | 'taper';

export type RiskLevel = 'low' | 'moderate' | 'high';

export interface SportFactor {
  id: string;
  label: string;
  delta: number;
  hint?: string;
}

export interface SportContext {
  factors: SportFactor[];
  modifier: number;
  recommendation: string;
  risk_level: RiskLevel;
}

export interface SportFactorWeights {
  joint_soreness: number;
  muscle_soreness: number;
  stress_level: number;
  motivation: number;
  camp_proximity: number;
  weekly_load_threshold: number;
  weekly_load_penalty: number;
}

export interface SportConfig {
  key: SportKey;
  labelPt: string;
  graduationOptions?: string[];
  categoryOptions?: string[];
  factorWeights: SportFactorWeights;
  microcopy: {
    readinessHigh: string;
    readinessModerate: string;
    readinessLow: string;
  };
}

export interface SportProfile {
  user_id: number;
  primary_sport: SportKey;
  sport_level: SportLevel;
  graduation_rank?: string | null;
  weekly_frequency: number;
  competes: boolean;
  primary_goal: SportGoal;
  current_weight_kg?: number | null;
  target_weight_kg?: number | null;
  coach_name?: string | null;
  nutri_name?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PreWorkoutCheckinData {
  sleep_quality: number;
  energy_level: number;
  muscle_soreness: number;
  joint_soreness: number;
  stress_level: number;
  hydration_ok: boolean;
  weight_kg?: number | null;
  motivation: number;
  perceived_readiness: number;
}

export interface ReadinessSnapshot {
  id: number;
  user_id: number;
  snapshot_date: string;
  metabolic_score: number;
  sport_modifier: number;
  final_score: number;
  sport_factors: SportFactor[];
  recommendation: string;
  risk_level: RiskLevel;
  has_checkin_today: boolean;
  created_at: string;
  updated_at: string;
}

export interface CompetitionCamp {
  id: number;
  user_id: number;
  event_name: string;
  event_date: string;
  category?: string | null;
  target_weight_kg?: number | null;
  weeks_planned?: number | null;
  status: 'planning' | 'active' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface CampWithDerived extends CompetitionCamp {
  days_remaining: number;
  camp_phase: CampPhase;
  current_weight_kg?: number | null;
}
