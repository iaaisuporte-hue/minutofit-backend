/**
 * Métricas derivadas de uma sessão de treino — função pura.
 *
 * Roda DENTRO da transação que grava a sessão (`createSession`), a partir das
 * séries que já estão em memória: nenhuma query extra, nenhum reprocessamento.
 *
 * ## Carga externa × carga interna
 *
 * São duas medidas diferentes e ambas ficam gravadas:
 *
 * - **Tonelagem** (`tonnageKg = Σ reps × kg`) é objetiva, mas só existe quando
 *   houve carga. Treino em casa com peso do corpo devolve `null` — o que é a
 *   verdade, não uma falha.
 * - **Carga interna** (`effortLoad`) é o sRPE de Foster: quanto a sessão custou
 *   ao aluno. Funciona mesmo sem carga, porque depende do esforço percebido.
 *
 * O `calcEstimatedLoad` do módulo esportivo (Fight Intelligence) implementa o
 * mesmo conceito para outro domínio, com escala própria (0–100) e tabela
 * própria. Não é reaproveitado aqui de propósito: unificar os dois exigiria
 * mudar a escala de um deles e quebrar o histórico já gravado do outro.
 *
 * ## Por que `effortLoad` pode ser null
 *
 * Sem RPE nenhum — nem da sessão, nem de série alguma — não há como estimar
 * esforço. `null` é a resposta honesta; inventar um valor médio contaminaria
 * qualquer leitura de carga futura com dado fabricado.
 */
import {
  DURATION_MAX_MINUTES,
  DURATION_MEASURED_THRESHOLD_SECONDS,
  DURATION_MIN_MINUTES,
  EFFORT_MINUTES_PER_SET,
} from './performance.constants';
import type { MetricsSetInput, SessionMetrics } from './performance.types';

/**
 * Duração medida da sessão, em minutos.
 *
 * Hoje o cliente registra tudo no fim (started_at = ended_at), então o caminho
 * normal é `null`. Quando existir um "iniciar treino" de verdade, esta função
 * já está pronta e o schema não muda.
 */
export function resolveDurationMin(
  startedAt: Date | null,
  endedAt: Date | null,
  isRetroactive: boolean,
): number | null {
  // Retroativo não tem duração: as duas pontas são a data escolhida pelo aluno.
  if (isRetroactive) return null;
  if (!startedAt || !endedAt) return null;
  const seconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < DURATION_MEASURED_THRESHOLD_SECONDS) return null;
  const minutes = Math.round(seconds / 60);
  return Math.min(DURATION_MAX_MINUTES, Math.max(DURATION_MIN_MINUTES, minutes));
}

/** Média dos RPEs informados por série, arredondada. `null` se ninguém informou. */
function averageSetRpe(sets: MetricsSetInput[]): number | null {
  const values = sets
    .filter((s) => s.status === 'done' && s.rpe != null && Number.isFinite(s.rpe))
    .map((s) => s.rpe as number);
  if (values.length === 0) return null;
  return Math.round(values.reduce((acc, v) => acc + v, 0) / values.length);
}

/**
 * Calcula as métricas da sessão. Só séries `done` entram: uma série pulada é
 * justamente a que NÃO aconteceu.
 *
 * Devolve `null` quando não há nenhuma série realizada — sessão sem execução
 * não gera linha de métrica, para não poluir médias futuras com zeros
 * artificiais.
 */
export function computeSessionMetrics(
  sets: MetricsSetInput[],
  opts: { sessionRpe: number | null; durationMin: number | null },
): SessionMetrics | null {
  const done = sets.filter((s) => s.status === 'done');
  if (done.length === 0) return null;

  let repsTotal = 0;
  let tonnage = 0;
  let hasLoad = false;

  for (const s of done) {
    const reps = s.repsDone != null && Number.isFinite(s.repsDone) ? s.repsDone : 0;
    repsTotal += reps;
    if (s.loadDoneKg != null && Number.isFinite(s.loadDoneKg) && s.repsDone != null) {
      tonnage += reps * s.loadDoneKg;
      hasLoad = true;
    }
  }

  const srpe = opts.sessionRpe ?? averageSetRpe(done);
  const durationMin = opts.durationMin;

  let effortLoad: number | null = null;
  let effortLoadMethod: SessionMetrics['effortLoadMethod'] = null;
  if (srpe != null) {
    if (durationMin != null) {
      effortLoad = srpe * durationMin;
      effortLoadMethod = 'srpe_duration';
    } else {
      effortLoad = srpe * done.length * EFFORT_MINUTES_PER_SET;
      effortLoadMethod = 'srpe_sets';
    }
  }

  return {
    setsDone: done.length,
    repsTotal,
    // Arredonda a 2 casas — a coluna é NUMERIC e float acumula resíduo.
    tonnageKg: hasLoad ? Math.round(tonnage * 100) / 100 : null,
    durationMin,
    srpe,
    effortLoad: effortLoad == null ? null : Math.round(effortLoad * 100) / 100,
    effortLoadMethod,
  };
}
