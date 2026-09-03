/**
 * Motor de Substituições Inteligentes (Sprint P2A).
 *
 * Ao aluno tocar "Substituir exercício" durante a execução, este motor sugere
 * 3-5 alternativas ANTES da busca manual (`FreeExercisePickerSheet`, P0) —
 * o fluxo manual continua existindo e funcionando sozinho, esta é uma camada
 * ANTES dele, nunca substitui. Pipeline exatamente como definido no harness
 * `docs/sprints/P2A_SMART_EXERCISE_SUBSTITUTION.md`
 * (DECISIONS/SCORING_MODEL/FILTER_RULES — não redecida nada daqui sem
 * atualizar o harness primeiro):
 *
 *   1. candidate_generation — SQL filtrado (nunca carrega o catálogo
 *      inteiro em memória): mesmo `body_part` do original, `status='active'`,
 *      visível ao viewer (reusa a MESMA regra de `resolveViewerPersonalId`
 *      já aplicada em `exerciseLibraryService.searchExercises`).
 *   2. FILTER_RULES 1-5 — aplicadas em SQL sempre que possível.
 *   3. SCORING_MODEL — pesos exatos do harness, threshold 40, cap 5.
 *   4. Tier `PERSONAL_DEFINED` (alternativa explícita do Personal) sempre no
 *      topo, IGNORA o threshold (D5), nunca comparado numericamente ao
 *      resto (por isso `score: null` nesse tier).
 *
 * Auditabilidade (§22 da spec original): cada candidato carrega os sinais
 * que formaram o score (`ReplacementSignals`) e a origem (`source`, pode
 * combinar mais de uma heurística). Não expomos isso na resposta HTTP —
 * verboso e a UI só precisa do rótulo pronto (§10: nunca a pontuação
 * numérica exposta ao usuário) — mas o cálculo fica rastreável via log
 * estruturado (`logger.debug`) para investigação futura sem precisar expor
 * nada ao cliente.
 */

import pool from '../config/database';
import logger from '../lib/logger';
import { getExercisesBatch, type Exercise } from './exerciseLibraryService';

export const REPLACEMENT_REASON_CATEGORIES = ['equipment_unavailable', 'pain_discomfort', 'other'] as const;
export type ReplacementReasonCategory = (typeof REPLACEMENT_REASON_CATEGORIES)[number];

export function isReplacementReasonCategory(value: unknown): value is ReplacementReasonCategory {
  return typeof value === 'string' && (REPLACEMENT_REASON_CATEGORIES as readonly string[]).includes(value);
}

/** Pode combinar mais de uma origem heurística para o MESMO candidato (§22). */
export type ReplacementSuggestionSource =
  | 'PERSONAL_DEFINED'
  | 'PERSONAL_LIBRARY'
  | 'SYSTEM_COMPATIBILITY'
  | 'USER_HISTORY';

export type ReplacementSignals = {
  sameTargetMuscle: boolean;
  /** Interseção REAL (não capada) — o cap de +5×2 é só na pontuação, não no sinal. */
  sharedSecondaryMusclesCount: number;
  sharedTags: boolean;
  ownPersonalLibrary: boolean;
  usedBefore: boolean;
  equipmentPenaltyApplied: boolean;
};

export type ReplacementSuggestion = {
  exercise: Exercise;
  tier: 'PERSONAL_DEFINED' | 'HEURISTIC';
  /**
   * Rótulo pronto para a UI, ou `null` quando `cautionAdvisory` está ativo
   * (D8) — nenhuma sugestão afirma confiança/segurança quando o motivo é
   * dor/desconforto; o frontend usa "Outras opções" + aviso fixo (§18).
   */
  label: string | null;
  /** Selo complementar "Você já usou esta alternativa" — nunca substitui `label` (D6). */
  usedBeforeBadge: boolean;
  reason: string;
};

export type ReplacementSuggestionsResult = {
  originalExerciseId: string;
  cautionAdvisory: boolean;
  suggestions: ReplacementSuggestion[];
};

const MIN_SCORE = 40; // D5 — peso do único sinal "forte" (target_muscle exato)
const MAX_SUGGESTIONS = 5;
const RECOMMENDED_THRESHOLD = 70;
/**
 * Teto defensivo de candidatos por consulta (não é regra de negócio — é
 * proteção de performance). O maior `body_part` do catálogo seed tem poucas
 * dezenas de exercícios; 200 dá folga generosa sem arriscar carregar um
 * corpo inteiro em memória caso a biblioteca cresça muito no futuro.
 */
const CANDIDATE_POOL_LIMIT = 200;

function fail(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function intersectionCount(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  return a.reduce((acc, v) => acc + (setB.has(v) ? 1 : 0), 0);
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  return a.some((v) => setB.has(v));
}

type OriginalExercise = {
  id: string;
  bodyPart: string;
  targetMuscle: string;
  secondaryMuscles: string[];
  tags: string[];
  equipment: string;
};

type CandidateRow = {
  id: string;
  target_muscle: string;
  secondary_muscles: string[] | null;
  equipment: string;
  tags: string[] | null;
  owner_personal_id: number | null;
};

type RankedCandidate = {
  exerciseId: string;
  tier: 'PERSONAL_DEFINED' | 'HEURISTIC';
  /** `null` no tier PERSONAL_DEFINED — não soma score, é hierarquia (D5/§13). */
  score: number | null;
  source: ReplacementSuggestionSource[];
  signals: ReplacementSignals;
};

// ---------------------------------------------------------------------------
// Leitura — cada função é 1 query, nada de loop de query por candidato.
// ---------------------------------------------------------------------------

/**
 * Carrega o original JÁ validando visibilidade (FILTER_RULES 2-3 aplicadas
 * a ele mesmo) — a rota devolve 404 tanto para id inexistente quanto para
 * exercício que existe mas não é visível ao viewer, sem diferenciar os dois
 * casos na resposta (não vazar existência de exercício privado de terceiro).
 */
async function loadOriginal(id: string, viewerPersonalId: number | null): Promise<OriginalExercise | null> {
  const params: unknown[] = [id];
  let visibility = 'e.owner_personal_id IS NULL';
  if (viewerPersonalId != null) {
    params.push(viewerPersonalId);
    visibility = `(e.owner_personal_id IS NULL OR e.owner_personal_id = $${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT e.id, e.body_part, e.target_muscle, e.secondary_muscles, e.tags, e.equipment
     FROM exercises e
     WHERE e.id = $1 AND e.status = 'active' AND ${visibility}
     LIMIT 1`,
    params,
  );
  if (!rows.length) return null;

  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    bodyPart: String(r.body_part),
    targetMuscle: String(r.target_muscle),
    secondaryMuscles: Array.isArray(r.secondary_muscles) ? (r.secondary_muscles as string[]) : [],
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    equipment: String(r.equipment),
  };
}

/**
 * Tier PERSONAL_DEFINED (D3/D5) — só existe quando o viewer tem personal
 * resolvido (aluno vinculado, ou o próprio personal). A visibilidade/status
 * do CANDIDATO ainda é checada aqui (não faria sentido sugerir um exercício
 * que o Personal arquivou), mas `body_part` NÃO entra no filtro: é uma
 * escolha explícita do Personal, fora da hierarquia de score (§13).
 */
async function loadPersonalDefined(
  originalExerciseId: string,
  viewerPersonalId: number,
): Promise<{ id: string }[]> {
  const { rows } = await pool.query(
    `SELECT c.id
     FROM exercise_replacement_alternatives era
     JOIN exercises c ON c.id = era.alternative_exercise_id
     WHERE era.original_exercise_id = $1
       AND era.personal_id = $2
       AND c.status = 'active'
       AND (c.owner_personal_id IS NULL OR c.owner_personal_id = $2)
     ORDER BY era.created_at ASC`,
    [originalExerciseId, viewerPersonalId],
  );
  return rows.map((r) => ({ id: String((r as Record<string, unknown>).id) }));
}

/** candidate_generation + FILTER_RULES 1-4, tudo em UMA query. */
async function loadHeuristicCandidates(
  originalExerciseId: string,
  bodyPart: string,
  viewerPersonalId: number | null,
  excludeIds: string[],
): Promise<CandidateRow[]> {
  const params: unknown[] = [originalExerciseId, bodyPart];
  let visibility = 'e.owner_personal_id IS NULL';
  if (viewerPersonalId != null) {
    params.push(viewerPersonalId);
    visibility = `(e.owner_personal_id IS NULL OR e.owner_personal_id = $${params.length})`;
  }
  params.push(excludeIds);

  const { rows } = await pool.query(
    `SELECT e.id, e.target_muscle, e.secondary_muscles, e.equipment, e.tags, e.owner_personal_id
     FROM exercises e
     WHERE e.id <> $1
       AND e.status = 'active'
       AND e.body_part = $2
       AND ${visibility}
       AND e.id <> ALL($${params.length}::uuid[])
     LIMIT ${CANDIDATE_POOL_LIMIT}`,
    params,
  );
  return rows as CandidateRow[];
}

/**
 * Histórico do aluno (sinal secundário, DOMAIN_MAPPING) — 1 query agregada
 * para TODOS os candidatos de uma vez, nunca 1 query por candidato.
 */
async function loadUsedBeforeSet(userId: number, originalExerciseId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT wsl.exercise_id AS candidate_id
     FROM workout_set_logs wsl
     JOIN workout_sessions ws ON ws.id = wsl.session_id
     WHERE ws.user_id = $1
       AND wsl.substituted_from_exercise_id = $2
       AND wsl.exercise_id IS NOT NULL
     GROUP BY wsl.exercise_id`,
    [userId, originalExerciseId],
  );
  return new Set(rows.map((r) => String((r as Record<string, unknown>).candidate_id)));
}

// ---------------------------------------------------------------------------
// Scoring (SCORING_MODEL do harness — pesos exatos)
// ---------------------------------------------------------------------------

function scoreCandidate(
  candidate: CandidateRow,
  original: OriginalExercise,
  ctx: { viewerPersonalId: number | null; usedBefore: boolean; reasonCategory?: ReplacementReasonCategory },
): RankedCandidate {
  const candidateSecondary = Array.isArray(candidate.secondary_muscles) ? candidate.secondary_muscles : [];
  const candidateTags = Array.isArray(candidate.tags) ? candidate.tags : [];

  const sameTargetMuscle = candidate.target_muscle === original.targetMuscle;
  const sharedSecondaryMusclesCount = intersectionCount(candidateSecondary, original.secondaryMuscles);
  const sharedTags = hasIntersection(candidateTags, original.tags);
  const ownPersonalLibrary = ctx.viewerPersonalId != null && candidate.owner_personal_id === ctx.viewerPersonalId;
  const usedBefore = ctx.usedBefore;
  const equipmentPenaltyApplied =
    ctx.reasonCategory === 'equipment_unavailable' && candidate.equipment === original.equipment;

  let score = 0;
  if (sameTargetMuscle) score += 40;
  score += Math.min(sharedSecondaryMusclesCount, 2) * 5; // até 2, +5 cada
  if (sharedTags) score += 5;
  if (ownPersonalLibrary) score += 5;
  if (usedBefore) score += 5;
  if (equipmentPenaltyApplied) score -= 20;

  const source: ReplacementSuggestionSource[] = ['SYSTEM_COMPATIBILITY'];
  if (ownPersonalLibrary) source.push('PERSONAL_LIBRARY');
  if (usedBefore) source.push('USER_HISTORY');

  return {
    exerciseId: candidate.id,
    tier: 'HEURISTIC',
    score,
    source,
    signals: {
      sameTargetMuscle,
      sharedSecondaryMusclesCount,
      sharedTags,
      ownPersonalLibrary,
      usedBefore,
      equipmentPenaltyApplied,
    },
  };
}

// ---------------------------------------------------------------------------
// Rótulo e explicação — sempre por REGRA/TEMPLATE, nunca LLM (regra de ouro).
// ---------------------------------------------------------------------------

function labelFor(c: RankedCandidate, cautionAdvisory: boolean): string | null {
  if (cautionAdvisory) return null; // D8
  if (c.tier === 'PERSONAL_DEFINED') return 'Recomendado pelo seu Personal';
  if ((c.score ?? 0) >= RECOMMENDED_THRESHOLD) return 'Recomendado';
  return 'Boa alternativa';
}

function buildReason(c: RankedCandidate, originalTargetMuscle: string): string {
  if (c.tier === 'PERSONAL_DEFINED') {
    return 'Indicado pelo seu personal como alternativa para este exercício.';
  }
  if (c.signals.sameTargetMuscle) {
    return `Trabalha o mesmo músculo-alvo (${originalTargetMuscle}).`;
  }
  if (c.signals.sharedSecondaryMusclesCount > 0) {
    return 'Compartilha músculos secundários com o exercício original.';
  }
  if (c.signals.sharedTags) {
    return 'Tem características em comum com o exercício original.';
  }
  if (c.signals.ownPersonalLibrary) {
    return 'Faz parte da biblioteca do seu personal.';
  }
  return 'Mesmo grupo muscular do exercício original.';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `viewerPersonalId` é resolvido pelo CALLER (rota) via `resolveViewerPersonalId(req)`
 * — mesmo padrão já usado por `searchExercises` em `exerciseLibraryService.ts`.
 * O serviço nunca aceita esse dado do cliente.
 *
 * Lança `Error` com `.status` (padrão já usado em `personalExerciseService.ts`)
 * quando o original não existe ou não é visível — a rota traduz para 404.
 */
export async function getReplacementSuggestions(
  userId: number,
  originalExerciseId: string,
  viewerPersonalId: number | null,
  opts: { reasonCategory?: ReplacementReasonCategory } = {},
): Promise<ReplacementSuggestionsResult> {
  const original = await loadOriginal(originalExerciseId, viewerPersonalId);
  if (!original) throw fail('exercise_not_found', 404);

  const cautionAdvisory = opts.reasonCategory === 'pain_discomfort'; // D8

  const personalDefinedRows = viewerPersonalId != null
    ? await loadPersonalDefined(originalExerciseId, viewerPersonalId)
    : [];
  const personalDefinedIds = personalDefinedRows.map((r) => r.id);

  const [candidateRows, usedBeforeSet] = await Promise.all([
    loadHeuristicCandidates(originalExerciseId, original.bodyPart, viewerPersonalId, personalDefinedIds),
    loadUsedBeforeSet(userId, originalExerciseId),
  ]);

  const heuristicRanked = candidateRows
    .map((row) => scoreCandidate(row, original, {
      viewerPersonalId,
      usedBefore: usedBeforeSet.has(row.id),
      reasonCategory: opts.reasonCategory,
    }))
    .filter((s) => (s.score ?? 0) >= MIN_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const personalDefinedRanked: RankedCandidate[] = personalDefinedRows.map((r) => ({
    exerciseId: r.id,
    tier: 'PERSONAL_DEFINED',
    score: null,
    source: ['PERSONAL_DEFINED'],
    signals: {
      sameTargetMuscle: false,
      sharedSecondaryMusclesCount: 0,
      sharedTags: false,
      ownPersonalLibrary: false,
      usedBefore: usedBeforeSet.has(r.id),
      equipmentPenaltyApplied: false,
    },
  }));

  // PERSONAL_DEFINED sempre primeiro (D5); dedupe já garantido — o tier
  // heurístico exclui `personalDefinedIds` na própria query (FILTER_RULES 5).
  const combined = [...personalDefinedRanked, ...heuristicRanked].slice(0, MAX_SUGGESTIONS);

  if (!combined.length) {
    return { originalExerciseId, cautionAdvisory, suggestions: [] };
  }

  // 1 query em batch para os dados completos (nome, mídia, etc) dos no
  // MÁXIMO 5 vencedores — nunca N+1.
  const exercisesById = new Map(
    (await getExercisesBatch(combined.map((c) => c.exerciseId))).map((e) => [e.id, e]),
  );

  const suggestions: ReplacementSuggestion[] = [];
  for (const c of combined) {
    const exercise = exercisesById.get(c.exerciseId);
    // Guarda defensiva: não deveria acontecer (o id veio da própria tabela
    // `exercises` na query anterior), mas degrada silenciosamente em vez de
    // quebrar a resposta inteira por um item.
    if (!exercise) continue;
    suggestions.push({
      exercise,
      tier: c.tier,
      label: labelFor(c, cautionAdvisory),
      usedBeforeBadge: c.signals.usedBefore,
      reason: buildReason(c, original.targetMuscle),
    });
  }

  logger.debug(
    { userId, originalExerciseId, cautionAdvisory, breakdown: combined },
    '[exercise-replacement] sugestões calculadas',
  );

  return { originalExerciseId, cautionAdvisory, suggestions };
}
