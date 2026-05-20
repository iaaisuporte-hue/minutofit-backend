import pool from '../config/database';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';
import { invalidatePersonalDashboardCache } from './personalDashboardService';

export const NOTE_KINDS = [
  'technique',
  'pain',
  'load',
  'progression',
  'cue',
  'rom',
  'breathing',
  'cadence',
  'general',
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value);
}

function tenantClause(academyId: number | null | undefined, paramOffset: number) {
  if (academyId == null || academyId === undefined) {
    return { sql: 'TRUE', params: [] as unknown[] };
  }
  return {
    sql: `(academy_id IS NULL OR academy_id = $${paramOffset})`,
    params: [academyId],
  };
}

export type StudentExerciseNoteRow = {
  id: number;
  personalId: number;
  studentId: number;
  academyId: number | null;
  exerciseKey: string | null;
  exerciseName: string;
  kind: NoteKind;
  note: string;
  severity: number | null;
  loadKg: number | null;
  reps: string | null;
  sets: string | null;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(r: Record<string, unknown>): StudentExerciseNoteRow {
  return {
    id: Number(r.id),
    personalId: Number(r.personal_id),
    studentId: Number(r.student_id),
    academyId: r.academy_id != null ? Number(r.academy_id) : null,
    exerciseKey: r.exercise_key != null ? String(r.exercise_key) : null,
    exerciseName: String(r.exercise_name || ''),
    kind: r.kind as NoteKind,
    note: String(r.note || ''),
    severity: r.severity != null ? Number(r.severity) : null,
    loadKg: r.load_kg != null ? Number(r.load_kg) : null,
    reps: r.reps != null ? String(r.reps) : null,
    sets: r.sets != null ? String(r.sets) : null,
    recordedAt: new Date(r.recorded_at as string).toISOString(),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export type TechnicalHighlight = {
  exerciseName: string;
  exerciseKey: string | null;
  kind: NoteKind;
  count: number;
  lastNoteAt: string;
};

export type TechnicalSnapshot = {
  highlights: TechnicalHighlight[];
  recentNotes: Array<{
    id: number;
    exerciseName: string;
    exerciseKey: string | null;
    kind: NoteKind;
    note: string;
    recordedAt: string;
    loadKg: number | null;
    reps: string | null;
    sets: string | null;
    severity: number | null;
    personalId: number;
  }>;
};

export async function fetchTechnicalSnapshotData(
  studentId: number,
  academyId: number | null | undefined
): Promise<TechnicalSnapshot> {
  const t1 = tenantClause(academyId, 2);
  const t2 = tenantClause(academyId, 2);

  const [highlightsRes, recentRes] = await Promise.all([
    pool.query(
      `SELECT
          MAX(exercise_name) AS exercise_name,
          MAX(exercise_key) AS exercise_key,
          kind,
          COUNT(*)::int AS cnt,
          MAX(recorded_at) AS last_at
       FROM student_exercise_notes
       WHERE student_id = $1
         AND recorded_at >= NOW() - INTERVAL '90 days'
         AND ${t1.sql}
       GROUP BY
         COALESCE(NULLIF(TRIM(exercise_key), ''), exercise_name),
         kind
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC
       LIMIT 3`,
      [studentId, ...t1.params]
    ),
    pool.query(
      `SELECT id, personal_id, exercise_name, exercise_key, kind, note, recorded_at, load_kg, reps, sets, severity
       FROM student_exercise_notes
       WHERE student_id = $1
         AND ${t2.sql}
       ORDER BY recorded_at DESC
       LIMIT 3`,
      [studentId, ...t2.params]
    ),
  ]);

  const highlights: TechnicalHighlight[] = highlightsRes.rows.map((row) => ({
    exerciseName: String(row.exercise_name || ''),
    exerciseKey: row.exercise_key != null ? String(row.exercise_key) : null,
    kind: row.kind as NoteKind,
    count: Number(row.cnt || 0),
    lastNoteAt: new Date(row.last_at as string).toISOString(),
  }));

  const recentNotes = recentRes.rows.map((row) => ({
    id: Number(row.id),
    exerciseName: String(row.exercise_name || ''),
    exerciseKey: row.exercise_key != null ? String(row.exercise_key) : null,
    kind: row.kind as NoteKind,
    note: String(row.note || ''),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
    loadKg: row.load_kg != null ? Number(row.load_kg) : null,
    reps: row.reps != null ? String(row.reps) : null,
    sets: row.sets != null ? String(row.sets) : null,
    severity: row.severity != null ? Number(row.severity) : null,
    personalId: Number(row.personal_id),
  }));

  return { highlights, recentNotes };
}

export async function createStudentExerciseNote(
  personalId: number,
  studentId: number,
  academyId: number | null | undefined,
  body: {
    exerciseKey?: string | null;
    exerciseName: string;
    kind: string;
    note: string;
    severity?: number | null;
    loadKg?: number | null;
    reps?: string | null;
    sets?: string | null;
    recordedAt?: string | null;
  }
): Promise<StudentExerciseNoteRow> {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  if (!isNoteKind(body.kind)) {
    throw new Error('Invalid note kind');
  }

  const exerciseName = sanitizeString(body.exerciseName, 160);
  if (!exerciseName) {
    throw new Error('exerciseName is required');
  }

  const note = sanitizeString(body.note, 2000);
  if (!note) {
    throw new Error('note is required');
  }

  const exerciseKeyRaw = body.exerciseKey != null ? sanitizeString(body.exerciseKey, 96) : '';
  const exerciseKey = exerciseKeyRaw || null;

  let severity: number | null = null;
  if (body.severity != null && body.severity !== undefined) {
    const s = Number(body.severity);
    if (Number.isFinite(s) && s >= 1 && s <= 5) severity = s;
  }

  let loadKg: number | null = null;
  if (body.loadKg != null && body.loadKg !== undefined) {
    const l = Number(body.loadKg);
    if (Number.isFinite(l) && l >= 0 && l <= 999.99) loadKg = Math.round(l * 100) / 100;
  }

  const reps = body.reps != null ? sanitizeString(body.reps, 24) : null;
  const sets = body.sets != null ? sanitizeString(body.sets, 24) : null;

  let recordedAt: Date | null = null;
  if (body.recordedAt) {
    const d = new Date(body.recordedAt);
    if (!Number.isNaN(d.getTime())) recordedAt = d;
  }

  const result = await pool.query(
    `INSERT INTO student_exercise_notes
      (personal_id, student_id, academy_id, exercise_key, exercise_name, kind, note, severity, load_kg, reps, sets, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()))
     RETURNING *`,
    [
      personalId,
      studentId,
      academyId ?? null,
      exerciseKey,
      exerciseName,
      body.kind,
      note,
      severity,
      loadKg,
      reps || null,
      sets || null,
      recordedAt,
    ]
  );

  // Invalida cache do dashboard do personal — chip "Sem nota técnica há X sem"
  // depende de last_technical_note_at e fica defasado por até 60s sem isso.
  void invalidatePersonalDashboardCache(personalId, academyId ?? null);

  return mapRow(result.rows[0] as Record<string, unknown>);
}

export async function listStudentExerciseNotes(
  personalId: number,
  studentId: number,
  academyId: number | null | undefined,
  filters: { kind?: string; exerciseKey?: string; since?: string; limit?: number } = {}
): Promise<StudentExerciseNoteRow[]> {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const params: unknown[] = [studentId];
  let where = 'WHERE student_id = $1';

  const t = tenantClause(academyId, params.length + 1);
  where += ` AND ${t.sql}`;
  params.push(...t.params);

  if (filters.kind && isNoteKind(filters.kind)) {
    params.push(filters.kind);
    where += ` AND kind = $${params.length}`;
  }

  if (filters.exerciseKey) {
    params.push(sanitizeString(filters.exerciseKey, 96));
    where += ` AND exercise_key = $${params.length}`;
  }

  if (filters.since) {
    const d = new Date(filters.since);
    if (!Number.isNaN(d.getTime())) {
      params.push(d.toISOString());
      where += ` AND recorded_at >= $${params.length}::timestamptz`;
    }
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  params.push(limit);
  where += ` ORDER BY recorded_at DESC LIMIT $${params.length}`;

  const result = await pool.query(`SELECT * FROM student_exercise_notes ${where}`, params);
  return result.rows.map((r) => mapRow(r as Record<string, unknown>));
}

export async function updateStudentExerciseNote(
  personalId: number,
  studentId: number,
  noteId: number,
  body: Partial<{
    exerciseKey: string | null;
    exerciseName: string;
    kind: string;
    note: string;
    severity: number | null;
    loadKg: number | null;
    reps: string | null;
    sets: string | null;
    recordedAt: string | null;
  }>
): Promise<StudentExerciseNoteRow | null> {
  const existing = await pool.query(
    `SELECT * FROM student_exercise_notes WHERE id = $1 AND personal_id = $2 AND student_id = $3 LIMIT 1`,
    [noteId, personalId, studentId]
  );
  if (!existing.rows.length) return null;

  const row = existing.rows[0] as Record<string, unknown>;
  const exerciseName =
    body.exerciseName !== undefined ? sanitizeString(body.exerciseName, 160) : String(row.exercise_name || '');
  if (!exerciseName) throw new Error('exerciseName is required');

  const noteText = body.note !== undefined ? sanitizeString(body.note, 2000) : String(row.note || '');
  if (!noteText) throw new Error('note is required');

  let kind = row.kind as string;
  if (body.kind !== undefined) {
    if (!isNoteKind(body.kind)) throw new Error('Invalid note kind');
    kind = body.kind;
  }

  let exerciseKey: string | null =
    row.exercise_key != null ? String(row.exercise_key) : null;
  if (body.exerciseKey !== undefined) {
    const ek = body.exerciseKey != null ? sanitizeString(body.exerciseKey, 96) : '';
    exerciseKey = ek || null;
  }

  let severity: number | null = row.severity != null ? Number(row.severity) : null;
  if (body.severity !== undefined) {
    if (body.severity === null) severity = null;
    else {
      const s = Number(body.severity);
      severity = Number.isFinite(s) && s >= 1 && s <= 5 ? s : null;
    }
  }

  let loadKg: number | null = row.load_kg != null ? Number(row.load_kg) : null;
  if (body.loadKg !== undefined) {
    if (body.loadKg === null) loadKg = null;
    else {
      const l = Number(body.loadKg);
      loadKg = Number.isFinite(l) && l >= 0 && l <= 999.99 ? Math.round(l * 100) / 100 : null;
    }
  }

  let reps: string | null = row.reps != null ? String(row.reps) : null;
  if (body.reps !== undefined) {
    reps = body.reps != null ? sanitizeString(body.reps, 24) : null;
  }

  let sets: string | null = row.sets != null ? String(row.sets) : null;
  if (body.sets !== undefined) {
    sets = body.sets != null ? sanitizeString(body.sets, 24) : null;
  }

  let recordedAt: string =
    row.recorded_at != null ? new Date(row.recorded_at as string).toISOString() : new Date().toISOString();
  if (body.recordedAt !== undefined && body.recordedAt !== null) {
    const d = new Date(body.recordedAt);
    if (!Number.isNaN(d.getTime())) recordedAt = d.toISOString();
  }

  const result = await pool.query(
    `UPDATE student_exercise_notes
     SET exercise_key = $1,
         exercise_name = $2,
         kind = $3,
         note = $4,
         severity = $5,
         load_kg = $6,
         reps = $7,
         sets = $8,
         recorded_at = $9::timestamptz,
         updated_at = NOW()
     WHERE id = $10 AND personal_id = $11 AND student_id = $12
     RETURNING *`,
    [exerciseKey, exerciseName, kind, noteText, severity, loadKg, reps, sets, recordedAt, noteId, personalId, studentId]
  );

  if (!result.rows.length) return null;
  return mapRow(result.rows[0] as Record<string, unknown>);
}

export async function deleteStudentExerciseNote(
  personalId: number,
  studentId: number,
  noteId: number
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM student_exercise_notes WHERE id = $1 AND personal_id = $2 AND student_id = $3`,
    [noteId, personalId, studentId]
  );
  return (result.rowCount ?? 0) > 0;
}
