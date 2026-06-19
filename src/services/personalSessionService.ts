import pool from '../config/database';

export type SessionStatus = 'present' | 'absent' | 'partial';

export const VALID_TAGS = [
  'dor',
  'cansaco',
  'desmotivado',
  'dificuldade_tecnica',
  'evolucao_carga',
  'precisa_contato',
] as const;

export type SessionTag = (typeof VALID_TAGS)[number];

export interface SessionLog {
  id: number;
  personalId: number;
  studentId: number;
  academyId: number | null;
  status: SessionStatus;
  sessionAt: string;
  tags: string[];
  note: string | null;
  createdAt: string;
}

async function assertAssigned(personalId: number, studentId: number): Promise<void> {
  const res = await pool.query(
    `SELECT 1 FROM personal_student_assignments
     WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
    [personalId, studentId],
  );
  if (res.rows.length === 0) {
    const err = new Error('Student not assigned to this personal');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }
}

export async function createSession(
  personalId: number,
  studentId: number,
  academyId: number | null,
  input: {
    status: SessionStatus;
    tags?: string[];
    note?: string;
    sessionAt?: string;
  },
): Promise<SessionLog> {
  await assertAssigned(personalId, studentId);

  const tags = (input.tags ?? []).filter((t) => (VALID_TAGS as readonly string[]).includes(t));
  const sessionAt = input.sessionAt ? new Date(input.sessionAt) : new Date();

  const res = await pool.query<{
    id: number;
    personal_id: number;
    student_id: number;
    academy_id: number | null;
    status: SessionStatus;
    session_at: string;
    tags: string[];
    note: string | null;
    created_at: string;
  }>(
    `INSERT INTO personal_session_logs
       (personal_id, student_id, academy_id, status, session_at, tags, note)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING *`,
    [personalId, studentId, academyId, input.status, sessionAt, JSON.stringify(tags), input.note ?? null],
  );

  const row = res.rows[0];
  return {
    id: row.id,
    personalId: row.personal_id,
    studentId: row.student_id,
    academyId: row.academy_id,
    status: row.status,
    sessionAt: new Date(row.session_at).toISOString(),
    tags: row.tags,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listSessions(
  personalId: number,
  studentId: number,
  limit = 20,
): Promise<SessionLog[]> {
  await assertAssigned(personalId, studentId);

  const res = await pool.query<{
    id: number;
    personal_id: number;
    student_id: number;
    academy_id: number | null;
    status: SessionStatus;
    session_at: string;
    tags: string[];
    note: string | null;
    created_at: string;
  }>(
    `SELECT * FROM personal_session_logs
     WHERE personal_id = $1 AND student_id = $2
     ORDER BY session_at DESC
     LIMIT $3`,
    [personalId, studentId, limit],
  );

  return res.rows.map((row) => ({
    id: row.id,
    personalId: row.personal_id,
    studentId: row.student_id,
    academyId: row.academy_id,
    status: row.status,
    sessionAt: new Date(row.session_at).toISOString(),
    tags: row.tags,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
