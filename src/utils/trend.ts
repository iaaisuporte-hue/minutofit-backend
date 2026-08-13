/**
 * Tendência de uma série de pontuações — regressão linear simples.
 *
 * Estava dentro de `metabolic.engine.ts` e a Spec 033 previa extrair para cá
 * quando um segundo motor precisasse da mesma leitura. O Progress Score é esse
 * segundo motor: duplicar a regressão faria as duas telas discordarem sobre o
 * que é "melhorando" no dia em que alguém ajustasse um limiar.
 *
 * ## Por que regressão e não "hoje menos ontem"
 *
 * A diferença entre dois pontos consecutivos é dominada por ruído: um treino
 * puxado ou um dia de descanso mudariam a seta. A inclinação sobre a série
 * inteira só vira `up`/`down` quando existe direção sustentada.
 *
 * Abaixo de `MIN_POINTS` não há série suficiente para falar de direção, e a
 * resposta honesta é `stable` — não "não sei", porque a UI precisa de um valor,
 * e não uma seta inventada.
 */

export type Trend = 'up' | 'stable' | 'down';

/** Pontos mínimos para arriscar uma direção. */
export const TREND_MIN_POINTS = 5;

/**
 * Inclinação mínima (pontos de score por dia) para a série deixar de ser
 * estável. 0,3 acumula ~8 pontos em quatro semanas — movimento que o usuário
 * percebe, e não oscilação.
 */
export const TREND_SLOPE_THRESHOLD = 0.3;

/**
 * Direção da série, do ponto mais antigo para o mais recente.
 *
 * Ignora pontos sem valor: um dia sem score não é um zero, é ausência — e
 * tratá-lo como zero derrubaria a inclinação artificialmente.
 */
export function resolveTrend(scores: readonly (number | null | undefined)[]): Trend {
  const values = scores.filter(
    (s): s is number => s != null && Number.isFinite(s),
  );
  if (values.length < TREND_MIN_POINTS) return 'stable';

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, v) => sum + v, 0) / n;

  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - xMean) * (v - yMean);
    den += (i - xMean) ** 2;
  });

  // `den` só é zero com um ponto só, já barrado acima; a guarda evita NaN caso
  // isso mude.
  const slope = den === 0 ? 0 : num / den;
  if (!Number.isFinite(slope)) return 'stable';

  if (slope >= TREND_SLOPE_THRESHOLD) return 'up';
  if (slope <= -TREND_SLOPE_THRESHOLD) return 'down';
  return 'stable';
}
