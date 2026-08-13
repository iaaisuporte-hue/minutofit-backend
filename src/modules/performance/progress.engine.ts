/**
 * Progress Score — função pura (Spec 033, Onda P3).
 *
 * ## O que ele é, e o que ele não é
 *
 * Uma leitura de "o aluno está evoluindo em relação a ele mesmo", comparando os
 * últimos 28 dias com os 28 anteriores. Não compara com ninguém: dois alunos
 * com o mesmo score não treinam parecido, e isso é intencional — carga absoluta
 * favoreceria quem já é forte, não quem está progredindo.
 *
 * O produto proíbe número-resumo sem explicação (`docs/produto/visao_maas.md`).
 * Por isso a saída nunca é só um inteiro: cada ponto acima ou abaixo da base
 * vem de um FATOR nomeado, e a tabela de fatores é o que a tela mostra. O banco
 * reforça a regra com um CHECK que recusa score gravado sem fator.
 *
 * ## Por que somar deltas a partir de 50
 *
 * A alternativa — média ponderada de componentes normalizados — obriga a
 * inventar um valor quando um componente falta, e falta é o caso comum (treino
 * de peso corporal não tem tonelagem, aluno sem ficha não tem consistência).
 * Somando deltas, componente ausente contribui ZERO e o score fica onde estava:
 * a ausência de informação não vira informação. É a propriedade que sustenta
 * "resistente a dados incompletos".
 *
 * ## Estabilidade
 *
 * Nenhum fator isolado domina: o maior positivo é +18 e o maior negativo é −20,
 * dentro de uma faixa de 100. Um PR sozinho move +6 — perceptível, não
 * explosivo. Um treino ruim não move nada sozinho, porque todos os fatores
 * medem JANELA, não sessão.
 */
import {
  PROGRESSION_MIN_POINTS_PER_WINDOW,
  SCORE_MIN_ACCOUNT_AGE_DAYS,
  SCORE_MIN_SESSIONS,
  SCORE_WEIGHTS_V1,
} from './performance.constants';

export type ScoreStatus = 'onboarding' | 'ok';

/** Um fator nomeado que empurrou o score para cima ou para baixo. */
export interface ScoreFactor {
  id: string;
  label: string;
  /** Pontos somados à base. Sempre inteiro. */
  delta: number;
}

/**
 * Insumos do score. Todos os campos aceitam ausência, e ausência NUNCA é
 * traduzida para zero — é traduzida para "este fator não participa".
 */
export interface ScoreInput {
  /** Idade da conta em dias. `null` = desconhecida (trata como insuficiente). */
  accountAgeDays: number | null;
  /** Sessões executadas com séries nos últimos 60 dias. */
  sessionsInLookback: number;
  /** Dias desde a última sessão. `null` = nunca treinou. */
  daysSinceLastSession: number | null;

  /**
   * Exercícios com pelo menos 2 pontos em CADA janela — os únicos comparáveis.
   * `improved` = melhorou o melhor e1RM (ou a carga, quando não há e1RM).
   */
  keyExercises: { total: number; improved: number; regressed: number };

  /** Consistência de frequência (0–100). `null` = sem ficha, sem denominador. */
  consistencyPct: number | null;

  /** Tonelagem somada em cada janela. `null` = nenhuma série com carga. */
  tonnageCurrent: number | null;
  tonnagePrevious: number | null;

  /** Recordes reais (não estreias) na janela atual. */
  prCount: number;

  /** Metas atingidas na janela. Onda P4 — hoje sempre 0. */
  goalsAchieved: number;
}

export interface ScoreResult {
  /** `null` em onboarding: sem histórico não se afirma número. */
  value: number | null;
  status: ScoreStatus;
  factors: ScoreFactor[];
}

/** Número utilizável? Barra NaN, Infinity e não-números de uma vez. */
function usable(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Ainda não há história suficiente para afirmar um número.
 *
 * Duas condições, ambas da spec: conta com menos de 28 dias OU menos de 6
 * sessões nos últimos 60. A primeira evita julgar quem acabou de chegar; a
 * segunda evita julgar quem tem conta antiga e treinou três vezes.
 */
export function isOnboardingScore(input: ScoreInput): boolean {
  const idadeDesconhecida = !usable(input.accountAgeDays);
  return (
    idadeDesconhecida ||
    (input.accountAgeDays as number) < SCORE_MIN_ACCOUNT_AGE_DAYS ||
    input.sessionsInLookback < SCORE_MIN_SESSIONS
  );
}

/**
 * Calcula o score e o breakdown.
 *
 * Determinístico: mesma entrada, mesma saída, sem relógio nem aleatoriedade
 * aqui dentro — quem mede o tempo é o repositório, que entrega janelas prontas.
 */
export function computeProgressScore(
  input: ScoreInput,
  weights = SCORE_WEIGHTS_V1,
): ScoreResult {
  if (isOnboardingScore(input)) {
    return {
      value: null,
      status: 'onboarding',
      factors: [
        {
          id: 'onboarding.calibrating',
          label: 'Calibrando sua linha de evolução',
          delta: 0,
        },
      ],
    };
  }

  const factors: ScoreFactor[] = [];

  // ── Progressão de carga ──────────────────────────────────────────────────
  // Só exercícios comparáveis entram. Quem treinou um exercício novo esta
  // semana não tem contra o que comparar, e incluí-lo como "não melhorou"
  // puniria justamente quem variou o treino.
  const { total, improved, regressed } = input.keyExercises;
  if (total > 0) {
    const fracaoMelhora = clamp(improved / total, 0, 1);
    const delta = Math.round(fracaoMelhora * weights.PROGRESSION_MAX);
    if (delta > 0) {
      factors.push({
        id: 'progression.load',
        label: `Carga subiu em ${improved} de ${total} exercícios`,
        delta,
      });
    }

    const fracaoQueda = clamp(regressed / total, 0, 1);
    if (fracaoQueda >= weights.REGRESSION_THRESHOLD) {
      factors.push({
        id: 'progression.regression',
        label: `Carga caiu em ${regressed} de ${total} exercícios`,
        delta: weights.REGRESSION_DELTA,
      });
    }
  }

  // ── Consistência ─────────────────────────────────────────────────────────
  // `null` = aluno sem ficha ativa. Sem prescrição não há o que cobrar, então
  // o fator não participa — nem para bem, nem para mal.
  if (usable(input.consistencyPct)) {
    if (input.consistencyPct >= weights.CONSISTENCY_HIGH_PCT) {
      factors.push({
        id: 'consistency.high',
        label: `Presença de ${Math.round(input.consistencyPct)}% do previsto`,
        delta: weights.CONSISTENCY_HIGH_DELTA,
      });
    } else if (input.consistencyPct < weights.CONSISTENCY_LOW_PCT) {
      factors.push({
        id: 'consistency.low',
        label: `Presença de ${Math.round(input.consistencyPct)}% do previsto`,
        delta: weights.CONSISTENCY_LOW_DELTA,
      });
    }
  }

  // ── Volume ───────────────────────────────────────────────────────────────
  // Exige tonelagem nas DUAS janelas. Treino de peso corporal tem tonelagem
  // nula por natureza (não zero) — comparar contra ausência produziria uma
  // queda de 100% que não aconteceu.
  if (
    usable(input.tonnageCurrent) &&
    usable(input.tonnagePrevious) &&
    input.tonnagePrevious > 0
  ) {
    const variacao = (input.tonnageCurrent - input.tonnagePrevious) / input.tonnagePrevious;
    if (Number.isFinite(variacao)) {
      const normalizada = clamp(variacao / weights.VOLUME_BAND, -1, 1);
      const delta = Math.round(normalizada * weights.VOLUME_MAX);
      if (delta !== 0) {
        factors.push({
          id: 'volume.trend',
          label:
            delta > 0
              ? `Volume ${Math.round(variacao * 100)}% acima do período anterior`
              : `Volume ${Math.round(Math.abs(variacao) * 100)}% abaixo do período anterior`,
          delta,
        });
      }
    }
  }

  // ── Recordes ─────────────────────────────────────────────────────────────
  // Peso fixo, não proporcional à quantidade: dez recordes num dia de teste de
  // força não valem dez vezes um. Bater recorde conta uma vez.
  if (input.prCount > 0) {
    factors.push({
      id: 'pr.recent',
      label: input.prCount === 1 ? 'Você bateu um recorde' : `Você bateu ${input.prCount} recordes`,
      delta: weights.PR_RECENT_DELTA,
    });
  }

  // ── Metas ────────────────────────────────────────────────────────────────
  // Onda P4. Sem metas cadastradas o contador é 0 e o fator não aparece —
  // o score não muda quando a P4 entrar para quem não usar metas.
  if (input.goalsAchieved > 0) {
    factors.push({
      id: 'goal.achieved',
      label: input.goalsAchieved === 1 ? 'Meta atingida' : `${input.goalsAchieved} metas atingidas`,
      delta: weights.GOAL_ACHIEVED_DELTA,
    });
  }

  // ── Inatividade ──────────────────────────────────────────────────────────
  // O único fator que sozinho derruba o score, e de propósito: parar de treinar
  // é a informação mais relevante que existe sobre progresso.
  if (usable(input.daysSinceLastSession) && input.daysSinceLastSession > weights.INACTIVITY_DAYS) {
    factors.push({
      id: 'inactivity',
      label: `${Math.round(input.daysSinceLastSession)} dias sem treino registrado`,
      delta: weights.INACTIVITY_DELTA,
    });
  }

  const soma = factors.reduce((acc, f) => acc + f.delta, 0);
  const bruto = weights.BASE + soma;
  const value = clamp(Math.round(bruto), weights.MIN, weights.MAX);

  // Invariante do produto: score exibido tem breakdown. Quando nenhum fator
  // dispara, o próprio "sem mudança relevante" é a explicação — e não uma
  // lista vazia, que o banco recusaria.
  if (factors.length === 0) {
    factors.push({
      id: 'steady',
      label: 'Sem mudança relevante no período',
      delta: 0,
    });
  }

  return { value, status: 'ok', factors };
}

/**
 * O que mudou entre dois momentos do score, fator a fator.
 *
 * Responde "por que subiu/caiu" comparando o breakdown de hoje com o de 7 dias
 * atrás — não a diferença dos números, que diz que mudou mas não o quê.
 *
 * Determinística: nenhuma frase é gerada por modelo. Cada linha sai de um fator
 * que existe (ou deixou de existir) no período.
 */
export function compareFactorWindows(
  atual: readonly ScoreFactor[],
  anterior: readonly ScoreFactor[],
): ScoreFactor[] {
  const antes = new Map(anterior.map((f) => [f.id, f]));
  const mudancas: ScoreFactor[] = [];

  for (const f of atual) {
    if (f.id === 'onboarding.calibrating' || f.id === 'steady') continue;
    const previo = antes.get(f.id);
    const delta = f.delta - (previo?.delta ?? 0);
    if (delta !== 0) mudancas.push({ id: f.id, label: f.label, delta });
  }

  // Fator que sumiu: deixou de puxar (para cima ou para baixo). Um
  // `inactivity` que desapareceu é boa notícia e precisa aparecer como tal.
  for (const f of anterior) {
    if (f.id === 'onboarding.calibrating' || f.id === 'steady') continue;
    if (!atual.some((a) => a.id === f.id)) {
      mudancas.push({ id: f.id, label: f.label, delta: -f.delta });
    }
  }

  // Maior movimento primeiro — é o que explica melhor a mudança.
  mudancas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return mudancas;
}
