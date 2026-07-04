import pool from '../config/database';
import { getReadinessLensToday } from '../modules/readiness/readiness.service';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';
import { applyGamificationCheckinTx, invalidateAfterCheckin, type MuscleGroup } from './gamificationService';

// Grupos musculares aceitos em user_workout_logs.muscle_groups (paridade com o
// enum MuscleGroup da gamificação). Sanitizamos o que vem do cliente.
const VALID_MUSCLE_GROUPS = new Set<MuscleGroup>([
  'chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'full_body', 'cardio', 'mobility',
]);
const WORKOUT_SESSION_XP = 30;

function sanitizeMuscleGroups(input: unknown): MuscleGroup[] {
  if (!Array.isArray(input)) return ['full_body'];
  const clean = input.filter((g): g is MuscleGroup => typeof g === 'string' && VALID_MUSCLE_GROUPS.has(g as MuscleGroup));
  return clean.length > 0 ? Array.from(new Set(clean)) : ['full_body'];
}

// Camada de execução real do treino (Spec 010). Cria a sessão (cabeçalho) +
// séries (workout_set_logs) numa transação, derivando readiness/adaptação do
// dia no servidor. Append-only: histórico fechado não é alterado.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionSource = 'personal' | 'suggested' | 'academy' | 'free' | 'movement_lab';
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

export async function createSession(userId: number, academyId: number | null, input: CreateSessionInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deriva personal + adaptação do dia (quando há plano), e readiness de hoje.
    let personalId: number | null = null;
    let adaptationLogId: number | null = null;
    if (input.planId) {
      const plan = await client.query(`SELECT personal_id FROM personal_workout_plans WHERE id = $1`, [input.planId]);
      personalId = plan.rows[0]?.personal_id ?? null;
      if (input.dayIndex != null) {
        const adap = await client.query(
          `SELECT id FROM workout_adaptation_log
           WHERE student_id = $1 AND plan_id = $2 AND day_index = $3 AND snapshot_date = CURRENT_DATE
           LIMIT 1`,
          [userId, input.planId, input.dayIndex],
        );
        adaptationLogId = adap.rows[0]?.id ?? null;
      }
    }

    let readinessLevel: string | null = null;
    try {
      const r = await getReadinessLensToday(userId);
      readinessLevel = r?.level ?? null;
    } catch {
      readinessLevel = null;
    }

    const prescribed = Array.isArray(input.prescribed) ? input.prescribed : [];

    const header = await client.query(
      `INSERT INTO workout_sessions
         (user_id, academy_id, personal_id, source, plan_id, day_index, adaptation_log_id,
          readiness_level, prescribed_snapshot, status, session_rpe, title, ended_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       RETURNING id, started_at`,
      [
        userId,
        academyId,
        personalId,
        input.source,
        input.planId ?? null,
        input.dayIndex ?? null,
        adaptationLogId,
        readinessLevel,
        JSON.stringify(prescribed),
        input.status,
        clampRpe(input.sessionRpe),
        input.title ?? null,
        input.status === 'started' ? null : new Date(),
        input.notes ?? null,
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

    for (const r of rows) {
      const setLog = await client.query(
        `INSERT INTO workout_set_logs
           (session_id, exercise_id, exercise_name, order_index, set_index,
            planned_reps, reps_done, planned_load_kg, load_done_kg, planned_rest_s, rest_done_s,
            rpe, discomfort, substituted_from_exercise_id, substitution_reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          sessionId,
          safeUuid(r.exerciseId),
          String(r.name ?? '').slice(0, 200) || '—',
          r.orderIndex ?? 0,
          r.setIndex ?? 1,
          r.plannedReps ?? null,
          numOrNull(r.repsDone),
          numOrNull(r.plannedLoadKg),
          numOrNull(r.loadDoneKg),
          leadingInt(r.plannedRestS),
          leadingInt(r.restDoneS),
          clampRpe(r.rpe),
          r.discomfort ? String(r.discomfort).slice(0, 280) : null,
          safeUuid(r.substitutedFromExerciseId),
          r.substitutionReason ? String(r.substitutionReason).slice(0, 280) : null,
          r.status === 'skipped' ? 'skipped' : 'done',
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

    // Write-through de gamificação (P0-1): log raso + XP/streak na MESMA
    // transação da execução rica. Só sessões efetivamente treinadas contam —
    // 'started'/'abandoned' não geram XP nem streak.
    let awarded = false;
    let streak: number | null = null;
    let xp: number | null = null;
    if (input.awardGamification && (input.status === 'completed' || input.status === 'partial')) {
      await applyGamificationCheckinTx(client, {
        userId,
        academyId,
        source: 'workout',
        xp: WORKOUT_SESSION_XP,
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
      awarded = true;
    }

    await client.query('COMMIT');

    // Invalidações fora da transação (nunca dentro do COMMIT).
    if (awarded) invalidateAfterCheckin(userId);

    return { id: sessionId, startedAt: header.rows[0].started_at, setCount: rows.length, streak, xp };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listSessions(userId: number, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, source, plan_id, day_index, readiness_level, status, session_rpe,
            title, started_at, ended_at,
            (SELECT COUNT(*) FROM workout_set_logs sl WHERE sl.session_id = ws.id AND sl.status = 'done') AS sets_done
       FROM workout_sessions ws
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [userId, Math.min(200, Math.max(1, limit))],
  );
  return rows;
}

/** Estatísticas de execução (Spec 010 V1.1): frequência + progressão de carga. */
export async function getWorkoutStats(userId: number) {
  const freq = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE started_at >= date_trunc('week', now()))::int AS this_week,
       COUNT(*) FILTER (WHERE started_at >= now() - interval '30 days')::int AS last_30d
     FROM workout_sessions
     WHERE user_id = $1 AND status IN ('completed', 'partial')`,
    [userId],
  );

  // Progressão de carga por exercício: MAX(carga) por dia, só onde há carga.
  const prog = await pool.query(
    `SELECT sl.exercise_id,
            MIN(sl.exercise_name) AS exercise_name,
            ws.started_at::date AS d,
            MAX(sl.load_done_kg) AS max_load
       FROM workout_set_logs sl
       JOIN workout_sessions ws ON ws.id = sl.session_id
      WHERE ws.user_id = $1 AND sl.load_done_kg IS NOT NULL AND sl.exercise_id IS NOT NULL
      GROUP BY sl.exercise_id, ws.started_at::date
      ORDER BY sl.exercise_id, d`,
    [userId],
  );

  const byExercise = new Map<string, { exerciseId: string; name: string; points: { date: string; maxLoadKg: number }[] }>();
  for (const r of prog.rows) {
    const key = r.exercise_id;
    if (!byExercise.has(key)) byExercise.set(key, { exerciseId: key, name: r.exercise_name, points: [] });
    byExercise.get(key)!.points.push({ date: r.d, maxLoadKg: Number(r.max_load) });
  }
  // Só exercícios com ≥2 pontos rendem "progressão"; ordena por maior ganho.
  const exerciseProgression = Array.from(byExercise.values())
    .filter((e) => e.points.length >= 2)
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
    `SELECT ws.id, ws.started_at, ws.status, ws.source, ws.readiness_level, ws.prescribed_snapshot,
            (SELECT COUNT(*) FROM workout_set_logs sl WHERE sl.session_id = ws.id AND sl.status = 'done')::int AS sets_done
       FROM workout_sessions ws
      WHERE ws.user_id = $1 AND ws.status IN ('completed', 'partial')
      ORDER BY ws.started_at DESC
      LIMIT $2`,
    [studentId, Math.min(30, Math.max(1, limit))],
  );

  let totalDone = 0;
  let totalPrescribed = 0;
  const sessions = rows.map((r) => {
    const presc = Array.isArray(r.prescribed_snapshot) ? r.prescribed_snapshot : [];
    const prescribedSets = presc.reduce((acc: number, it: { sets?: string }) => acc + parseSetCount(it?.sets), 0);
    totalDone += r.sets_done;
    totalPrescribed += prescribedSets;
    return {
      id: r.id,
      date: r.started_at,
      status: r.status,
      source: r.source,
      readinessLevel: r.readiness_level,
      setsDone: r.sets_done,
      prescribedSets,
    };
  });

  const adherencePct = totalPrescribed > 0 ? Math.round((totalDone / totalPrescribed) * 100) : null;

  const freq = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE started_at >= now() - interval '7 days')::int AS last_7d,
            COUNT(*)::int AS total
       FROM workout_sessions
      WHERE user_id = $1 AND status IN ('completed', 'partial')`,
    [studentId],
  );

  return { adherencePct, last7d: freq.rows[0].last_7d, total: freq.rows[0].total, sessions };
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
