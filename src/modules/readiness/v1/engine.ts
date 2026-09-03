import {
  ALGORITHM_VERSION, BANDS, COLD_START, CONFIDENCE, PAIN_CAPS,
  RECOMMENDATION_ORDER, WEIGHTS,
  type ComponentKey, type Confidence, type ReadinessState, type Recommendation,
} from './config';
import {
  hrvScore, muscleRecovery, muscleRecoveryScore, restingHrScore,
  sleepScore, subjectiveScore, trainingLoadScore,
} from './components';
import type {
  ComponentResult, ReadinessFactor, ReadinessInput, ReadinessResult,
} from './types';

/**
 * S2CORE Readiness v1 — motor determinístico (SPEC Mobile P3).
 *
 * Contrato completo em `READINESS_ALGORITHM_V1.md`, escrito ANTES desta
 * implementação (§82.7). Este arquivo compõe os componentes; as regras de cada
 * um estão em `components.ts` e todos os números em `config.ts`.
 *
 * ## Três propriedades que o código precisa garantir, não só prometer
 *
 * 1. **Determinístico** (§61). Mesma entrada, mesma saída, sempre. Nenhuma
 *    chamada a `Date.now()` aqui dentro — o instante entra por parâmetro. Sem
 *    isso o teste de determinismo é impossível de escrever com honestidade.
 * 2. **Ausência não é zero** (§38). Componente sem dado sai da média e seu peso
 *    é redistribuído. Um zero silencioso é a forma mais eficiente de mentir num
 *    score ponderado.
 * 3. **Nunca finge precisão** (§11). Cold start e cobertura nula devolvem
 *    `score: null` — não um número baixo, que seria lido como "você está mal".
 */

/** Rótulos dos fatores mostrados ao usuário (§32). Sem fórmula. */
const FATOR_LABELS: Record<string, string> = {
  'sleep.below_baseline': 'Sono abaixo do seu padrão',
  'sleep.good': 'Você dormiu bem',
  'muscle.partial': 'Grupos musculares em recuperação',
  'muscle.recovered': 'Musculatura recuperada',
  'load.high': 'Carga acima do seu padrão recente',
  'load.light': 'Carga recente leve',
  'subjective.low': 'Energia ou humor abaixo do normal',
  'subjective.good': 'Você se sentiu bem no check-in',
  'pain.high': 'Você relatou dor',
  'pain.moderate': 'Você relatou desconforto',
  'hrv.below_baseline': 'Variabilidade cardíaca abaixo do seu padrão',
  'resting_hr.elevated': 'Frequência de repouso acima do seu padrão',
  'data.insufficient': 'Ainda temos poucos dados sobre você',
  'checkin.missing': 'Check-in de hoje não respondido',
};

/**
 * Manchete e microcopy por estado.
 *
 * Exportados e DERIVADOS na leitura, em vez de gravados no snapshot: são texto
 * de produto, e congelá-los no banco faria um snapshot de três meses atrás
 * exibir a copy antiga depois de uma revisão de redação. O que o snapshot
 * precisa preservar é o CÁLCULO (§36), não a frase.
 */
export const HEADLINES: Record<ReadinessState, string> = {
  ready_intense: 'Pronto para treino intenso',
  ready: 'Pronto para treinar',
  moderate: 'Dia de treino moderado',
  light: 'Pegue leve hoje',
  recover: 'Hoje é recuperação',
  calibrating: 'Estamos calibrando',
};

export const MICROCOPIES: Record<ReadinessState, string> = {
  ready_intense: 'Seus sinais estão bem. Pode seguir o treino planejado.',
  ready: 'Sinais dentro do esperado. Bom treino.',
  moderate: 'Considere reduzir um pouco o volume ou a intensidade.',
  light: 'Priorize técnica e exercícios leves hoje.',
  recover: 'Mobilidade, caminhada leve ou descanso favorecem sua próxima sessão.',
  calibrating: 'Faça o check-in do dia para começarmos a entender o seu padrão.',
};

/**
 * Mensagem de dor.
 *
 * **Nunca diagnostica** (§21, §50). Descreve o que a pessoa relatou e aponta o
 * profissional — não afirma lesão, causa nem gravidade.
 */
export function microcopyDeDor(area: string | null | undefined): string {
  const onde = area?.trim() ? ` no ${area.trim()}` : '';
  return `Você relatou desconforto${onde}. Evite exercícios que agravem a região e considere conversar com seu profissional.`;
}

function faixaDe(score: number): (typeof BANDS)[number] {
  return BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1];
}

/** Limita a recomendação a um teto, sem nunca elevá-la. */
function limitar(atual: Recommendation, teto: Recommendation): Recommendation {
  const i = RECOMMENDATION_ORDER.indexOf(atual);
  const j = RECOMMENDATION_ORDER.indexOf(teto);
  return i > j ? teto : atual;
}

/**
 * Calcula a prontidão do dia.
 *
 * @param agora Instante de referência. **Parâmetro, não `Date.now()`** — é o
 *   que torna o motor determinístico e testável (§61).
 */
export function computeReadiness(input: ReadinessInput, agora: Date): ReadinessResult {
  const hoje = input.date;
  const modo = input.baseline?.mode ?? 'cold_start';

  // ── 1. Componentes
  const estadosMusculares = muscleRecovery(input.muscleLoad, input.baseline, agora);

  const componentes: ComponentResult[] = [
    subjectiveScore(input.subjective, agora, hoje),
    muscleRecoveryScore(estadosMusculares, input.plannedMuscleGroups),
    trainingLoadScore(input.trainingLoad, input.baseline),
    sleepScore(input.sleep, input.baseline, agora),
    hrvScore(input.hrv, input.baseline, agora),
    restingHrScore(input.restingHr, input.baseline, agora),
  ];

  // ── 2. Cobertura (§8): soma dos PESOS presentes, não a contagem
  const presentes = componentes.filter((c) => c.value != null);
  const pesoPresente = presentes.reduce((s, c) => s + WEIGHTS[c.key as ComponentKey], 0);
  const cobertura = Number(pesoPresente.toFixed(4));

  // ── 3. Score, com redistribuição por ausência (§38)
  let score: number | null = null;
  if (modo !== 'cold_start' && presentes.length > 0 && pesoPresente > 0) {
    const soma = presentes.reduce((s, c) => s + (c.value as number) * WEIGHTS[c.key as ComponentKey], 0);
    score = Math.round(soma / pesoPresente);
  }

  // ── 4. Vetos por dor (§21). Teto, não peso.
  const dor = input.subjective?.soreness ?? null;
  let tetoRecomendacao: Recommendation | null = null;
  if (dor === 'high') {
    if (score != null) score = Math.min(score, PAIN_CAPS.high.maxScore);
    tetoRecomendacao = PAIN_CAPS.high.maxRecommendation;
  } else if (dor === 'moderate') {
    if (score != null) score = Math.min(score, PAIN_CAPS.moderate.maxScore);
    tetoRecomendacao = PAIN_CAPS.moderate.maxRecommendation;
  }

  // ── 5. Estado e recomendação
  let state: ReadinessState;
  let recommendation: Recommendation;
  if (score == null) {
    state = 'calibrating';
    recommendation = 'CHECKIN_FIRST';
  } else {
    const faixa = faixaDe(score);
    state = faixa.state;
    recommendation = faixa.recommendation;
    if (tetoRecomendacao) recommendation = limitar(recommendation, tetoRecomendacao);
  }

  // ── 6. Confiança (§9) — separada do score, deliberadamente
  const semCheckinHoje = componentes.find((c) => c.key === 'subjective')?.value == null;
  let confidence: Confidence;
  if (modo === 'cold_start' || cobertura < CONFIDENCE.minCoverageForMedium || semCheckinHoje) {
    confidence = 'low';
  } else if (cobertura < CONFIDENCE.minCoverageForHigh || modo === 'building') {
    confidence = 'medium';
  } else {
    confidence = 'high';
  }

  // ── 7. Fatores para o usuário (§32)
  const factors = montarFatores(componentes, estadosMusculares, input, modo, semCheckinHoje);

  // ── 8. Microcopy: dor tem precedência sobre o estado
  const microcopy =
    dor === 'high' || dor === 'moderate'
      ? microcopyDeDor(input.subjective?.painArea)
      : MICROCOPIES[state];

  return {
    score,
    state,
    recommendation,
    confidence,
    dataCompleteness: cobertura,
    mode: modo,
    components: componentes,
    factors,
    muscleRecovery: estadosMusculares,
    headline: HEADLINES[state],
    microcopy,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

function fator(id: string, direction: ReadinessFactor['direction'], severity: ReadinessFactor['severity']): ReadinessFactor {
  return { id, label: FATOR_LABELS[id] ?? id, direction, severity };
}

/**
 * Fatores em linguagem de produto.
 *
 * A §3 proíbe a caixa preta e a §32 proíbe mostrar a fórmula. O meio-termo é
 * este: por que o número é o que é, em frases que uma pessoa lê — a fórmula
 * fica no snapshot, para auditoria (§33).
 */
function montarFatores(
  componentes: ComponentResult[],
  musculos: ReturnType<typeof muscleRecovery>,
  input: ReadinessInput,
  modo: string,
  semCheckin: boolean,
): ReadinessFactor[] {
  const f: ReadinessFactor[] = [];
  const val = (k: ComponentKey) => componentes.find((c) => c.key === k)?.value ?? null;

  const dor = input.subjective?.soreness ?? null;
  if (dor === 'high') f.push(fator('pain.high', 'negative', 'block'));
  else if (dor === 'moderate') f.push(fator('pain.moderate', 'negative', 'caution'));

  const sono = val('sleep');
  if (sono != null && sono < 50) f.push(fator('sleep.below_baseline', 'negative', 'caution'));
  else if (sono != null && sono >= 80) f.push(fator('sleep.good', 'positive', 'info'));

  const parciais = musculos.filter((m) => m.state !== 'recovered');
  if (parciais.length > 0) {
    f.push({
      id: 'muscle.partial',
      label: `${parciais.slice(0, 3).map((m) => m.label).join(', ')} em recuperação`,
      direction: 'negative',
      severity: 'caution',
    });
  } else if (musculos.length > 0) {
    f.push(fator('muscle.recovered', 'positive', 'info'));
  }

  const carga = val('trainingLoad');
  if (carga != null && carga <= 50) f.push(fator('load.high', 'negative', 'caution'));
  else if (carga != null && carga >= 85) f.push(fator('load.light', 'positive', 'info'));

  const subj = val('subjective');
  if (subj != null && subj < 55) f.push(fator('subjective.low', 'negative', 'caution'));
  else if (subj != null && subj >= 80) f.push(fator('subjective.good', 'positive', 'info'));

  const hrv = val('hrv');
  if (hrv != null && hrv <= 55) f.push(fator('hrv.below_baseline', 'negative', 'caution'));
  const rhr = val('restingHr');
  if (rhr != null && rhr <= 45) f.push(fator('resting_hr.elevated', 'negative', 'caution'));

  if (modo === 'cold_start') f.push(fator('data.insufficient', 'neutral', 'info'));
  if (semCheckin && modo !== 'cold_start') f.push(fator('checkin.missing', 'neutral', 'info'));

  return f;
}
