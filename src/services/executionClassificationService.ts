/**
 * Classificação de execução por EXERCÍCIO (Sprint P2B).
 *
 * Responde a pergunta que nenhuma das 5 fórmulas de "aderência" já existentes
 * responde (ver `CURRENT_ARCHITECTURE` em
 * `docs/sprints/P2B_ADHERENCE_RECURRING_INSIGHTS.md`): "a ficha está sendo
 * seguida, adaptada ou ignorada, EXERCÍCIO por exercício?" — não SÉRIE por
 * série (isso já existe em `getStudentExecutionSummary`, intocado).
 *
 * `EXECUTION_CLASSIFICATION` do harness, ao pé da letra:
 *   EXECUTADO_CONFORME_PRESCRITO — todas as séries prescritas feitas, sem troca
 *   SUBSTITUIDO   — existe linha `execution_source='replacement'` cujo
 *                   `substituted_from_exercise_id` aponta para este exercício,
 *                   independente de o substituto ter sido concluído por inteiro
 *   PARCIAL       — pelo menos uma série feita (dele OU do substituto), não todas
 *   NAO_EXECUTADO — diferença entre o prescrito e o executado: nenhuma série
 *   ADICIONADO    — `execution_source='user_added'`, fora do denominador (D4)
 * Prioridade: SUBSTITUIDO > PARCIAL (um substituto parcialmente feito ainda é
 * "SUBSTITUIDO" — o fato relevante é a troca, não a completude do substituto).
 *
 * Performance (KNOWN_RISKS do harness): a alternativa a isto seria filtrar em
 * SQL por `substituted_from_exercise_id` (sem índice) ou usar operador JSONB
 * sobre `prescribed_snapshot` (sem GIN). Nenhuma das duas é necessária aqui —
 * o desenho abaixo usa SÓ colunas já indexadas: `workout_sessions
 * (user_id, performed_at)` (migration 1813) filtra a janela, e
 * `workout_set_logs (session_id)` (migration 1802) filtra o detalhe pelos ids
 * já resolvidos. O cruzamento com `prescribed_snapshot` acontece em memória
 * do processo Node, sobre um volume por aluno que nunca é grande (um humano
 * não treina milhares de vezes por janela) — DECISÃO registrada no harness
 * (DATABASE_CHANGES): nenhuma migration de índice nesta sprint.
 *
 * Duas queries, nunca N+1: uma para as sessões da janela, uma agregada para
 * TODOS os `workout_set_logs` dessas sessões de uma vez.
 */
import pool from '../config/database';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

export type ExecutionCategory =
  | 'EXECUTADO_CONFORME_PRESCRITO'
  | 'SUBSTITUIDO'
  | 'PARCIAL'
  | 'NAO_EXECUTADO';

const CATEGORIES: readonly ExecutionCategory[] = [
  'EXECUTADO_CONFORME_PRESCRITO',
  'SUBSTITUIDO',
  'PARCIAL',
  'NAO_EXECUTADO',
];

export type ExerciseExecution = {
  sessionId: number;
  performedAt: string;
  exerciseId: string | null;
  exerciseName: string;
  category: ExecutionCategory;
  prescribedSets: number;
  doneSets: number;
  substitutedToExerciseId: string | null;
  substitutedToExerciseName: string | null;
  /** Texto livre tal como persistido — não há enum no banco (ver harness). */
  substitutionReason: string | null;
};

export type AddedExerciseExecution = {
  sessionId: number;
  performedAt: string;
  exerciseId: string | null;
  exerciseName: string;
  setsDone: number;
};

export type ExecutionClassificationResult = {
  windowDays: number;
  sessionsConsidered: number;
  /** total de exercícios PRESCRITOS na janela — denominador dos 4 buckets (D-DENOMINATOR-JANELA). */
  denominator: number;
  buckets: Record<ExecutionCategory, { count: number; pct: number | null }>;
  /** Fora do denominador de aderência (item 4 do harness) — contagem absoluta. */
  addedCount: number;
  /** Uma linha por (sessão, exercício prescrito) — insumo de drill-down e de recorrência. */
  items: ExerciseExecution[];
  added: AddedExerciseExecution[];
};

const DEFAULT_WINDOW_DAYS = 30;
/**
 * Teto defensivo de SESSÕES por consulta — não é regra de negócio, é proteção
 * de performance (mesmo espírito do `CANDIDATE_POOL_LIMIT` em
 * `exerciseReplacementSuggestionService.ts`). Uma carteira longeva pode ter
 * centenas de sessões; sem teto, a recorrência (que usa uma janela bem maior
 * que os 30 dias padrão — ver `exerciseInsightService.ts`) viraria varredura
 * sem fim do histórico completo do aluno.
 */
const SESSION_CAP = 200;

/** Conta séries a partir de "4" → 4, "3,3,4" → 3; clamp [1,12]. Cópia deliberada
 * da função homônima (não exportada) em `workoutSessionService.ts` — a regra
 * de ouro da sprint proíbe alterar aquele arquivo além de novas funções de
 * leitura, e exportar um helper privado seria uma mudança na sua superfície.
 * Duas linhas, comportamento idêntico, testado aqui de forma independente. */
function parseSetCount(setsStr: unknown): number {
  if (setsStr == null) return 1;
  const s = String(setsStr).trim();
  if (s.includes(',')) return Math.min(12, Math.max(1, s.split(',').length));
  const m = s.match(/\d+/);
  const n = m ? parseInt(m[0], 10) : null;
  return Math.min(12, Math.max(1, n ?? 1));
}

/** Chave de agrupamento de um exercício: pelo id quando existe (regra desde a
 * P1 — todo item novo tem `exerciseId` UUID); por nome normalizado só para
 * fichas legadas sem id (não deveriam mais existir, mas o snapshot é
 * imutável — uma sessão antiga carrega o formato de quando foi gravada). */
function keyFor(exerciseId: string | null, name: string): string {
  return exerciseId ?? `name:${name.trim().toLowerCase()}`;
}

type PrescribedItem = { exerciseId?: unknown; name?: unknown; sets?: unknown };

type LogGroup = {
  exerciseId: string | null;
  exerciseName: string;
  executionSource: string;
  substitutedFrom: string | null;
  doneCount: number;
  totalCount: number;
  reason: string | null;
};

function emptyBuckets(): Record<ExecutionCategory, { count: number; pct: number | null }> {
  return CATEGORIES.reduce(
    (acc, c) => ({ ...acc, [c]: { count: 0, pct: null } }),
    {} as Record<ExecutionCategory, { count: number; pct: number | null }>,
  );
}

/**
 * Distribui os 4 buckets em % do denominador. Sempre soma exatamente 100 (ou
 * fica null se não há denominador) — o ajuste de arredondamento cai no MAIOR
 * bucket por CONTAGEM (harness: "ajuste de arredondamento no maior bucket").
 */
function buildBuckets(
  counts: Record<ExecutionCategory, number>,
  denominator: number,
): Record<ExecutionCategory, { count: number; pct: number | null }> {
  if (denominator === 0) return emptyBuckets();

  const rounded = CATEGORIES.map((c) => Math.round((counts[c] / denominator) * 100));
  const diff = 100 - rounded.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    let idxMax = 0;
    for (let i = 1; i < CATEGORIES.length; i++) {
      if (counts[CATEGORIES[i]] > counts[CATEGORIES[idxMax]]) idxMax = i;
    }
    rounded[idxMax] += diff;
  }

  const out = {} as Record<ExecutionCategory, { count: number; pct: number | null }>;
  CATEGORIES.forEach((c, i) => {
    out[c] = { count: counts[c], pct: rounded[i] };
  });
  return out;
}

/**
 * Classifica exercício-a-exercício as sessões de `studentId` numa janela de
 * dias. Não checa vínculo personal↔aluno — é uma função de leitura pura sobre
 * um `studentId`; quem chama (rota ou outro serviço) é responsável por
 * autorização, mesmo padrão de `getWorkoutStats(userId)`.
 */
export async function classifyExecutionForWindow(
  studentId: number,
  opts: { windowDays?: number; sessionLimit?: number } = {},
): Promise<ExecutionClassificationResult> {
  const windowDays = Math.min(Math.max(Math.trunc(opts.windowDays ?? DEFAULT_WINDOW_DAYS), 1), 3650);
  const sessionLimit = Math.min(Math.max(Math.trunc(opts.sessionLimit ?? SESSION_CAP), 1), SESSION_CAP);

  const { rows: sessionRows } = await pool.query(
    `SELECT id, performed_at, prescribed_snapshot
       FROM workout_sessions
      WHERE user_id = $1
        AND status IN ('completed', 'partial')
        AND performed_at >= now() - ($2 || ' days')::interval
      ORDER BY performed_at DESC
      LIMIT $3`,
    [studentId, String(windowDays), sessionLimit],
  );

  if (!sessionRows.length) {
    return {
      windowDays,
      sessionsConsidered: 0,
      denominator: 0,
      buckets: emptyBuckets(),
      addedCount: 0,
      items: [],
      added: [],
    };
  }

  const sessionIds = sessionRows.map((r) => r.id as number);

  const { rows: logRows } = await pool.query(
    `SELECT session_id, exercise_id, exercise_name, execution_source, substituted_from_exercise_id,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done_count,
            COUNT(*)::int AS total_count,
            (ARRAY_AGG(substitution_reason ORDER BY created_at DESC)
              FILTER (WHERE substitution_reason IS NOT NULL))[1] AS latest_reason
       FROM workout_set_logs
      WHERE session_id = ANY($1)
      GROUP BY session_id, exercise_id, exercise_name, execution_source, substituted_from_exercise_id`,
    [sessionIds],
  );

  const logsBySession = new Map<number, LogGroup[]>();
  for (const r of logRows as Record<string, unknown>[]) {
    const sessionId = Number(r.session_id);
    const list = logsBySession.get(sessionId) ?? [];
    list.push({
      exerciseId: (r.exercise_id as string | null) ?? null,
      exerciseName: String(r.exercise_name ?? ''),
      executionSource: String(r.execution_source),
      substitutedFrom: (r.substituted_from_exercise_id as string | null) ?? null,
      doneCount: Number(r.done_count ?? 0),
      totalCount: Number(r.total_count ?? 0),
      reason: (r.latest_reason as string | null) ?? null,
    });
    logsBySession.set(sessionId, list);
  }

  const items: ExerciseExecution[] = [];
  const added: AddedExerciseExecution[] = [];
  const bucketCounts: Record<ExecutionCategory, number> = {
    EXECUTADO_CONFORME_PRESCRITO: 0,
    SUBSTITUIDO: 0,
    PARCIAL: 0,
    NAO_EXECUTADO: 0,
  };

  for (const session of sessionRows) {
    const rawSnapshot: unknown[] = Array.isArray(session.prescribed_snapshot) ? session.prescribed_snapshot : [];
    const logs = logsBySession.get(session.id) ?? [];
    const performedAt = new Date(session.performed_at).toISOString();

    // Dedupe defensivo: mesma chave duas vezes no mesmo dia (ex.: mesmo
    // exercício repetido na ficha) vira UM exercício prescrito, séries somadas
    // — evita contar "duas vezes o mesmo exercício" no denominador por causa
    // de uma decisão de UI do builder que nada tem a ver com aderência.
    const prescribedByKey = new Map<string, { exerciseId: string | null; name: string; sets: number }>();
    for (const raw of rawSnapshot) {
      const it = raw as PrescribedItem;
      const exerciseId = typeof it.exerciseId === 'string' ? it.exerciseId : null;
      const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : 'Exercício';
      const key = keyFor(exerciseId, name);
      const prev = prescribedByKey.get(key);
      const sets = parseSetCount(it.sets);
      if (prev) prev.sets += sets;
      else prescribedByKey.set(key, { exerciseId, name, sets });
    }

    for (const [key, prescribed] of prescribedByKey) {
      const own = logs.find(
        (l) => l.executionSource === 'prescribed' && keyFor(l.exerciseId, l.exerciseName) === key,
      );
      // Substituições só se ligam por ID (a coluna referencia `exercises.id`) —
      // um item legado sem `exerciseId` nunca é detectado como substituído,
      // documentado como limitação herdada (não introduzida por esta sprint).
      const substitutions = prescribed.exerciseId
        ? logs.filter((l) => l.executionSource === 'replacement' && l.substitutedFrom === prescribed.exerciseId)
        : [];

      let category: ExecutionCategory;
      let substitutedToExerciseId: string | null = null;
      let substitutedToExerciseName: string | null = null;
      let substitutionReason: string | null = null;
      let doneSets = own?.doneCount ?? 0;

      if (substitutions.length > 0) {
        category = 'SUBSTITUIDO';
        // Mais de um substituto no mesmo item (raro — o aluno trocou de novo
        // na mesma sessão): o "principal" é quem tem mais séries feitas.
        const primary = [...substitutions].sort(
          (a, b) => b.doneCount - a.doneCount || b.totalCount - a.totalCount,
        )[0];
        substitutedToExerciseId = primary.exerciseId;
        substitutedToExerciseName = primary.exerciseName || null;
        substitutionReason = primary.reason;
        doneSets = primary.doneCount;
      } else if (doneSets > 0 && doneSets < prescribed.sets) {
        category = 'PARCIAL';
      } else if (doneSets > 0) {
        category = 'EXECUTADO_CONFORME_PRESCRITO';
      } else {
        category = 'NAO_EXECUTADO';
      }

      bucketCounts[category] += 1;
      items.push({
        sessionId: session.id,
        performedAt,
        exerciseId: prescribed.exerciseId,
        exerciseName: prescribed.name,
        category,
        prescribedSets: prescribed.sets,
        doneSets,
        substitutedToExerciseId,
        substitutedToExerciseName,
        substitutionReason,
      });
    }

    // ADICIONADO: linhas 'user_added' cuja chave não está no prescrito do dia.
    const addedByKey = new Map<string, LogGroup>();
    for (const l of logs) {
      if (l.executionSource !== 'user_added') continue;
      const key = keyFor(l.exerciseId, l.exerciseName);
      if (prescribedByKey.has(key)) continue; // defensivo — não deveria acontecer
      if (!addedByKey.has(key)) addedByKey.set(key, l);
    }
    for (const g of addedByKey.values()) {
      added.push({
        sessionId: session.id,
        performedAt,
        exerciseId: g.exerciseId,
        exerciseName: g.exerciseName,
        setsDone: g.doneCount,
      });
    }
  }

  const denominator = items.length;
  return {
    windowDays,
    sessionsConsidered: sessionRows.length,
    denominator,
    buckets: buildBuckets(bucketCounts, denominator),
    addedCount: added.length,
    items,
    added,
  };
}

/**
 * Fachada usada pela rota `GET /students/:studentId/adherence` (ADHERENCE_DEFINITION
 * do harness — "Como a ficha foi seguida", granularidade de exercício). Checa
 * vínculo ATIVO personal↔aluno antes de ler (mesmo padrão de
 * `getStudentExecutionSummary` em `workoutSessionService.ts` — o consent é
 * aplicado na rota, mas consent não é vínculo, e um consent esquecido ativo
 * após o fim do acompanhamento não pode virar leitura permanente).
 */
export async function getAdherenceSummaryForPersonal(
  personalId: number,
  studentId: number,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<ExecutionClassificationResult> {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }
  return classifyExecutionForWindow(studentId, { windowDays });
}
