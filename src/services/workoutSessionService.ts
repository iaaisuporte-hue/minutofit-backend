import type { PoolClient } from 'pg';

import pool from '../config/database';
import { getReadinessLensToday } from '../modules/readiness/readiness.service';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';
import { applyGamificationCheckinTx, invalidateAfterCheckin, type MuscleGroup } from './gamificationService';
import { evaluateMilestones, type MilestoneAward } from '../modules/community/milestones.service';
import { evaluateChallengesAfterSession } from '../modules/community/challenges.service';
import {
  evaluateGoalsAfterSession,
  type GoalAchievement,
} from '../modules/performance/goals.service';
import { dayKey, APP_TIMEZONE } from '../utils/appDay';
import logger from '../lib/logger';
import { invalidarReadiness } from '../modules/readiness/v1/readiness.service';
import { computeSessionMetrics, resolveDurationMin } from '../modules/performance/sessionMetrics.engine';
import { FORMULA_VERSION } from '../modules/performance/performance.constants';
import type { MetricsSetInput } from '../modules/performance/performance.types';
import {
  buildPrCandidates,
  detectPrs,
  type PrKind,
  type PrSetInput,
} from '../modules/performance/pr.engine';
import {
  insertPrEvents,
  loadCurrentPrBests,
  lockPrDetection,
} from '../modules/performance/performance.repository';

/**
 * Recorde detectado, no formato que a resposta do registro de treino devolve.
 * Só o que a UI precisa para celebrar — nada de id de linha ou versão de fórmula.
 */
export interface PrDetectionResult {
  exerciseId: string;
  exerciseName: string;
  kind: PrKind;
  value: number;
  previousValue: number | null;
  /** Estreia da categoria: linha de base, não conquista. A UI não celebra. */
  isFirst: boolean;
}

// Grupos musculares aceitos em user_workout_logs.muscle_groups (paridade com o
// enum MuscleGroup da gamificação). Sanitizamos o que vem do cliente.
const VALID_MUSCLE_GROUPS = new Set<MuscleGroup>([
  'chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'full_body', 'cardio', 'mobility',
]);

function sanitizeMuscleGroups(input: unknown): MuscleGroup[] {
  if (!Array.isArray(input)) return ['full_body'];
  const clean = input.filter((g): g is MuscleGroup => typeof g === 'string' && VALID_MUSCLE_GROUPS.has(g as MuscleGroup));
  return clean.length > 0 ? Array.from(new Set(clean)) : ['full_body'];
}

// Camada de execução real do treino (Spec 010). Cria a sessão (cabeçalho) +
// séries (workout_set_logs) numa transação, derivando readiness/adaptação do
// dia no servidor. Append-only: histórico fechado não é alterado.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionSource = 'personal' | 'suggested' | 'academy' | 'free' | 'movement_lab' | 'user_retroactive';
export type SessionStatus = 'started' | 'completed' | 'partial' | 'abandoned';

/** Captura do Lab de Movimento para uma série (Spec 022). 1:1 com workout_set_logs. */
export interface SetCaptureInput {
  /** Reps que a IA contou antes de qualquer correção manual. */
  detectedReps?: number | null;
  /** true quando o aluno mexeu no número (reps_done ≠ detected_reps). */
  corrected?: boolean;
  avgFormScore?: number | null;
  avgSymmetry?: number | null;
  confidence?: string | null;
}

/** Item prescrito (snapshot) — usado p/ expandir séries quando não há detalhe. */
export interface PrescribedItem {
  exerciseId?: string | null;
  name: string;
  sets?: string | null;
  reps?: string | null;
  rest?: string | null;
  loadKg?: number | null;
}

/** Série executada (caminho detalhado). */
export interface SetLogInput {
  exerciseId?: string | null;
  name: string;
  orderIndex?: number;
  setIndex?: number;
  plannedReps?: string | null;
  repsDone?: number | null;
  plannedLoadKg?: number | null;
  loadDoneKg?: number | null;
  plannedRestS?: number | null;
  restDoneS?: number | null;
  rpe?: number | null;
  discomfort?: string | null;
  substitutedFromExerciseId?: string | null;
  substitutionReason?: string | null;
  status?: 'done' | 'skipped';
  /** Métricas do Lab de Movimento (Spec 022) — opcional; só no source movement_lab. */
  capture?: SetCaptureInput | null;
}

export interface CreateSessionInput {
  source: SessionSource;
  status: SessionStatus;
  title?: string | null;
  planId?: number | null;
  dayIndex?: number | null;
  sessionRpe?: number | null;
  notes?: string | null;
  /** Prescrito do dia — expandido em séries quando `sets` não vem. */
  prescribed?: PrescribedItem[];
  /** Séries detalhadas — quando o aluno informa carga/reps reais. */
  sets?: SetLogInput[];
  /**
   * Quando true e o status é completed/partial, o servidor grava o log raso
   * (user_workout_logs) + XP/streak na MESMA transação (P0-1). Substitui a
   * antiga segunda chamada do cliente a POST /gamification/checkins.
   */
  awardGamification?: boolean;
  /** Grupos musculares p/ o log raso — sanitizados; fallback ['full_body']. */
  muscleGroups?: string[];
  /**
   * Registro retroativo (Spec 024): data/hora real do treino. Ausente = agora
   * (fluxo ao vivo intacto). Quando anterior a hoje, a sessão é marcada como
   * retroativa (source='user_retroactive', is_retroactive=true) e readiness/
   * adaptação NÃO são vinculados (o snapshot é de hoje, não da data real).
   */
  performedAt?: Date | null;
  /** Motivo opcional do registro tardio (≤280). */
  retroactiveReason?: string | null;
  /** Aceite de honestidade do aluno — persistido para auditoria. */
  confirmationAccepted?: boolean;
  /**
   * Chave de idempotência gerada pelo cliente (Treino Livre). Única por aluno
   * (índice parcial da migration 1833). Necessária porque a sessão sem `planId`
   * não tem chave natural: sem ela, o retry de um POST que se perdeu na rede
   * vira um segundo treino no histórico.
   */
  clientKey?: string | null;
}

/** Normaliza a chave do cliente: string não vazia, ≤64. Qualquer outra coisa = null. */
export function sanitizeClientKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : null;
}

function leadingInt(v: unknown): number | null {
  if (v == null) return null;
  const m = String(v).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/** Conta séries a partir de "4" → 4, "3,3,4" → 3; clamp [1,12]. */
function parseSetCount(setsStr: unknown): number {
  if (setsStr == null) return 1;
  const s = String(setsStr).trim();
  if (s.includes(',')) return Math.min(12, Math.max(1, s.split(',').length));
  const n = leadingInt(s);
  return Math.min(12, Math.max(1, n ?? 1));
}

function safeUuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

function clampRpe(v: unknown): number | null {
  const n = leadingInt(v);
  if (n == null) return null;
  return Math.min(10, Math.max(1, n));
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Repetições: 0–999. As colunas de reps/descanso são `smallint` (teto 32767) e
 * `numOrNull` não tinha limite superior, então um dedo escorregando no campo do
 * Modo Treino (32768+) estourava o INSERT e derrubava a sessão INTEIRA com 500 —
 * o aluno terminava o treino e perdia tudo. Clampar é melhor que rejeitar: a
 * série já foi feita, e nenhum ser humano faz 1000 repetições.
 */
function clampReps(v: unknown): number | null {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.min(999, Math.round(n));
}

/** Segundos de descanso: 0–7200 (2h), dentro do smallint. */
function clampRestSeconds(v: unknown): number | null {
  const n = v == null ? null : leadingInt(v);
  if (n == null) return null;
  return Math.min(7200, Math.max(0, n));
}

/**
 * Carga: 0–9999.99 kg, o teto de `numeric(6,2)`. Acima disso o INSERT estourava
 * com 500 (mesma perda de sessão do clampReps). O recorde mundial de levantamento
 * fica em ~0,5 t, então o teto só corta erro de digitação.
 */
function clampLoadKg(v: unknown): number | null {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.min(9999.99, Math.round(n * 100) / 100);
}

/** 0–100 int ou null — para form score / simetria do Lab. */
function clampScore(v: unknown): number | null {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** reps detectadas: 0–1000 int ou null. */
function clampDetectedReps(v: unknown): number | null {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.min(1000, Math.max(0, Math.round(n)));
}

function sanitizeConfidence(v: unknown): string | null {
  return v === 'low' || v === 'medium' || v === 'high' ? v : null;
}

/** Linha mínima da sessão já existente que o replay precisa devolver. */
interface ExistingSessionRow {
  id: number;
  started_at: Date;
  performed_at: Date;
}

/**
 * Resposta de replay idempotente: a sessão já existe, devolvemos o resultado da
 * primeira tentativa em vez de erro. Serve às DUAS chaves de deduplicação — a
 * natural (aluno+ficha+dia) e a `client_key` do treino livre.
 *
 * Tudo o que é "conquista" volta vazio de propósito: recorde, meta e marco já
 * foram avaliados na sessão original, e repetir aqui só produziria uma segunda
 * celebração na tela para algo que já foi comemorado. `markGoalAchieved` nem
 * mudaria o banco — só afeta meta `active`.
 */
async function buildReplayResponse(
  client: PoolClient,
  userId: number,
  prev: ExistingSessionRow,
  isRetroactive: boolean,
) {
  const stats = await client.query(
    `SELECT xp, current_streak FROM user_gamification_stats WHERE user_id = $1`,
    [userId],
  );
  const setCount = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM workout_set_logs WHERE session_id = $1`,
    [prev.id],
  );
  return {
    id: Number(prev.id),
    startedAt: prev.started_at,
    performedAt: prev.performed_at,
    isRetroactive,
    countedForStreak: false,
    setCount: Number(setCount.rows[0]?.n ?? 0),
    streak: stats.rows[0] ? Number(stats.rows[0].current_streak ?? 0) : null,
    xp: stats.rows[0] ? Number(stats.rows[0].xp ?? 0) : null,
    duplicate: true,
    prEvents: [] as PrDetectionResult[],
    celebrate: false,
    goalsAchieved: [] as GoalAchievement[],
    milestonesUnlocked: [] as MilestoneAward[],
  };
}

export async function createSession(userId: number, academyId: number | null, input: CreateSessionInput) {
  const client = await pool.connect();
  /** Resultado da transação, lido DEPOIS que a conexão volta ao pool. */
  let fechado: {
    shouldInvalidate: boolean;
    resposta: {
      id: number;
      startedAt: Date;
      performedAt: Date;
      isRetroactive: boolean;
      countedForStreak: boolean;
      setCount: number;
      streak: number | null;
      xp: number | null;
      duplicate: false;
      prEvents: PrDetectionResult[];
      celebrate: boolean;
    };
  } | null = null;
  /** `performedAt` precisa sobreviver ao escopo do `try` para os hooks. */
  let performedAtParaHooks: Date = new Date();
  try {
    // Retroativo (Spec 024): data real vs hoje, em dias de calendário. diffDays:
    // 0 = hoje (fluxo normal); 1..3 = retro; <0 = futuro; >3 = fora da janela.
    // A rota já validou, mas revalidamos aqui (defesa em profundidade — o
    // serviço é chamado direto em testes).
    //
    // `todayKey` sai do fuso do ALUNO: com o dia em UTC, quem salvava um treino
    // às 22h (BRT) tinha "hoje" já virado, então o treino do próprio dia caía
    // como retroativo e era barrado por falta de `confirmedHonesty`.
    // `performedKey` continua em UTC de propósito: a data escolhida vem ancorada
    // ao meio-dia UTC pela rota, então toISOString() a devolve intacta.
    const now = new Date();
    const performedAt = input.performedAt ?? now;
    performedAtParaHooks = performedAt;
    const performedKey = input.performedAt
      ? performedAt.toISOString().slice(0, 10)
      : dayKey(now);
    const todayKey = dayKey(now);
    const utcMs = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    const diffDays = Math.round((utcMs(todayKey) - utcMs(performedKey)) / (24 * 60 * 60 * 1000));
    if (diffDays < 0) {
      const err = new Error('performed_at is in the future');
      (err as { code?: string }).code = 'PERFORMED_AT_IN_FUTURE';
      throw err;
    }
    if (diffDays > 3) {
      const err = new Error('performed_at is older than the retro window');
      (err as { code?: string }).code = 'RETRO_WINDOW_EXCEEDED';
      throw err;
    }
    const isRetroactive = diffDays >= 1;
    // O servidor stampa a natureza retroativa; a origem do conteúdo (ficha/
    // sugerido/avulso) permanece em plan_id/prescribed_snapshot/muscle_groups.
    const storedSource: SessionSource = isRetroactive ? 'user_retroactive' : input.source;

    await client.query('BEGIN');

    // ── Idempotência explícita por chave do cliente (Treino Livre) ──────────
    // A dedup por chave natural logo abaixo depende de `plan_id`. O treino
    // livre não tem ficha, então nada distinguia "o aluno treinou duas vezes
    // hoje" de "o POST foi reenviado depois de um timeout" — e a segunda leitura
    // é a comum no celular. `client_key` resolve isso pela origem: o cliente
    // gera a chave uma vez por execução e a repete no retry.
    //
    // O advisory lock vem ANTES do SELECT pelo mesmo motivo do bloco seguinte:
    // sem ele, dois POSTs simultâneos passam limpos pela leitura e ambos
    // inserem. Aqui daria para deixar o UNIQUE parcial (migration 1833) barrar,
    // mas a violação abortaria a transação inteira — e recuperar disso exigiria
    // SAVEPOINT ou uma segunda transação. Serializar antes é mais simples e
    // deixa o índice como rede de segurança, não como fluxo de controle.
    const clientKey = sanitizeClientKey(input.clientKey);
    if (clientKey) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `free-session:${userId}:${clientKey}`,
      ]);
      const existing = await client.query(
        `SELECT id, started_at, performed_at
           FROM workout_sessions
          WHERE user_id = $1 AND client_key = $2
          LIMIT 1`,
        [userId, clientKey],
      );
      if (existing.rows.length > 0) {
        const prev = existing.rows[0] as ExistingSessionRow;
        const replay = await buildReplayResponse(client, userId, prev, isRetroactive);
        await client.query('COMMIT');
        logger.info(
          { userId, clientKey, sessionId: prev.id },
          '[training] reenvio com a mesma client_key — devolvendo a sessão existente',
        );
        return replay;
      }
    }

    // ── Idempotência da conclusão (QA final 02/ago/2026) ────────────────────
    // A guarda de duplo envio era só de UI, e `registeredToday` nasce `false` a
    // cada montagem do componente: recarregar a página, abrir numa segunda aba
    // ou terminar o mesmo treino em outro aparelho criava uma SEGUNDA sessão e
    // somava 30 XP de novo (medido: 30 → 60). Aderência/frequência não infla
    // (as queries contam `COUNT(DISTINCT day)`), mas o histórico do aluno
    // passava a listar o mesmo treino duas vezes e o XP virava ficção.
    //
    // Chave natural: aluno + ficha + dia da ficha + DIA DO ALUNO (fuso do app,
    // não UTC). O reenvio devolve a sessão que já existe — semântica de replay
    // idempotente, não erro: o cliente que perdeu a resposta por rede recebe o
    // mesmo resultado da primeira tentativa.
    //
    // O advisory lock (transacional, liberado no COMMIT/ROLLBACK) serializa duas
    // requisições simultâneas com a mesma chave — sem ele o SELECT abaixo passa
    // limpo nos dois e ambas inserem. Não dá para trocar por UNIQUE INDEX: a
    // conversão de fuso (`AT TIME ZONE`) é STABLE, não IMMUTABLE, e o Postgres
    // recusa a expressão num índice.
    //
    // Escopo: só sessões ligadas a uma ficha (`planId`) e efetivamente
    // treinadas. Avulso/tracker/Lab não têm chave natural — e o Lab já grava com
    // `awardGamification: false`, então não há XP em jogo.
    const dedupable =
      input.planId != null && (input.status === 'completed' || input.status === 'partial');
    if (dedupable) {
      const idemKey = `workout-session:${userId}:${input.planId}:${input.dayIndex ?? -1}:${performedKey}`;
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [idemKey]);

      const existing = await client.query(
        `SELECT id, started_at, performed_at
           FROM workout_sessions
          WHERE user_id = $1
            AND plan_id = $2
            AND day_index IS NOT DISTINCT FROM $3
            AND status IN ('completed', 'partial')
            AND (started_at AT TIME ZONE $4)::date = $5::date
          ORDER BY id ASC
          LIMIT 1`,
        [userId, input.planId, input.dayIndex ?? null, APP_TIMEZONE, performedKey],
      );

      if (existing.rows.length > 0) {
        const prev = existing.rows[0] as ExistingSessionRow;
        const replay = await buildReplayResponse(client, userId, prev, isRetroactive);
        await client.query('COMMIT');
        logger.info(
          { userId, planId: input.planId, dayIndex: input.dayIndex, sessionId: prev.id },
          '[training] reenvio da mesma conclusão — devolvendo a sessão existente',
        );
        return replay;
      }
    }

    // Deriva personal (quando há plano). Adaptação/readiness só no fluxo ao vivo:
    // no retroativo o snapshot de readiness é de hoje, não da data real — não vincular.
    let personalId: number | null = null;
    let adaptationLogId: number | null = null;
    let readinessLevel: string | null = null;
    if (input.planId) {
      const plan = await client.query(`SELECT personal_id FROM personal_workout_plans WHERE id = $1`, [input.planId]);
      personalId = plan.rows[0]?.personal_id ?? null;
      if (!isRetroactive && input.dayIndex != null) {
        const adap = await client.query(
          `SELECT id FROM workout_adaptation_log
           WHERE student_id = $1 AND plan_id = $2 AND day_index = $3 AND snapshot_date = CURRENT_DATE
           LIMIT 1`,
          [userId, input.planId, input.dayIndex],
        );
        adaptationLogId = adap.rows[0]?.id ?? null;
      }
    }

    if (!isRetroactive) {
      try {
        const r = await getReadinessLensToday(userId);
        readinessLevel = r?.level ?? null;
      } catch {
        readinessLevel = null;
      }
    }

    const prescribed = Array.isArray(input.prescribed) ? input.prescribed : [];

    const header = await client.query(
      `INSERT INTO workout_sessions
         (user_id, academy_id, personal_id, source, plan_id, day_index, adaptation_log_id,
          readiness_level, prescribed_snapshot, status, session_rpe, title, started_at, ended_at, notes,
          performed_at, is_retroactive, retroactive_reason, confirmation_accepted, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id, started_at, performed_at`,
      [
        userId,
        academyId,
        personalId,
        storedSource,
        input.planId ?? null,
        input.dayIndex ?? null,
        adaptationLogId,
        readinessLevel,
        JSON.stringify(prescribed),
        input.status,
        clampRpe(input.sessionRpe),
        input.title ?? null,
        // Retro: started_at = data real (todos os leitores usam started_at).
        performedAt,
        input.status === 'started' ? null : performedAt,
        input.notes ?? null,
        performedAt,
        isRetroactive,
        input.retroactiveReason ? String(input.retroactiveReason).slice(0, 280) : null,
        input.confirmationAccepted === true,
        clientKey,
      ],
    );
    const sessionId: number = header.rows[0].id;

    // Linhas de série: detalhado (input.sets) tem prioridade; senão expande o prescrito.
    const rows: SetLogInput[] = [];
    if (Array.isArray(input.sets) && input.sets.length > 0) {
      rows.push(...input.sets);
    } else {
      prescribed.forEach((item, orderIndex) => {
        const count = parseSetCount(item.sets);
        for (let s = 1; s <= count; s++) {
          rows.push({
            exerciseId: item.exerciseId ?? null,
            name: item.name,
            orderIndex,
            setIndex: s,
            plannedReps: item.reps ?? null,
            plannedLoadKg: item.loadKg ?? null,
            plannedRestS: leadingInt(item.rest),
            status: 'done',
          });
        }
      });
    }

    // `safeUuid` só valida FORMATO. Um UUID bem-formado que não existe em
    // `exercises` passava direto e explodia na FK de workout_set_logs → 500, com
    // a sessão inteira perdida. Resolvemos quais IDs existem de fato e zeramos os
    // órfãos: a série continua registrada (o nome do exercício é preservado na
    // própria linha), só perde o vínculo com a biblioteca. Melhor do que
    // devolver 400 e descartar um treino que o aluno acabou de fazer.
    const candidateIds = Array.from(
      new Set(
        rows
          .flatMap((r) => [safeUuid(r.exerciseId), safeUuid(r.substitutedFromExerciseId)])
          .filter((id): id is string => id !== null),
      ),
    );
    let knownExerciseIds = new Set<string>();
    if (candidateIds.length > 0) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM exercises WHERE id = ANY($1::uuid[])`,
        [candidateIds],
      );
      knownExerciseIds = new Set(found.rows.map((row) => row.id));
      if (knownExerciseIds.size !== candidateIds.length) {
        logger.warn(
          {
            userId,
            missing: candidateIds.filter((id) => !knownExerciseIds.has(id)),
          },
          '[training] sessão referencia exercício inexistente — vínculo zerado',
        );
      }
    }
    const knownUuid = (v: unknown): string | null => {
      const id = safeUuid(v);
      return id && knownExerciseIds.has(id) ? id : null;
    };

    // Espelho do que foi REALMENTE gravado (já sanitizado) — alimenta as
    // métricas da sessão sem uma segunda leitura do banco. Métrica derivada de
    // valor pré-clamp divergiria da série persistida.
    const persistedSets: MetricsSetInput[] = [];
    // O mesmo espelho, com o vínculo de exercício resolvido, para a detecção
    // de recordes (P2). Séries sem exercício conhecido não entram: sem vínculo
    // não há histórico contra o que comparar.
    const persistedPrSets: PrSetInput[] = [];

    for (const r of rows) {
      const repsDone = clampReps(r.repsDone);
      const loadDoneKg = clampLoadKg(r.loadDoneKg);
      const setRpe = clampRpe(r.rpe);
      const setStatus: 'done' | 'skipped' = r.status === 'skipped' ? 'skipped' : 'done';
      const resolvedExerciseId = knownUuid(r.exerciseId);
      persistedSets.push({ repsDone, loadDoneKg, rpe: setRpe, status: setStatus });
      persistedPrSets.push({
        exerciseId: resolvedExerciseId,
        exerciseName: String(r.name ?? '').slice(0, 200) || '—',
        repsDone,
        loadDoneKg,
        status: setStatus,
      });

      const setLog = await client.query(
        `INSERT INTO workout_set_logs
           (session_id, exercise_id, exercise_name, order_index, set_index,
            planned_reps, reps_done, planned_load_kg, load_done_kg, planned_rest_s, rest_done_s,
            rpe, discomfort, substituted_from_exercise_id, substitution_reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          sessionId,
          resolvedExerciseId,
          String(r.name ?? '').slice(0, 200) || '—',
          r.orderIndex ?? 0,
          r.setIndex ?? 1,
          r.plannedReps ?? null,
          repsDone,
          clampLoadKg(r.plannedLoadKg),
          loadDoneKg,
          clampRestSeconds(r.plannedRestS),
          clampRestSeconds(r.restDoneS),
          setRpe,
          r.discomfort ? String(r.discomfort).slice(0, 280) : null,
          knownUuid(r.substitutedFromExerciseId),
          r.substitutionReason ? String(r.substitutionReason).slice(0, 280) : null,
          setStatus,
        ],
      );

      // Captura do Lab (Spec 022) — só quando a série vem do modo guiado.
      if (r.capture && typeof r.capture === 'object') {
        const c = r.capture;
        await client.query(
          `INSERT INTO workout_set_capture
             (set_log_id, detected_reps, corrected, avg_form_score, avg_symmetry, confidence)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (set_log_id) DO NOTHING`,
          [
            setLog.rows[0].id,
            clampDetectedReps(c.detectedReps),
            c.corrected === true,
            clampScore(c.avgFormScore),
            clampScore(c.avgSymmetry),
            sanitizeConfidence(c.confidence),
          ],
        );
      }
    }

    // ── Métricas da sessão (Spec 033, P1) ───────────────────────────────────
    // Mesma transação da execução, pelo mesmo motivo do write-through de
    // gamificação: métrica que pode faltar é métrica em que não se confia. Se a
    // sessão entra, a métrica entra; se a transação cai, não sobra linha órfã.
    //
    // Só sessões efetivamente treinadas — 'started'/'abandoned' não descrevem
    // execução. `computeSessionMetrics` devolve null quando nenhuma série foi
    // realizada, e aí nenhuma linha é criada: métrica zerada seria zero
    // artificial contaminando qualquer média futura.
    if (input.status === 'completed' || input.status === 'partial') {
      const metrics = computeSessionMetrics(persistedSets, {
        sessionRpe: clampRpe(input.sessionRpe),
        // Neste ramo o status é completed/partial, então `ended_at` foi gravado
        // como `performedAt` (ver INSERT do cabeçalho) — as duas pontas são as
        // mesmas que estão no banco.
        durationMin: resolveDurationMin(
          header.rows[0].started_at ? new Date(header.rows[0].started_at) : null,
          performedAt,
          isRetroactive,
        ),
      });
      if (metrics) {
        await client.query(
          `INSERT INTO workout_session_metrics
             (session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg,
              duration_min, srpe, effort_load, effort_load_method, formula_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            sessionId,
            userId,
            header.rows[0].performed_at,
            metrics.setsDone,
            metrics.repsTotal,
            metrics.tonnageKg,
            metrics.durationMin,
            metrics.srpe,
            metrics.effortLoad,
            metrics.effortLoadMethod,
            FORMULA_VERSION,
          ],
        );
      }
    }

    // ── Detecção de recordes (Spec 033, P2) ─────────────────────────────────
    // Mesma transação da execução: um PR é consequência do treino, não um
    // efeito colateral que pode faltar. Se a sessão entra, o recorde entra.
    //
    // Ordem importa: o advisory lock por usuário vem ANTES da leitura dos
    // melhores atuais, senão duas sessões simultâneas do mesmo aluno leriam o
    // mesmo histórico e a segunda gravaria `previous_value` desatualizado.
    //
    // Idempotência tem duas camadas. A primeira é o replay de conclusão, que
    // retorna lá em cima sem chegar aqui. A segunda é a própria natureza do
    // recorde: reenviar a mesma sessão produz candidatos idênticos, que não
    // superam o recorde que eles mesmos criaram — `detectPrs` exige melhora
    // ESTRITA. O `ON CONFLICT` do INSERT é a terceira, para o caso de corrida
    // que escape do lock.
    const prEvents: PrDetectionResult[] = [];
    if (input.status === 'completed' || input.status === 'partial') {
      const candidates = buildPrCandidates(persistedPrSets);
      if (candidates.length > 0) {
        await lockPrDetection(client, userId);
        const exerciseIds = Array.from(new Set(candidates.map((c) => c.exerciseId)));
        const bests = await loadCurrentPrBests(client, userId, exerciseIds);
        const detections = detectPrs(candidates, bests);
        if (detections.length > 0) {
          await insertPrEvents(client, userId, sessionId, header.rows[0].performed_at, detections);
          for (const d of detections) {
            prEvents.push({
              exerciseId: d.exerciseId,
              exerciseName: d.exerciseName,
              kind: d.kind,
              value: d.value,
              previousValue: d.previousValue,
              isFirst: d.isFirst,
            });
          }
        }
      }
    }

    // Write-through de gamificação (P0-1): log raso + XP/streak na MESMA
    // transação da execução rica. Só sessões efetivamente treinadas contam —
    // 'started'/'abandoned' não geram XP nem streak.
    //
    // Retroativo (Spec 024): D-0/D-1 recebem streak+XP na data real (o motor de
    // streak nunca regride a âncora); D-2/D-3 contam só para histórico/aderência
    // (grava user_workout_logs com completed_at real, sem check-in/streak/XP —
    // anti-farming). A dedup por dia distinto no score metabólico já evita dupla
    // contagem quando há log raso + sessão na mesma data.
    let shouldInvalidate = false;
    let countedForStreak = false;
    let streak: number | null = null;
    let xp: number | null = null;
    // Sessão sem nenhum conteúdo não vale streak nem XP. Antes, um POST com
    // `prescribed: []` e `sets: []` devolvia 201 com XP 60 e sequência contada —
    // dava para inflar streak sem treinar, e o volume falso ainda entrava no
    // score metabólico. `rows` já cobre os dois caminhos (séries detalhadas ou
    // expandidas do prescrito), então basta exigir que exista ao menos uma.
    const hasContent = rows.length > 0;
    if (input.awardGamification && !hasContent) {
      logger.info({ userId, sessionId }, '[training] sessão sem exercícios — XP/streak não concedidos');
    }
    if (input.awardGamification && hasContent && (input.status === 'completed' || input.status === 'partial')) {
      if (diffDays <= 1) {
        await applyGamificationCheckinTx(client, {
          userId,
          academyId,
          source: 'workout',
          sessionId,
          dateKey: isRetroactive ? performedKey : undefined,
          completedAt: isRetroactive ? performedAt : undefined,
          workout: {
            workoutId: `session-${sessionId}`,
            title: input.title ?? 'Treino',
            muscleGroups: sanitizeMuscleGroups(input.muscleGroups),
          },
        });
        const stats = await client.query(
          `SELECT xp, current_streak FROM user_gamification_stats WHERE user_id = $1`,
          [userId],
        );
        streak = Number(stats.rows[0]?.current_streak ?? 0);
        xp = Number(stats.rows[0]?.xp ?? 0);
        countedForStreak = true;
        shouldInvalidate = true;
      } else {
        // D-2/D-3: histórico + aderência, sem check-in diário (streak/XP intactos).
        await client.query(
          `INSERT INTO user_workout_logs (user_id, academy_id, workout_id, title, muscle_groups, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            academyId,
            `session-${sessionId}`,
            input.title ?? 'Treino',
            sanitizeMuscleGroups(input.muscleGroups),
            performedAt,
          ],
        );
        shouldInvalidate = true;
      }
    }

    await client.query('COMMIT');

    // A transação acabou aqui. O que vem depois é ACESSÓRIO e roda FORA deste
    // bloco, com a conexão já devolvida ao pool — ver o comentário do
    // `finally` logo abaixo.
    fechado = {
      shouldInvalidate,
      resposta: {
        id: sessionId,
        startedAt: header.rows[0].started_at,
        performedAt: header.rows[0].performed_at,
        isRetroactive,
        countedForStreak,
        setCount: rows.length,
        streak,
        xp,
        duplicate: false,
        prEvents,
        // Recorde de sessão retroativa é real e fica gravado, mas não vira
        // festa: celebrar um treino de três dias atrás como se fosse agora
        // premia o registro tardio, não o esforço.
        celebrate: !isRetroactive && prEvents.some((p) => !p.isFirst),
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // A conexão volta ao pool ANTES das avaliações acessórias.
    //
    // Antes elas rodavam dentro deste `try`, e o `release()` só acontecia
    // depois delas: cada POST de treino segurava uma conexão E pedia outra
    // (metas, marcos e desafios abrem transação própria). Com o pool no
    // default, requisições simultâneas suficientes prendiam todas as conexões
    // em transações JÁ COMMITADAS enquanto esperavam por mais uma — o
    // auto-deadlock clássico de pool, que sem timeout vira travamento em vez
    // de erro.
    //
    // Tirar os hooks daqui torna a garantia ESTRUTURAL: não existe caminho em
    // que eles rodem com a conexão da transação na mão, porque eles estão
    // fora do escopo dela.
    client.release();
  }

  // Guarda impossível na prática: ou o `try` retornou cedo (replay), ou
  // atribuiu `fechado`, ou lançou. Existe para o TypeScript e para o dia em
  // que alguém adicionar um caminho novo lá dentro.
  if (!fechado) throw new Error('createSession: transação encerrada sem resultado');

  /* ---------------------------------------------------------------- *
   * Pós-COMMIT — conexão já liberada, cada hook abre a sua
   * ---------------------------------------------------------------- */

  // Invalidações fora da transação (nunca dentro do COMMIT).
  if (fechado.shouldInvalidate) invalidateAfterCheckin(userId);

  // Prontidão (SPEC Mobile P3 §58): um treino concluído muda a carga recente e
  // a recuperação muscular, então o snapshot do dia deixou de valer. Apaga em
  // vez de recalcular na hora — recalcular aqui acoplaria a gravação da sessão
  // ao motor de prontidão, e uma falha lá derrubaria um treino já commitado.
  // O próximo GET reconstrói.
  void invalidarReadiness(userId).catch((err) => {
    logger.warn({ err, userId, hook: 'readiness' }, '[training] invalidação de prontidão falhou — treino preservado');
  });

  // Metas só podem ser avaliadas AQUI, depois do COMMIT: elas leem
  // `workout_set_logs` e `user_pr_events`, que só existem para outra conexão
  // depois que esta transação fecha. Avaliar antes leria o estado anterior ao
  // treino — o aluno bateria os 100 kg e a meta de 100 kg continuaria aberta
  // até o treino seguinte.
  //
  // Os três `.catch` abaixo são a mesma lei: o treino JÁ ESTÁ COMMITADO, e
  // nenhuma falha de trabalho derivado pode virar 500 numa sessão gravada.
  // Cada serviço já engole os próprios erros; o catch aqui cobre o que
  // escapar — inclusive a falha de OBTER CONEXÃO, que é o modo de falha que
  // este hardening endereça. Todos têm recuperação por leitura.
  const goalsAchieved = await evaluateGoalsAfterSession(userId, performedAtParaHooks).catch(
    (err) => {
      logger.warn(
        { err, userId, hook: 'goals' },
        '[training] avaliação pós-COMMIT falhou — treino preservado',
      );
      return [] as GoalAchievement[];
    },
  );

  const milestonesUnlocked = await evaluateMilestones(userId).catch((err) => {
    logger.warn(
      { err, userId, hook: 'milestones' },
      '[training] avaliação pós-COMMIT falhou — treino preservado',
    );
    return [] as MilestoneAward[];
  });

  await evaluateChallengesAfterSession(userId).catch((err) => {
    logger.warn(
      { err, userId, hook: 'challenges' },
      '[training] avaliação pós-COMMIT falhou — treino preservado',
    );
  });

  return { ...fechado.resposta, goalsAchieved, milestonesUnlocked };
}

export async function listSessions(userId: number, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, source, plan_id, day_index, readiness_level, status, session_rpe,
            title, started_at, ended_at, performed_at, is_retroactive,
            (SELECT COUNT(*) FROM workout_set_logs sl WHERE sl.session_id = ws.id AND sl.status = 'done') AS sets_done
       FROM workout_sessions ws
      WHERE user_id = $1
      ORDER BY performed_at DESC
      LIMIT $2`,
    [userId, Math.min(200, Math.max(1, limit))],
  );
  return rows;
}

/** Cursor keyset: instante + id, o par que ordena de forma determinística. */
export interface SessionCursor {
  performedAt: string;
  id: number;
}

/**
 * Serializa o cursor como `<ISO>_<id>`.
 *
 * O id é indispensável: `performed_at` NÃO é único — o registro retroativo
 * ancora a data ao meio-dia UTC, então duas sessões retroativas do mesmo dia têm
 * o MESMO instante. Paginar só por timestamp puralaria ou repetiria essas
 * sessões na fronteira entre páginas.
 */
export function encodeSessionCursor(performedAt: string | Date, id: number): string {
  const iso = performedAt instanceof Date ? performedAt.toISOString() : new Date(performedAt).toISOString();
  return `${iso}_${id}`;
}

/** Decodifica o cursor. `null` para qualquer entrada malformada — nunca lança. */
export function decodeSessionCursor(raw: unknown): SessionCursor | null {
  if (typeof raw !== 'string') return null;
  const sep = raw.lastIndexOf('_');
  if (sep <= 0) return null;
  const iso = raw.slice(0, sep);
  const id = Number(raw.slice(sep + 1));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return null;
  return { performedAt: ts.toISOString(), id };
}

/**
 * Página do histórico por keyset (Spec 033, P1).
 *
 * Substitui o offset/limite simples porque o Histórico virou aba de primeira
 * classe e o teto de 200 do `listSessions` trava um aluno com mais de um ano de
 * treino. Keyset também não sofre o deslocamento clássico do OFFSET: uma sessão
 * registrada entre duas páginas não faz a próxima repetir ou pular linha.
 *
 * Ordenação `(performed_at DESC, id DESC)` — o par é único, então a ordem é
 * total e o cursor é sempre reencontrável.
 */
export async function listSessionsPage(
  userId: number,
  limit: number,
  before: SessionCursor | null,
): Promise<{ sessions: Record<string, unknown>[]; nextCursor: string | null }> {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const params: unknown[] = [userId];
  let keysetClause = '';
  if (before) {
    // Tupla comparada como tupla: pega tudo estritamente "depois" do cursor na
    // ordenação decrescente, incluindo empates de instante com id menor.
    params.push(before.performedAt, before.id);
    keysetClause = ` AND (ws.performed_at, ws.id) < ($2::timestamptz, $3::int)`;
  }
  params.push(safeLimit + 1); // +1 sonda se existe próxima página

  const { rows } = await pool.query(
    `SELECT ws.id, ws.source, ws.plan_id, ws.day_index, ws.readiness_level, ws.status,
            ws.session_rpe, ws.title, ws.started_at, ws.ended_at, ws.performed_at,
            ws.is_retroactive,
            (SELECT COUNT(*) FROM workout_set_logs sl
              WHERE sl.session_id = ws.id AND sl.status = 'done') AS sets_done
       FROM workout_sessions ws
      WHERE ws.user_id = $1${keysetClause}
      ORDER BY ws.performed_at DESC, ws.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > safeLimit;
  const sessions = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = sessions[sessions.length - 1];
  return {
    sessions,
    nextCursor: hasMore && last ? encodeSessionCursor(last.performed_at, Number(last.id)) : null,
  };
}

/**
 * Estatísticas de execução (Spec 010 V1.1): frequência + progressão de carga.
 *
 * Duas correções da Spec 033 (P1) aqui:
 *
 * 1. Datas saem de `performed_at`, não de `started_at`. `performed_at` é a data
 *    canônica da execução desde a migration 1813 — é ela que a aderência, o
 *    histórico e o dashboard do personal já usam. Hoje os dois valores coincidem
 *    porque o serviço grava `started_at = performed_at`, então a correção não
 *    muda número nenhum; ela impede que estas contas divirjam do resto do
 *    produto no dia em que existir um "iniciar treino" de verdade.
 *
 * 2. O dia e a semana são os do ALUNO, não os do servidor. `date_trunc` e
 *    `::date` resolvem no fuso da sessão do Postgres (UTC na Render), então o
 *    treino das 21h30 de domingo (BRT) caía na segunda — e na SEMANA seguinte,
 *    zerando o contador "esta semana" de quem acabou de treinar. É a mesma
 *    classe de defeito que `utils/appDay.ts` foi criado para corrigir.
 */
export async function getWorkoutStats(userId: number) {
  const freq = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (
         WHERE (performed_at AT TIME ZONE $2)::date
               >= date_trunc('week', (now() AT TIME ZONE $2))::date
       )::int AS this_week,
       COUNT(*) FILTER (
         WHERE (performed_at AT TIME ZONE $2)::date
               > ((now() AT TIME ZONE $2)::date - 30)
       )::int AS last_30d
     FROM workout_sessions
     WHERE user_id = $1 AND status IN ('completed', 'partial')`,
    [userId, APP_TIMEZONE],
  );

  // Progressão de carga por exercício: MAX(carga) por dia, só onde há carga.
  const prog = await pool.query(
    `SELECT sl.exercise_id,
            MIN(sl.exercise_name) AS exercise_name,
            (ws.performed_at AT TIME ZONE $2)::date AS d,
            MAX(sl.load_done_kg) AS max_load
       FROM workout_set_logs sl
       JOIN workout_sessions ws ON ws.id = sl.session_id
      WHERE ws.user_id = $1 AND sl.load_done_kg IS NOT NULL AND sl.exercise_id IS NOT NULL
      GROUP BY sl.exercise_id, (ws.performed_at AT TIME ZONE $2)::date
      ORDER BY sl.exercise_id, d`,
    [userId, APP_TIMEZONE],
  );

  const byExercise = new Map<string, { exerciseId: string; name: string; points: { date: string; maxLoadKg: number }[] }>();
  for (const r of prog.rows) {
    const key = r.exercise_id;
    if (!byExercise.has(key)) byExercise.set(key, { exerciseId: key, name: r.exercise_name, points: [] });
    byExercise.get(key)!.points.push({ date: r.d, maxLoadKg: Number(r.max_load) });
  }
  // Um ponto basta para "qual foi minha última carga"; dois são necessários só
  // para a reta da progressão. O filtro `>= 2` daqui apagava o chip
  // "última: X kg" e o "Comparado à última vez" de quem tinha um único dia de
  // histórico — o app dizia "1ª vez" para um exercício registrado ontem (QA em
  // navegador, ago/2026). Com um ponto só, `firstLoadKg === lastLoadKg` e
  // `deltaKg` sai 0 por construção: não houve ganho nem queda, e quem desenha
  // tendência decide pelo `points.length`. Ordena por maior ganho.
  const exerciseProgression = Array.from(byExercise.values())
    .map((e) => ({
      ...e,
      firstLoadKg: e.points[0].maxLoadKg,
      lastLoadKg: e.points[e.points.length - 1].maxLoadKg,
      deltaKg: e.points[e.points.length - 1].maxLoadKg - e.points[0].maxLoadKg,
    }))
    .sort((a, b) => b.deltaKg - a.deltaKg);

  return {
    totalSessions: freq.rows[0].total,
    thisWeek: freq.rows[0].this_week,
    last30Days: freq.rows[0].last_30d,
    exerciseProgression,
  };
}

/**
 * Resumo de execução de um aluno para o cockpit do personal (Spec 010 V1.1).
 * Aderência real = séries feitas ÷ séries prescritas (do snapshot), sobre as
 * últimas sessões. Consent('workouts') é aplicado na rota, MAS consent não é
 * vínculo: um consent não revogado após o fim do acompanhamento deixaria o
 * personal lendo execução de quem não é mais seu aluno. Exigimos também o
 * assignment ATIVO (P0-2 da auditoria) — mesma convenção de
 * `listPersonalWorkoutPlans`.
 */
export async function getStudentExecutionSummary(personalId: number, studentId: number, limit = 8) {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT ws.id, ws.started_at, ws.performed_at, ws.is_retroactive, ws.created_at,
            ws.status, ws.source, ws.readiness_level, ws.prescribed_snapshot,
            (SELECT COUNT(*) FROM workout_set_logs sl WHERE sl.session_id = ws.id AND sl.status = 'done')::int AS sets_done
       FROM workout_sessions ws
      WHERE ws.user_id = $1 AND ws.status IN ('completed', 'partial')
      ORDER BY ws.performed_at DESC
      LIMIT $2`,
    [studentId, Math.min(30, Math.max(1, limit))],
  );

  // Desconforto relatado pelo aluno (P1-3) por sessão — quais movimentos
  // incomodaram. Dá visibilidade ao personal do sinal de recuperação.
  const sessionIds = rows.map((r) => r.id);
  const discomfortMap = new Map<number, string[]>();
  if (sessionIds.length > 0) {
    const dq = await pool.query(
      `SELECT session_id, ARRAY_AGG(DISTINCT exercise_name) AS names
         FROM workout_set_logs
        WHERE session_id = ANY($1) AND discomfort IS NOT NULL
        GROUP BY session_id`,
      [sessionIds],
    );
    for (const r of dq.rows) discomfortMap.set(Number(r.session_id), r.names ?? []);
  }

  let totalDone = 0;
  let totalPrescribed = 0;
  const sessions = rows.map((r) => {
    const presc = Array.isArray(r.prescribed_snapshot) ? r.prescribed_snapshot : [];
    const prescribedSets = presc.reduce((acc: number, it: { sets?: string }) => acc + parseSetCount(it?.sets), 0);
    // Só sessão COM prescrição entra na conta. A métrica responde "das séries
    // que o personal prescreveu, quantas o aluno fez" — sessão sem nenhuma
    // série prescrita não tem o que responder, e somar `setsDone` no numerador
    // contra zero no denominador é erro de aritmética, não de arredondamento:
    // a aderência passava de 100% e o aluno que treinava por conta própria
    // aparecia como mais aderente do que o plano permite.
    //
    // `prescribedSets > 0` — e não `plan_id != null` — porque a sessão do Lab
    // guiado (Spec 022) chega com `plan_id` preenchido e snapshot vazio: é
    // análise de UM exercício, não execução da ficha do dia. As duas continuam
    // na lista abaixo com o próprio `source`; o personal precisa vê-las.
    if (prescribedSets > 0) {
      totalDone += r.sets_done;
      totalPrescribed += prescribedSets;
    }
    return {
      id: r.id,
      // Data real do treino (retro usa performed_at); createdAt desambigua quando
      // o registro foi feito depois do dia (o personal não confunde com tempo real).
      date: r.performed_at,
      createdAt: r.created_at,
      isRetroactive: r.is_retroactive === true,
      status: r.status,
      source: r.source,
      readinessLevel: r.readiness_level,
      setsDone: r.sets_done,
      prescribedSets,
      discomfortExercises: discomfortMap.get(r.id) ?? [],
    };
  });

  // Teto em 100: séries extras dentro da própria ficha (o aluno que faz a 5ª
  // série de um exercício de 4) são bem-vindas, mas "115% de aderência" é
  // número que não quer dizer nada na tela do personal.
  const adherencePct =
    totalPrescribed > 0 ? Math.min(100, Math.round((totalDone / totalPrescribed) * 100)) : null;

  const freq = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE performed_at >= now() - interval '7 days')::int AS last_7d,
            COUNT(*)::int AS total
       FROM workout_sessions
      WHERE user_id = $1 AND status IN ('completed', 'partial')`,
    [studentId],
  );

  return { adherencePct, last7d: freq.rows[0].last_7d, total: freq.rows[0].total, sessions };
}

/**
 * Últimas execuções de UM exercício (SPEC P1 §27 — histórico rápido).
 *
 * Serve a pergunta que a pessoa faz no meio do treino: "quanto eu levantei da
 * última vez, e antes disso?". A alternativa no cliente seria baixar as N
 * últimas sessões inteiras e filtrar — N+1 requisições e muito payload para
 * três linhas, com o aparelho na mão entre duas séries.
 *
 * Uma linha por SESSÃO, não por série: `MAX(load)` e as repetições feitas
 * naquela carga é o par que informa a decisão. Escopado por `user_id` — o
 * `exerciseId` vem da URL e não pode virar leitura do histórico alheio.
 */
export async function getExerciseHistory(
  userId: number,
  exerciseId: string,
  limit = 3,
): Promise<{ date: string; loadKg: number | null; reps: number | null; sets: number }[]> {
  const { rows } = await pool.query(
    // `::date` volta como objeto Date no driver do pg, e `String(...)` no
    // cliente virava "Wed Sep 02 2026 00:00:00 GMT-0300" na tela. `to_char`
    // devolve texto ISO já no fuso do aluno — sem reinterpretação em lugar
    // nenhum do caminho (achado do QA P3, regressão da P1 §27).
    `SELECT to_char((ws.performed_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS d,
            MAX(sl.load_done_kg)                    AS max_load,
            COUNT(*) FILTER (WHERE sl.status = 'done')::int AS sets,
            -- reps da série mais pesada: é a que a pessoa quer comparar
            (ARRAY_AGG(sl.reps_done ORDER BY sl.load_done_kg DESC NULLS LAST, sl.set_index))[1] AS reps
       FROM workout_set_logs sl
       JOIN workout_sessions ws ON ws.id = sl.session_id
      WHERE ws.user_id = $1
        AND sl.exercise_id = $2
        AND sl.status = 'done'
        AND ws.status IN ('completed', 'partial')
      GROUP BY ws.id, (ws.performed_at AT TIME ZONE $3)::date
      ORDER BY MAX(ws.performed_at) DESC
      LIMIT $4`,
    [userId, exerciseId, APP_TIMEZONE, Math.min(Math.max(1, limit), 10)],
  );

  return rows.map((r) => ({
    date: String(r.d),
    loadKg: r.max_load == null ? null : Number(r.max_load),
    reps: r.reps == null ? null : Number(r.reps),
    sets: Number(r.sets ?? 0),
  }));
}

export async function getSession(userId: number, sessionId: number) {
  const head = await pool.query(`SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  if (head.rows.length === 0) return null;
  const sets = await pool.query(
    `SELECT * FROM workout_set_logs WHERE session_id = $1 ORDER BY order_index, set_index`,
    [sessionId],
  );
  return { ...head.rows[0], sets: sets.rows };
}
