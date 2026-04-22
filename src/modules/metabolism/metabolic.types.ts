export type ActivityLevel = 'low' | 'medium' | 'high';
export type MetabolicStatus = 'low' | 'moderate' | 'high';
export type MetabolicTrend = 'up' | 'down' | 'stable';

export interface MetabolicInput {
  age: number;
  workoutsPerWeek: number;
  activityLevel: ActivityLevel;
}

export interface MetabolicOutput {
  score: number;
  status: MetabolicStatus;
  trend: MetabolicTrend;
  recommendations: string[];
}

export interface MetabolicHistoryPoint {
  date: string; // ISO YYYY-MM-DD
  score: number; // 0-100
}

export type MetabolicHistory = MetabolicHistoryPoint[];
