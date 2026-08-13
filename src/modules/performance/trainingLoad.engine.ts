/**
 * Ritmo de carga de treino — função pura (Spec 033, Onda P3).
 *
 * ## Três conceitos que NÃO se misturam
 *
 * - **Tonelagem** (`tonnage_kg`): Σ reps × kg. Trabalho mecânico. É objetiva,
 *   comparável só do aluno com ele mesmo, e NÃO existe em treino de peso
 *   corporal. Nunca deve ser apresentada como intensidade: levantar 10 t leves
 *   e 5 t pesadas não diz qual custou mais.
 * - **Carga da sessão** (`effort_load`): sRPE de Foster — quanto a sessão
 *   custou ao aluno. Existe mesmo sem peso, porque depende do esforço
 *   percebido.
 * - **Ritmo de carga** (este arquivo): a carga recente comparada ao próprio
 *   padrão do aluno. É razão, não quantidade.
 *
 * ## Por que só faixa qualitativa
 *
 * A razão entre janelas é parente do ACWR, usado em preparação física para
 * falar de risco de lesão. Publicar o número cru convidaria essa leitura, e os
 * dados aqui não sustentam afirmação clínica: a duração da sessão quase nunca é
 * medida, então a maior parte da carga vem de um proxy por séries. A faixa
 * comunica o que é honesto dizer — "acima do seu padrão" — sem fingir precisão.
 */
import { LOAD_RATIO_BANDS, LOAD_RATIO_MIN_SESSIONS } from './performance.constants';

/** Faixas do ritmo. `null` quando não há amostra para afirmar nada. */
export type LoadRatioBand = 'below' | 'within' | 'above' | 'spike';

export interface LoadReading {
  /** Soma de `effort_load` dos últimos 7 dias. `null` sem dado. */
  effortLoad7d: number | null;
  /** Faixa qualitativa. `null` = amostra insuficiente. */
  ratioBand: LoadRatioBand | null;
  /**
   * A razão em si. Fica fora da resposta da API de propósito — serve à
   * observabilidade e ao gatilho do Readiness, não à tela.
   */
  ratio: number | null;
}

export interface LoadInput {
  /** Soma de `effort_load` na janela de 7 dias. */
  sum7d: number | null;
  /** Soma de `effort_load` na janela de 28 dias. */
  sum28d: number | null;
  /** Sessões com `effort_load` não-nulo em 28 dias. */
  sessionsWithLoad28d: number;
}

function usable(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

/**
 * Calcula o ritmo comparando a média DIÁRIA das duas janelas.
 *
 * Média diária, e não soma: 7 dias contra 28 dias somados dariam sempre ~0,25 e
 * a razão não significaria nada. Dividindo cada soma pelos seus dias, a razão
 * fica em torno de 1 quando o ritmo é o mesmo.
 */
export function computeLoadReading(input: LoadInput): LoadReading {
  const sum7 = usable(input.sum7d) ? input.sum7d : null;
  const sum28 = usable(input.sum28d) ? input.sum28d : null;

  // Amostra pequena demais: uma semana atípica dominaria a razão e a tela
  // afirmaria "acima do padrão" sem que exista padrão estabelecido.
  if (input.sessionsWithLoad28d < LOAD_RATIO_MIN_SESSIONS || sum7 == null || sum28 == null) {
    return { effortLoad7d: sum7, ratioBand: null, ratio: null };
  }

  const media7 = sum7 / 7;
  const media28 = sum28 / 28;

  // Denominador zero significa 28 dias sem carga alguma. Não há padrão contra
  // o que comparar, e dividir produziria Infinity.
  if (media28 <= 0 || !Number.isFinite(media28)) {
    return { effortLoad7d: sum7, ratioBand: null, ratio: null };
  }

  const ratio = media7 / media28;
  if (!Number.isFinite(ratio)) {
    return { effortLoad7d: sum7, ratioBand: null, ratio: null };
  }

  let band: LoadRatioBand;
  if (ratio >= LOAD_RATIO_BANDS.SPIKE) band = 'spike';
  else if (ratio >= LOAD_RATIO_BANDS.ABOVE) band = 'above';
  else if (ratio < LOAD_RATIO_BANDS.BELOW) band = 'below';
  else band = 'within';

  return {
    effortLoad7d: Math.round(sum7 * 100) / 100,
    ratioBand: band,
    ratio: Math.round(ratio * 100) / 100,
  };
}

/** Texto da faixa. Observacional: descreve, não diagnostica nem recomenda. */
export const LOAD_BAND_LABEL: Record<LoadRatioBand, string> = {
  below: 'Abaixo do seu ritmo habitual',
  within: 'Dentro do seu ritmo habitual',
  above: 'Acima do seu ritmo habitual',
  spike: 'Bem acima do seu ritmo habitual',
};
