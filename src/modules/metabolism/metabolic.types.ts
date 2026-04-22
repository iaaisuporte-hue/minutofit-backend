export type MetabolicStatus = 'low' | 'moderate' | 'high';
export type MetabolicTrend = 'up' | 'down' | 'stable';

export interface MetabolicInput {
  ageYears: number | null;
  workoutsLast7Days: number;
  workoutsLast28Days: number;
  distinctMuscleGroupsLast14Days: number;
  currentStreakDays: number;
  daysSinceLastActivity: number | null;
  activityMinutesLast7Days: number;
  cardioSessionsLast14Days: number;
  fitnessGoal: string | null;
  experienceLevel: string | null;
}

export interface MetabolicFactor {
  id: string;
  label: string;
  delta: number;
  hint: string;
}

export interface Recommendation {
  id: string;
  title: string;
  reason: string;
  impact: string;
  cta?: { label: string; route: string };
  priority: number;
}

export interface MetabolicOutput {
  score: number;
  status: MetabolicStatus;
  trend: MetabolicTrend;
  factors: MetabolicFactor[];
  recommendations: Recommendation[];
}

export interface MetabolicHistoryPoint {
  date: string; // ISO YYYY-MM-DD
  score: number; // 0-100
}

export type MetabolicHistory = MetabolicHistoryPoint[];
