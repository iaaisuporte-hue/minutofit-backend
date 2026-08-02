import pool from '../config/database';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

export type ReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'archived';
export type ReviewRisk = 'low' | 'medium' | 'high';
export type ReviewPriority = 'low' | 'normal' | 'high';

export type WorkoutReview = {
  id: string;
  personalId: string;
  studentId: string;
  studentName: string | null;
  workoutPlanId: string | null;
  title: string;
  goal: string;
  status: ReviewStatus;
  risk: ReviewRisk;
  priority: ReviewPriority;
  internalNotes: string | null;
  studentFeedback: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
};

type Row = {
  id: number;
  personal_id: number;
  student_id: number;
  student_name: string | null;
  workout_plan_id: number | null;
  title: string;
  goal: string;
  status: ReviewStatus;
  risk: ReviewRisk;
  priority: ReviewPriority;
  internal_notes: string | null;
  student_feedback: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  reviewed_at: Date | string | null;
};

function mapRow(row: Row): WorkoutReview {
  return {
    id: String(row.id),
    personalId: String(row.personal_id),
    studentId: String(row.student_id),
    studentName: row.student_name,
    workoutPlanId: row.workout_plan_id !== null ? String(row.workout_plan_id) : null,
    title: row.title,
    goal: row.goal,
    status: row.status,
    risk: row.risk,
    priority: row.priority,
    internalNotes: row.internal_notes,
    studentFeedback: row.student_feedback,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  };
}

export async function listWorkoutReviews(personalId: number): Promise<WorkoutReview[]> {
  const result = await pool.query<Row>(
    `SELECT wr.id, wr.personal_id, wr.student_id, u.name AS student_name,
            wr.workout_plan_id, wr.title, wr.goal, wr.status, wr.risk, wr.priority,
            wr.internal_notes, wr.student_feedback, wr.created_at, wr.updated_at, wr.reviewed_at
     FROM workout_reviews wr
     JOIN users u ON u.id = wr.student_id
     WHERE wr.personal_id = $1
     ORDER BY
       CASE wr.status WHEN 'pending' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
       CASE wr.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       wr.updated_at DESC`,
    [personalId]
  );
  return result.rows.map(mapRow);
}

/**
 * Revisões que o ALUNO pode ver (QA 02/ago/2026, P1-5).
 *
 * O campo se chama `studentFeedback` e era escrito pelo personal na aprovação —
 * mas não existia leitura do lado do aluno: o profissional escrevia achando que
 * estava falando com ele, e a mensagem morria na própria tela do personal.
 *
 * Entram `changes_requested` — o caminho real do produto, botão "Devolve para o
 * aluno com feedback" — e `approved` com feedback preenchido. Ficam de fora
 * `pending` (trabalho em andamento) e `archived`. `internal_notes` NUNCA sai
 * daqui: é anotação privada do profissional.
 */
export type StudentVisibleReview = {
  id: string;
  title: string;
  goal: string;
  status: Extract<ReviewStatus, 'approved' | 'changes_requested'>;
  studentFeedback: string;
  personalName: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export async function listReviewsForStudent(
  studentId: number,
  limit = 10,
): Promise<StudentVisibleReview[]> {
  const result = await pool.query<{
    id: number;
    title: string;
    goal: string;
    status: 'approved' | 'changes_requested';
    student_feedback: string;
    personal_name: string | null;
    reviewed_at: Date | string | null;
    created_at: Date | string;
  }>(
    `SELECT wr.id, wr.title, wr.goal, wr.status, wr.student_feedback,
            u.name AS personal_name, wr.reviewed_at, wr.created_at
       FROM workout_reviews wr
       LEFT JOIN users u ON u.id = wr.personal_id
      WHERE wr.student_id = $1
        AND wr.status IN ('approved', 'changes_requested')
        AND wr.student_feedback IS NOT NULL
        AND btrim(wr.student_feedback) <> ''
      ORDER BY COALESCE(wr.reviewed_at, wr.updated_at) DESC
      LIMIT $2`,
    [studentId, limit],
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    goal: row.goal,
    status: row.status,
    studentFeedback: row.student_feedback,
    personalName: row.personal_name,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * Arquiva revisões em aberto quando o vínculo termina (QA 02/ago/2026, P3-9).
 * Sem isto, `GET /personal/reviews` continuava listando o ex-aluno pelo nome
 * depois do desvínculo e da revogação total de consent.
 */
export async function archiveOpenReviewsForPair(
  personalId: number,
  studentId: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE workout_reviews
        SET status = 'archived', updated_at = NOW()
      WHERE personal_id = $1 AND student_id = $2
        AND status IN ('pending', 'changes_requested')`,
    [personalId, studentId],
  );
  return result.rowCount ?? 0;
}

export async function createWorkoutReview(
  personalId: number,
  academyId: number | null,
  input: {
    studentId: number;
    title: string;
    goal?: string;
    risk?: ReviewRisk;
    priority?: ReviewPriority;
    workoutPlanId?: number | null;
    internalNotes?: string | null;
  }
): Promise<WorkoutReview> {
  const ok = await assertStudentAssignedToPersonal(personalId, input.studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as Error & { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Revisão';
  const goal = (input.goal || 'hipertrofia').slice(0, 32);
  const risk: ReviewRisk = input.risk || 'low';
  const priority: ReviewPriority = input.priority || 'normal';
  const planId = input.workoutPlanId ?? null;
  const notes = input.internalNotes ? String(input.internalNotes).slice(0, 4000) : null;

  const insert = await pool.query<Row>(
    `INSERT INTO workout_reviews (
       personal_id, student_id, academy_id, workout_plan_id, title, goal, risk, priority, internal_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, personal_id, student_id,
       (SELECT name FROM users WHERE id = $2) AS student_name,
       workout_plan_id, title, goal, status, risk, priority,
       internal_notes, student_feedback, created_at, updated_at, reviewed_at`,
    [personalId, input.studentId, academyId, planId, title, goal, risk, priority, notes]
  );

  return mapRow(insert.rows[0]);
}

async function fetchOwnedReview(personalId: number, reviewId: number): Promise<Row | null> {
  const result = await pool.query<Row>(
    `SELECT wr.id, wr.personal_id, wr.student_id, u.name AS student_name,
            wr.workout_plan_id, wr.title, wr.goal, wr.status, wr.risk, wr.priority,
            wr.internal_notes, wr.student_feedback, wr.created_at, wr.updated_at, wr.reviewed_at
     FROM workout_reviews wr
     JOIN users u ON u.id = wr.student_id
     WHERE wr.id = $1 AND wr.personal_id = $2
     LIMIT 1`,
    [reviewId, personalId]
  );
  return result.rows[0] || null;
}

function notFound(): Error & { code?: string } {
  const err = new Error('Review not found') as Error & { code?: string };
  err.code = 'NOT_FOUND';
  return err;
}

export async function updateWorkoutReview(
  personalId: number,
  reviewId: number,
  patch: { internalNotes?: string; studentFeedback?: string }
): Promise<WorkoutReview> {
  const existing = await fetchOwnedReview(personalId, reviewId);
  if (!existing) throw notFound();

  const nextInternal =
    patch.internalNotes !== undefined ? String(patch.internalNotes).slice(0, 4000) : existing.internal_notes;
  const nextFeedback =
    patch.studentFeedback !== undefined
      ? String(patch.studentFeedback).slice(0, 4000)
      : existing.student_feedback;

  const updated = await pool.query<Row>(
    `UPDATE workout_reviews
     SET internal_notes = $3, student_feedback = $4, updated_at = NOW()
     WHERE id = $1 AND personal_id = $2
     RETURNING id, personal_id, student_id,
       (SELECT name FROM users WHERE id = student_id) AS student_name,
       workout_plan_id, title, goal, status, risk, priority,
       internal_notes, student_feedback, created_at, updated_at, reviewed_at`,
    [reviewId, personalId, nextInternal, nextFeedback]
  );

  return mapRow(updated.rows[0]);
}

async function transitionStatus(
  personalId: number,
  reviewId: number,
  status: ReviewStatus,
  patch: { studentFeedback?: string; internalNotes?: string }
): Promise<WorkoutReview> {
  const existing = await fetchOwnedReview(personalId, reviewId);
  if (!existing) throw notFound();

  const nextInternal =
    patch.internalNotes !== undefined ? String(patch.internalNotes).slice(0, 4000) : existing.internal_notes;
  const nextFeedback =
    patch.studentFeedback !== undefined
      ? String(patch.studentFeedback).slice(0, 4000)
      : existing.student_feedback;

  // Casts explícitos: sem eles o Postgres tenta deduzir UM tipo para $3 a
  // partir de dois usos incompatíveis (coluna varchar no SET, comparação text
  // no CASE) e recusa a query inteira com "inconsistent types deduced for
  // parameter $3" — approve/request-changes/archive quebravam com 500.
  const updated = await pool.query<Row>(
    `UPDATE workout_reviews
     SET status = $3::varchar, internal_notes = $4, student_feedback = $5,
         reviewed_at = CASE WHEN $3::text IN ('approved', 'changes_requested') THEN NOW() ELSE reviewed_at END,
         updated_at = NOW()
     WHERE id = $1 AND personal_id = $2
     RETURNING id, personal_id, student_id,
       (SELECT name FROM users WHERE id = student_id) AS student_name,
       workout_plan_id, title, goal, status, risk, priority,
       internal_notes, student_feedback, created_at, updated_at, reviewed_at`,
    [reviewId, personalId, status, nextInternal, nextFeedback]
  );

  return mapRow(updated.rows[0]);
}

export function approveWorkoutReview(
  personalId: number,
  reviewId: number,
  internalNotes?: string,
  studentFeedback?: string,
) {
  // `studentFeedback` no approve (QA 02/ago/2026, P1-5): antes só
  // `request-changes` gravava a mensagem do aluno, então aprovar com um recado
  // simplesmente descartava o texto. Continua opcional — aprovar sem mensagem
  // preserva o feedback anterior.
  return transitionStatus(personalId, reviewId, 'approved', { internalNotes, studentFeedback });
}

export function requestChangesWorkoutReview(
  personalId: number,
  reviewId: number,
  studentFeedback: string,
  internalNotes?: string
) {
  return transitionStatus(personalId, reviewId, 'changes_requested', { studentFeedback, internalNotes });
}

export function archiveWorkoutReview(personalId: number, reviewId: number) {
  return transitionStatus(personalId, reviewId, 'archived', {});
}
