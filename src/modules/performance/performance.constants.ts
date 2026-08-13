/**
 * Constantes versionadas do módulo Performance (Spec 033).
 *
 * Fonte da verdade das fórmulas. Nenhum engine hardcoda peso ou limiar: tudo
 * entra por aqui, para que uma mudança de fórmula seja um diff pequeno e
 * auditável, e para que `formula_version` signifique alguma coisa.
 *
 * Ao mudar QUALQUER valor deste arquivo: incremente `FORMULA_VERSION` e
 * registre a entrada correspondente em `docs/performance-formulas.md`.
 */

/** Versão corrente das fórmulas. Gravada em toda linha derivada. */
export const FORMULA_VERSION = 1;

/**
 * Duração de sessão aceita como medição real, em minutos.
 *
 * Hoje o cliente registra a sessão inteira no final (started_at = ended_at),
 * então a duração real é desconhecida na prática e vira NULL. Estes limites
 * valem para quando existir um "iniciar treino" de verdade: abaixo do piso é
 * ruído de registro, acima do teto é sessão esquecida aberta.
 */
export const DURATION_MIN_MINUTES = 5;
export const DURATION_MAX_MINUTES = 240;

/** Abaixo disto não houve medição de duração — não é sessão curta, é ausência de dado. */
export const DURATION_MEASURED_THRESHOLD_SECONDS = 60;

/**
 * Minutos-equivalentes por série no fallback de carga interna.
 *
 * Quando não há duração medida, aproximamos o tempo sob esforço por série
 * (execução + descanso). Quatro minutos é a ordem de grandeza de uma série de
 * musculação com descanso típico — é proxy declarado, não medição, e por isso
 * o método fica gravado em `effort_load_method` para dar para auditar depois
 * quanto do dado é estimado.
 */
export const EFFORT_MINUTES_PER_SET = 4;

/** Faixa de repetições em que a estimativa de 1RM ainda é defensável. */
export const E1RM_MIN_REPS = 1;
export const E1RM_MAX_REPS = 12;

/** Janela padrão da consistência, em dias. 28 = exatamente 4 semanas. */
export const CONSISTENCY_WINDOW_DAYS = 28;

/**
 * Piso do denominador proporcional, em dias.
 *
 * Mesma razão do `resolveMonthlyTarget` (QA 02/ago/2026, P1-2): medir 28 dias de
 * quem tem 2 dias de vínculo é aritmeticamente impossível de acertar. Sem o
 * piso, um único treino no primeiro dia marcaria muito acima de 100%.
 */
export const CONSISTENCY_MIN_WINDOW_DAYS = 7;

// ── Progress Score (Onda P3) ───────────────────────────────────────────────

/**
 * Pesos e limiares do Progress Score, v1 — os valores da Spec 033.
 *
 * Objeto congelado de propósito: os engines recebem isto por parâmetro e nunca
 * hardcodam número. Mexer aqui é mexer na fórmula, e exige bump de
 * `FORMULA_VERSION` + entrada no changelog de `docs/performance-formulas.md`.
 */
export const SCORE_WEIGHTS_V1 = Object.freeze({
  /** Ponto de partida. Um aluno sem sinal algum não vale 0 nem 100. */
  BASE: 50,

  /** Fração de exercícios-chave em melhora → 0..+18, linear. */
  PROGRESSION_MAX: 18,
  /** Queda em ≥40% dos exercícios-chave. */
  REGRESSION_THRESHOLD: 0.4,
  REGRESSION_DELTA: -12,

  /** Consistência de frequência. */
  CONSISTENCY_HIGH_PCT: 85,
  CONSISTENCY_HIGH_DELTA: 14,
  CONSISTENCY_LOW_PCT: 40,
  CONSISTENCY_LOW_DELTA: -10,

  /**
   * Volume: variação de tonelagem entre janelas, saturando em ±30%.
   * Crescer 30% já vale o máximo — além disso não é mais progresso, é risco,
   * e o produto não recompensa acelerar sem limite.
   */
  VOLUME_BAND: 0.3,
  VOLUME_MAX: 8,

  /** Um recorde real (não estreia) na janela. */
  PR_RECENT_DELTA: 6,

  /** Meta atingida na janela — Onda P4; hoje soma 0 por ausência de metas. */
  GOAL_ACHIEVED_DELTA: 6,

  /** Sumiço prolongado. O único fator que sozinho derruba o score. */
  INACTIVITY_DAYS: 14,
  INACTIVITY_DELTA: -20,

  MIN: 0,
  MAX: 100,
} as const);

/** Janela de comparação do score: 28 dias contra os 28 anteriores. */
export const SCORE_WINDOW_DAYS = 28;

/**
 * Carência do Progress Score. Abaixo disto o score é `null` ("Calibrando") —
 * um número preciso sobre três treinos seria precisão falsa.
 */
export const SCORE_MIN_ACCOUNT_AGE_DAYS = 28;
export const SCORE_MIN_SESSIONS = 6;
export const SCORE_SESSION_LOOKBACK_DAYS = 60;

/** Exercício só entra na progressão com pelo menos isto em CADA janela. */
export const PROGRESSION_MIN_POINTS_PER_WINDOW = 2;

// ── Ritmo de carga ─────────────────────────────────────────────────────────

/** Sessões com `effort_load` exigidas em 28d para o ritmo ter significado. */
export const LOAD_RATIO_MIN_SESSIONS = 8;

/** Faixas qualitativas do ritmo. Nunca exibimos o número cru. */
export const LOAD_RATIO_BANDS = Object.freeze({
  BELOW: 0.8,
  ABOVE: 1.3,
  SPIKE: 1.6,
} as const);
