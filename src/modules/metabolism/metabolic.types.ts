/**
 * `onboarding` = conta nova, ainda sem nenhum sinal. Não é um estado ruim, é
 * ausência de leitura: sem ele, o aluno recém-cadastrado abria o app e recebia
 * 33/100 "Pedindo recuperação" por causa da penalidade de "sem treinos nos
 * últimos 7 dias" — que confunde "parou de treinar" com "acabou de chegar".
 */
export type MetabolicStatus = 'onboarding' | 'low' | 'moderate' | 'high';
export type MetabolicTrend = 'up' | 'down' | 'stable';

export interface MetabolicInput {
  ageYears: number | null;
  /** Dias desde o cadastro — usado para a carência de onboarding. */
  accountAgeDays: number | null;
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

export type MetabolicTrendDirection = 'up' | 'down' | 'stable';

export interface MetabolicTrendBlock {
  /** Average score delta vs previous window (approx. points). */
  delta: number;
  direction: MetabolicTrendDirection;
}

export interface MetabolicOutput {
  score: number;
  status: MetabolicStatus;
  trend: MetabolicTrend;
  factors: MetabolicFactor[];
  recommendations: Recommendation[];
  trend7d: MetabolicTrendBlock;
  trend30d: MetabolicTrendBlock;
  /**
   * Narrativa contextual gerada por IA — frase curta interpretando o estado
   * atual ("o que isso significa pra você hoje") + ação concreta sugerida.
   * Cache 4h por usuário. `null` quando OPENAI indisponível ou rate-limited.
   */
  interpretation?: { hint: string; action: string } | null;
}

export interface MetabolicHistoryPoint {
  date: string; // ISO YYYY-MM-DD
  score: number; // 0-100
}

export type MetabolicHistory = MetabolicHistoryPoint[];
