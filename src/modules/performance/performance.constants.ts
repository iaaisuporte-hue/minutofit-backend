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
