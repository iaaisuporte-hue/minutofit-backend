import type {
  BaselineMode, ComponentKey, Confidence, ReadinessState, Recommendation,
} from './config';

/**
 * Entrada canônica do motor (SPEC Mobile P3 §7).
 *
 * **Todo campo é opcional.** Não é elegância defensiva: metade das entradas que
 * a SPEC lista não tem fonte hoje (HRV e FC de repouso dependem da integração
 * de saúde que a P2 deixou pendente). Um usuário que abriu o app agora e nunca
 * fez nada produz um resultado VÁLIDO — score null, estado `calibrating`.
 */
export interface ReadinessInput {
  userId: number;
  /** Dia do aluno (fuso do app, não UTC). */
  date: string;
  subjective: SubjectiveInput | null;
  sleep: SleepInput | null;
  hrv: MetricPoint | null;
  restingHr: MetricPoint | null;
  trainingLoad: TrainingLoadInput | null;
  /** Vazio é válido: ninguém treinou. */
  muscleLoad: MuscleLoadEntry[];
  baseline: Baseline | null;
  metabolicScore: number | null;
  /** Grupos que o treino de HOJE vai usar, quando há ficha (§29). */
  plannedMuscleGroups?: string[];
}

/**
 * Um dado medido, com procedência e instante.
 *
 * Os três campos existem por exigência da SPEC: `measuredAt` para a janela de
 * validade (§40) e `source` para a precedência entre fontes (§41). Um número
 * solto não permite nem uma coisa nem outra.
 */
export interface MetricPoint {
  value: number;
  measuredAt: string;
  source: string;
}

export interface SubjectiveInput {
  /** Do check-in do dia. */
  energy: 'very_low' | 'low' | 'normal' | 'high' | 'very_high' | null;
  sleepQuality: 'poor' | 'fair' | 'good' | 'excellent' | null;
  soreness: 'none' | 'light' | 'moderate' | 'high' | null;
  stress: 'low' | 'moderate' | 'high' | null;
  /** Região relatada com desconforto, quando houver. */
  painArea?: string | null;
  measuredAt: string;
}

export interface SleepInput {
  /** Único sinal com fonte hoje: o booleano do check-in. */
  sleptWell: boolean | null;
  /** Sem fonte hoje; o componente já sabe usar quando existir. */
  durationHours?: number | null;
  measuredAt: string;
}

export interface TrainingLoadInput {
  /** Carga acumulada nos últimos 7 dias, em unidades internas. */
  last7dLoad: number;
  /** Dias consecutivos com treino até hoje. */
  consecutiveDays: number;
}

/** Carga registrada em um grupo muscular, em um instante. */
export interface MuscleLoadEntry {
  group: string;
  /** Carga bruta atribuída ao grupo (já com o coeficiente de sinergia). */
  load: number;
  occurredAt: string;
  sessionRpe: number | null;
  discomfort: boolean;
}

export interface Baseline {
  mode: BaselineMode;
  daysOfHistory: number;
  /** Proporção de noites boas (0..1), ou null sem amostra suficiente. */
  sleepGoodRatio: number | null;
  hrvMedian: number | null;
  restingHrMedian: number | null;
  /** Carga média de 7 dias no período do baseline. */
  weeklyLoadAvg: number | null;
  /** Pico de carga por grupo muscular em 28 dias — normaliza a recuperação. */
  muscleLoadPeak: Record<string, number>;
}

/** Resultado de um componente. `value` null = ausente (§38). */
export interface ComponentResult {
  key: ComponentKey;
  value: number | null;
  /** Por que está ausente — vai para a auditoria (§33). */
  absentReason?: 'no_data' | 'stale' | 'implausible' | 'no_baseline';
  /** Detalhes por componente, para explicabilidade técnica. */
  detail?: Record<string, unknown>;
}

/** Fator exibido ao usuário (§32). */
export interface ReadinessFactor {
  id: string;
  label: string;
  direction: 'positive' | 'negative' | 'neutral';
  severity: 'info' | 'caution' | 'block';
}

export interface MuscleGroupState {
  group: string;
  label: string;
  recovery: number;
  state: 'recovered' | 'partial' | 'recovering';
}

export interface ReadinessResult {
  /** null em cold start ou sem nenhum componente (§11, §38). */
  score: number | null;
  state: ReadinessState;
  recommendation: Recommendation;
  confidence: Confidence;
  /** Soma dos pesos presentes (0..1) — §8. */
  dataCompleteness: number;
  mode: BaselineMode;
  components: ComponentResult[];
  factors: ReadinessFactor[];
  muscleRecovery: MuscleGroupState[];
  headline: string;
  microcopy: string;
  algorithmVersion: string;
}
