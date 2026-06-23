import pool from '../config/database';
import { getReadinessLensToday } from '../modules/readiness/readiness.service';

// Camada de execução real do treino (Spec 010). Cria a sessão (cabeçalho) +
// séries (workout_set_logs) numa transação, derivando readiness/adaptação do
// dia no servidor. Append-only: histórico fechado não é alterado.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionSource = 'personal' | 'suggested' | 'academy' | 'free';
export type SessionStatus = 'started' | 'completed' | 'partial' | 'abandoned';

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
      await client.query(
        `INSERT INTO workout_set_logs
           (session_id, exercise_id, exercise_name, order_index, set_index,
            planned_reps, reps_done, planned_load_kg, load_done_kg, planned_rest_s, rest_done_s,
            rpe, discomfort, substituted_from_exercise_id, substitution_reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
    }

    await client.query('COMMIT');
    return { id: sessionId, startedAt: header.rows[0].started_at, setCount: rows.length };
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

export async function getSession(userId: number, sessionId: number) {
  const head = await pool.query(`SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  if (head.rows.length === 0) return null;
  const sets = await pool.query(
    `SELECT * FROM workout_set_logs WHERE session_id = $1 ORDER BY order_index, set_index`,
    [sessionId],
  );
  return { ...head.rows[0], sets: sets.rows };
}
