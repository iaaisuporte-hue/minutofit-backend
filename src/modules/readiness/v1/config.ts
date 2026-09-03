/**
 * Configuração central do S2CORE Readiness v1 (SPEC Mobile P3 §4 e §37).
 *
 * Tudo que é número de regra mora AQUI. A §4 e a §37 são explícitas sobre não
 * espalhar constantes pela aplicação, e o motivo é auditoria: quando o
 * algoritmo mudar, a diferença tem que ser legível num diff de um arquivo, não
 * garimpada em seis.
 *
 * Mudar qualquer valor deste arquivo é mudar o algoritmo — e exige subir
 * `ALGORITHM_VERSION`, senão dois snapshots com a mesma versão passam a
 * significar coisas diferentes (§34).
 */

/** Versão persistida em cada snapshot. Subir ao mexer em qualquer regra. */
export const ALGORITHM_VERSION = '1.0';

/**
 * Pesos dos componentes (§37).
 *
 * A percepção pesa mais que tudo, e não por falta de ambição técnica: hoje ela
 * é o único sinal com fonte confiável e DIÁRIA. HRV e FC de repouso somam 0.12
 * e não têm fonte nenhuma — se pesassem mais, a redistribuição por ausência
 * (§38) dominaria o cálculo todo dia, o que é o oposto de informar.
 */
export const WEIGHTS = Object.freeze({
  subjective: 0.28,
  muscleRecovery: 0.24,
  trainingLoad: 0.20,
  sleep: 0.16,
  hrv: 0.08,
  restingHr: 0.04,
});

export type ComponentKey = keyof typeof WEIGHTS;

/** Faixas de score → estado (§4). Configuráveis, como a SPEC exige. */
export const BANDS = Object.freeze([
  { min: 80, state: 'ready_intense', recommendation: 'INTENSE' },
  { min: 65, state: 'ready', recommendation: 'NORMAL' },
  { min: 50, state: 'moderate', recommendation: 'MODERATE' },
  { min: 35, state: 'light', recommendation: 'LIGHT' },
  { min: 0, state: 'recover', recommendation: 'RECOVERY' },
] as const);

export type ReadinessState =
  | 'ready_intense' | 'ready' | 'moderate' | 'light' | 'recover' | 'calibrating';

export type Recommendation =
  | 'INTENSE' | 'NORMAL' | 'MODERATE' | 'LIGHT' | 'RECOVERY' | 'CHECKIN_FIRST';

export type Confidence = 'high' | 'medium' | 'low';

/** Modo de maturidade do baseline (§11). */
export type BaselineMode = 'cold_start' | 'building' | 'established';

export const COLD_START = Object.freeze({
  /** Abaixo disto o score é null — não se finge precisão no primeiro dia. */
  coldStartMaxDays: 6,
  /** Até aqui a confiança tem teto em `medium`. */
  buildingMaxDays: 20,
});

/** Limiares de confiança (§9). */
export const CONFIDENCE = Object.freeze({
  minCoverageForMedium: 0.45,
  minCoverageForHigh: 0.75,
});

/** Amostras mínimas por métrica de baseline (§10, §63). */
export const BASELINE_MIN_SAMPLES = Object.freeze({
  sleep: 5,
  hrv: 7,
  restingHr: 7,
  trainingLoadWeeks: 2,
});

/** Janela do baseline, em dias. */
export const BASELINE_WINDOW_DAYS = 28;

/** Faixas fisiológicas plausíveis (§39). Fora disto o valor é IGNORADO. */
export const PLAUSIBLE = Object.freeze({
  hrvMs: { min: 5, max: 300 },
  restingHrBpm: { min: 30, max: 120 },
  sleepHours: { min: 0, max: 16 },
  /** Carga de sessão acima de N× o pico histórico é ruído de digitação. */
  sessionLoadPeakMultiple: 3,
});

/** Janelas de validade do dado (§40). Fora delas o dado é AUSENTE. */
export const FRESHNESS_HOURS = Object.freeze({
  hrv: 36,
  restingHr: 36,
  sleep: 24,
});

/** Precedência entre fontes do mesmo dado (§41). Menor índice vence. */
export const SOURCE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  s2core: 0,
  apple_health: 1,
  health_connect: 1,
  garmin: 2,
  strava: 2,
  manual: 3,
});

/** Vetos por dor (§21). Teto de score e de recomendação. */
export const PAIN_CAPS = Object.freeze({
  high: { maxScore: 40, maxRecommendation: 'LIGHT' as Recommendation },
  moderate: { maxScore: 60, maxRecommendation: 'MODERATE' as Recommendation },
});

/** Ordem de intensidade — usada para aplicar teto de recomendação. */
export const RECOMMENDATION_ORDER: readonly Recommendation[] = Object.freeze([
  'RECOVERY', 'LIGHT', 'MODERATE', 'NORMAL', 'INTENSE',
]);

/**
 * Recuperação muscular (§16, §18).
 *
 * As meias-vidas são aproximação declarada. A §18 é explícita: "não criar falsa
 * precisão científica". 24/36/48 h é a ordem de grandeza aceita para
 * recuperação de grupo muscular por intensidade, não uma constante medida.
 */
export const MUSCLE_RECOVERY = Object.freeze({
  halfLifeHours: { light: 24, moderate: 36, heavy: 48 },
  /** Frações do pico de 28 dias que definem leve/moderado/pesado. */
  loadBands: { lightBelow: 0.3, heavyAbove: 0.7 },
  /** RPE >= 9 estende a meia-vida. */
  highRpe: 9,
  highRpeMultiplier: 1.15,
  /** Desconforto no grupo estende e impõe teto de recuperação. */
  discomfortMultiplier: 1.25,
  discomfortRecoveryCeiling: 60,
  /** Janela em que a carga muscular ainda conta (§40). */
  windowHours: 96,
  states: { recoveredAtOrAbove: 85, partialAtOrAbove: 60 },
});

/**
 * Mapa de `exercises.body_part` → grupos, com irradiação para sinergistas.
 *
 * Os coeficientes são APROXIMAÇÃO DECLARADA. O supino carrega o tríceps; 0.4 é
 * a ordem de grandeza, não um número da literatura. Mantido aqui, e não no
 * código do componente, para que a revisão de quem entende de treino aconteça
 * num lugar só.
 */
export const MUSCLE_MAP: Readonly<Record<string, Readonly<Record<string, number>>>> =
  Object.freeze({
    'peito': { chest: 1.0, triceps: 0.4, shoulders: 0.3 },
    'costas': { back: 1.0, biceps: 0.4 },
    'perna': { quads: 1.0, glutes: 0.6, hamstrings: 0.5 },
    'glúteo': { glutes: 1.0, hamstrings: 0.5, quads: 0.3 },
    'ombro': { shoulders: 1.0, triceps: 0.2 },
    'bíceps': { biceps: 1.0 },
    'tríceps': { triceps: 1.0 },
    'panturrilha': { calves: 1.0 },
    'abdômen': { core: 1.0 },
    'antebraço': { forearms: 1.0 },
    'funcional': { core: 0.6, quads: 0.4, shoulders: 0.3 },
    'cardio': { quads: 0.3, calves: 0.3 },
    'mobilidade': {},
    'aquecimento': {},
  });

/**
 * Todos os grupos que o modelo conhece.
 *
 * Existe porque a média de recuperação precisa considerar o CORPO INTEIRO, não
 * só os grupos que receberam carga: quem treinou perna tem quadríceps a 0% e
 * peito, costas e ombros intactos. Somar só os carregados fazia a média global
 * dar 0 e o Readiness inteiro colapsar para "recuperação" depois de um treino
 * de perna normal (achado do QA P3).
 */
export const ALL_MUSCLE_GROUPS: readonly string[] = Object.freeze([
  'chest', 'back', 'quads', 'hamstrings', 'glutes', 'shoulders',
  'biceps', 'triceps', 'calves', 'core', 'forearms',
]);

/** Rótulo em português de cada grupo, para a explicação ao usuário. */
export const MUSCLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  chest: 'Peito', back: 'Costas', quads: 'Quadríceps', hamstrings: 'Posteriores',
  glutes: 'Glúteos', shoulders: 'Ombros', biceps: 'Bíceps', triceps: 'Tríceps',
  calves: 'Panturrilhas', core: 'Core', forearms: 'Antebraços',
});

/** Carga de treino (§15). Simples e auditável — sem ACWR. */
export const TRAINING_LOAD = Object.freeze({
  ratioBands: [
    { max: 0.7, score: 90 },
    { max: 1.1, score: 85 },
    { max: 1.4, score: 70 },
    { max: 1.7, score: 50 },
    { max: Infinity, score: 32 },
  ],
  consecutiveDaysFree: 3,
  consecutivePenaltyPerDay: 8,
  consecutivePenaltyMax: 16,
  /** MET por tipo de atividade, para converter minutos em carga comparável. */
  activityMet: { walk: 3.8, run: 10.0, cycling: 6.8, cardio: 7.0 } as Record<string, number>,
});
