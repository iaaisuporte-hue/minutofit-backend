/** Tipos compartilhados do módulo Performance (Spec 033). */

/** Método usado para estimar a carga interna da sessão. */
export type EffortLoadMethod = 'srpe_duration' | 'srpe_sets';

/** Métricas derivadas de uma sessão — 1:1 com `workout_session_metrics`. */
export interface SessionMetrics {
  setsDone: number;
  repsTotal: number;
  /** Carga externa (Σ reps × kg). NULL quando nenhuma série teve carga. */
  tonnageKg: number | null;
  /** Duração medida. NULL quando não houve medição real. */
  durationMin: number | null;
  /** RPE da sessão; fallback = média dos RPEs por série. */
  srpe: number | null;
  /** Carga interna. NULL quando não há RPE algum — não se inventa dado. */
  effortLoad: number | null;
  effortLoadMethod: EffortLoadMethod | null;
}

/** Série já sanitizada, como o `workoutSessionService` a grava. */
export interface MetricsSetInput {
  repsDone: number | null;
  loadDoneKg: number | null;
  rpe: number | null;
  status: 'done' | 'skipped';
}

/** Uma fonte que comprova atividade num dia. */
export type ActiveDaySource = 'session' | 'log' | 'personal';

/** Dia do calendário de treino, na perspectiva do aluno. */
export interface ActiveDay {
  /** 'YYYY-MM-DD' no fuso do aluno. */
  date: string;
  active: boolean;
  sources: ActiveDaySource[];
  setsDone: number | null;
  tonnageKg: number | null;
}

/** Bloco de consistência do overview. */
export interface ConsistencySummary {
  /**
   * Percentual de consistência de FREQUÊNCIA. `null` = não há denominador
   * (aluno sem ficha ativa) — nunca 0, que significaria "faltou a tudo".
   */
  pct: number | null;
  activeDays28: number;
  /** Treinos/semana que a ficha ativa prescreve. `null` = sem ficha. */
  targetPerWeek: number | null;
  /**
   * De onde saiu o alvo: `plan` (ficha do personal) ou `goal` (meta que o
   * próprio aluno declarou). A tela precisa disso para não dizer "sua ficha
   * prescreve" a quem não tem ficha nenhuma.
   */
  targetSource: 'plan' | 'goal' | null;
}
