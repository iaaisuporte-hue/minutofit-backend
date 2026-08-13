/**
 * Detecção de recordes pessoais — função pura (Spec 033, Onda P2).
 *
 * ## O contrato
 *
 * Um recorde só existe quando há melhora REAL sobre o melhor valor anterior do
 * mesmo `(usuário, exercício, categoria)`. Empate não é recorde: repetir a
 * mesma carga é consistência, não progressão, e comemorar isso ensinaria o
 * aluno a desconfiar da comemoração. Valor menor, obviamente, também não.
 *
 * A primeira marca de cada `(exercício, categoria)` é registrada com
 * `isFirst`, porque é a linha de base a partir da qual os próximos recordes
 * serão medidos — mas não é conquista, e a UI não celebra.
 *
 * ## Por que puro
 *
 * A mesma semântica precisa existir em dois lugares: aqui (detecção online,
 * dentro da transação da sessão) e no SQL do backfill da migration 1823. Manter
 * a regra numa função sem I/O é o que permite testá-la exaustivamente e
 * comparar as duas implementações caso a caso. Qualquer mudança aqui exige
 * mudar o backfill junto — e o teste de integração cobre a equivalência.
 */
import { estimateOneRepMax } from './e1rm.engine';

export type PrKind = 'max_load' | 'best_e1rm' | 'session_volume' | 'max_reps';

/** As quatro categorias, na ordem em que fazem sentido para o aluno. */
export const PR_KINDS: readonly PrKind[] = ['max_load', 'best_e1rm', 'session_volume', 'max_reps'];

/** Série realizada, já sanitizada, com o vínculo de exercício resolvido. */
export interface PrSetInput {
  exerciseId: string | null;
  exerciseName: string;
  repsDone: number | null;
  loadDoneKg: number | null;
  status: 'done' | 'skipped';
}

/** O melhor de UMA sessão numa categoria, antes de comparar com o histórico. */
export interface PrCandidate {
  exerciseId: string;
  exerciseName: string;
  kind: PrKind;
  value: number;
  /** Contexto do momento: quantas repetições e com que carga. */
  reps: number | null;
  loadKg: number | null;
}

/** Candidato que superou o histórico — vira linha em `user_pr_events`. */
export interface PrDetection extends PrCandidate {
  previousValue: number | null;
  /** Estreia da categoria: linha de base, não conquista. Não celebra. */
  isFirst: boolean;
}

/** Melhor valor já registrado, por `(exercício, categoria)`. */
export type CurrentBests = Map<string, number>;

/** Chave de `CurrentBests`. Exportada para o repositório montar o mesmo mapa. */
export function bestKey(exerciseId: string, kind: PrKind): string {
  return `${exerciseId}::${kind}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Extrai os candidatos a recorde de uma sessão, agrupando por exercício.
 *
 * Espelha exatamente os filtros do backfill da migration 1823:
 *  - só séries `done` e com exercício resolvido (sem vínculo não há o que comparar);
 *  - `max_load` e `session_volume` exigem carga > 0;
 *  - `best_e1rm` exige carga > 0 e 1..12 repetições (guarda do próprio e1RM);
 *  - `max_reps` existe SÓ para série sem carga — com carga, quem mede progresso
 *    é o e1RM, e um recorde de repetições ali competiria com ele.
 */
export function buildPrCandidates(sets: PrSetInput[]): PrCandidate[] {
  interface Acc {
    exerciseId: string;
    exerciseName: string;
    maxLoad: number | null;
    maxLoadReps: number | null;
    bestE1rm: number | null;
    e1rmReps: number | null;
    e1rmLoad: number | null;
    volume: number | null;
    maxReps: number | null;
  }
  const byExercise = new Map<string, Acc>();

  for (const s of sets) {
    if (s.status !== 'done') continue;
    if (!s.exerciseId) continue;

    let acc = byExercise.get(s.exerciseId);
    if (!acc) {
      acc = {
        exerciseId: s.exerciseId,
        exerciseName: s.exerciseName,
        maxLoad: null,
        maxLoadReps: null,
        bestE1rm: null,
        e1rmReps: null,
        e1rmLoad: null,
        volume: null,
        maxReps: null,
      };
      byExercise.set(s.exerciseId, acc);
    }

    const load = s.loadDoneKg;
    const reps = s.repsDone;
    const hasLoad = load != null && Number.isFinite(load) && load > 0;

    if (hasLoad && (acc.maxLoad == null || load > acc.maxLoad)) {
      acc.maxLoad = load;
      acc.maxLoadReps = reps;
    }

    const e1rm = hasLoad ? estimateOneRepMax(load, reps) : null;
    if (e1rm != null && (acc.bestE1rm == null || e1rm > acc.bestE1rm)) {
      acc.bestE1rm = e1rm;
      acc.e1rmReps = reps;
      acc.e1rmLoad = load;
    }

    if (hasLoad && reps != null && Number.isFinite(reps)) {
      acc.volume = (acc.volume ?? 0) + reps * load;
    }

    // Peso corporal: `load_done_kg` nulo. Zero é carga informada, não ausência.
    if (load == null && reps != null && reps > 0 && (acc.maxReps == null || reps > acc.maxReps)) {
      acc.maxReps = reps;
    }
  }

  const out: PrCandidate[] = [];
  for (const a of byExercise.values()) {
    const base = { exerciseId: a.exerciseId, exerciseName: a.exerciseName };
    if (a.maxLoad != null) {
      out.push({ ...base, kind: 'max_load', value: round2(a.maxLoad), reps: a.maxLoadReps, loadKg: a.maxLoad });
    }
    if (a.bestE1rm != null) {
      out.push({ ...base, kind: 'best_e1rm', value: round2(a.bestE1rm), reps: a.e1rmReps, loadKg: a.e1rmLoad });
    }
    if (a.volume != null) {
      out.push({ ...base, kind: 'session_volume', value: round2(a.volume), reps: null, loadKg: null });
    }
    if (a.maxReps != null) {
      out.push({ ...base, kind: 'max_reps', value: a.maxReps, reps: a.maxReps, loadKg: null });
    }
  }
  return out;
}

/**
 * Compara os candidatos com o histórico e devolve só as melhoras reais.
 *
 * Determinística e monotônica: para o mesmo par (candidatos, histórico) a saída
 * é sempre a mesma, e nunca emite valor menor ou igual ao que já está gravado.
 * É essa propriedade que torna o reprocessamento seguro — reenviar a mesma
 * sessão produz candidatos idênticos, que já não superam o próprio recorde que
 * geraram, e nada é inserido.
 */
export function detectPrs(candidates: PrCandidate[], currentBests: CurrentBests): PrDetection[] {
  const out: PrDetection[] = [];
  for (const c of candidates) {
    const previous = currentBests.get(bestKey(c.exerciseId, c.kind));
    if (previous == null) {
      out.push({ ...c, previousValue: null, isFirst: true });
      continue;
    }
    // Estritamente maior: empate não é recorde.
    if (c.value > previous) {
      out.push({ ...c, previousValue: previous, isFirst: false });
    }
  }
  return out;
}
