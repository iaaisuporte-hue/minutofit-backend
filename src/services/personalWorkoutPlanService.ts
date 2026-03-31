import pool from '../config/database';

export type WorkoutPlanItemPayload = {
  exerciseId: string;
  name: string;
  sets: string;
  reps: string;
  rest: string;
};

export async function assertStudentAssignedToPersonal(personalId: number, studentId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM personal_student_assignments
     WHERE personal_id = $1
       AND student_id = $2
       AND status = 'active'
     LIMIT 1`,
    [personalId, studentId]
  );
  return result.rows.length > 0;
}

export async function createPersonalWorkoutPlan(
  personalId: number,
  studentId: number,
  input: {
    title: string;
    weekPreset: string;
    selectedGroup: string | null;
    items: WorkoutPlanItemPayload[];
  }
) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const title = String(input.title || '').trim() || 'Treino';
  const weekPreset = String(input.weekPreset || '5').slice(0, 32);
  const selectedGroup = input.selectedGroup ? String(input.selectedGroup).slice(0, 64) : null;
  const items = Array.isArray(input.items) ? input.items : [];

  const insert = await pool.query(
    `INSERT INTO personal_workout_plans (
       personal_id, student_id, title, week_preset, selected_group, payload_json, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)
     RETURNING id, personal_id, student_id, title, week_preset, selected_group, payload_json, created_at, updated_at`,
    [personalId, studentId, title, weekPreset, selectedGroup, JSON.stringify(items)]
  );

  return insert.rows[0];
}

export async function listPersonalWorkoutPlans(personalId: number, studentId: number, limit = 50) {
  const ok = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!ok) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const result = await pool.query(
    `SELECT id, personal_id, student_id, title, week_preset, selected_group, payload_json, created_at, updated_at
     FROM personal_workout_plans
     WHERE personal_id = $1 AND student_id = $2
     ORDER BY updated_at DESC
     LIMIT $3`,
    [personalId, studentId, safeLimit]
  );

  return result.rows;
}

export async function listWorkoutPlansForStudent(studentId: number, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await pool.query(
    `SELECT id, personal_id, student_id, title, week_preset, selected_group, payload_json, created_at, updated_at
     FROM personal_workout_plans
     WHERE student_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [studentId, safeLimit]
  );

  return result.rows;
}
