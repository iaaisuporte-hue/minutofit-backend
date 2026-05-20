import pool from '../config/database';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

export type ActionType =
  | 'follow_up_marked'
  | 'observation'
  | 'bonus_offered'
  | 'light_workout_offered'
  | 'gradual_return_offered'
  | 'message_sent'
  | 'quick_nudge';

export type CreateActionInput = {
  actionType: ActionType;
  payloadJson?: Record<string, unknown>;
  source?: string;
  dueAt?: string | null;
  linkedSignalId?: string | null;
};

export type TimelineItem = {
  kind: 'action' | 'message' | 'workout' | 'checkin' | 'note';
  id: string;
  occurredAt: string;
  title: string;
  summary: string;
  meta: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function createRelationshipAction(
  personalId: number,
  studentId: number,
  academyId: number | null,
  input: CreateActionInput
) {
  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student not assigned to this personal');
    (err as any).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const result = await pool.query(
    `INSERT INTO personal_relationship_actions
       (personal_id, student_id, academy_id, action_type, payload_json, source, due_at, linked_signal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      personalId,
      studentId,
      academyId,
      input.actionType,
      JSON.stringify(input.payloadJson ?? {}),
      input.source ?? 'manual',
      input.dueAt ?? null,
      input.linkedSignalId ?? null,
    ]
  );
  return result.rows[0];
}

export async function resolveRelationshipAction(
  actionId: number,
  personalId: number
) {
  const result = await pool.query(
    `UPDATE personal_relationship_actions
     SET resolved_at = NOW()
     WHERE id = $1 AND personal_id = $2 AND resolved_at IS NULL
     RETURNING *`,
    [actionId, personalId]
  );
  if (result.rowCount === 0) {
    const err = new Error('Action not found or already resolved');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  return result.rows[0];
}

export async function deleteRelationshipAction(actionId: number, personalId: number) {
  const result = await pool.query(
    `DELETE FROM personal_relationship_actions
     WHERE id = $1 AND personal_id = $2
     RETURNING id`,
    [actionId, personalId]
  );
  if (result.rowCount === 0) {
    const err = new Error('Action not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Timeline (UNION ALL: actions + messages + workouts + checkins + notes)
// ---------------------------------------------------------------------------

export async function listRelationshipTimeline(
  personalId: number,
  studentId: number,
  academyId: number | null,
  opts: { limit?: number } = {}
): Promise<TimelineItem[]> {
  const limit = opts.limit ?? 50;

  const result = await pool.query(
    `
    -- Actions do personal
    SELECT
      'action'                              AS kind,
      pra.id::text                          AS id,
      pra.created_at                        AS occurred_at,
      pra.action_type                       AS title_raw,
      COALESCE((pra.payload_json->>'note'), pra.action_type) AS summary,
      jsonb_build_object(
        'actionType', pra.action_type,
        'dueAt', pra.due_at,
        'resolvedAt', pra.resolved_at,
        'source', pra.source,
        'payload', pra.payload_json,
        'linkedSignalId', pra.linked_signal_id
      )                                     AS meta
    FROM personal_relationship_actions pra
    WHERE pra.personal_id = $1
      AND pra.student_id  = $2
      AND ($3::int IS NULL OR pra.academy_id IS NULL OR pra.academy_id = $3)

    UNION ALL

    -- Mensagens do personal para o aluno via chat
    SELECT
      'message'                             AS kind,
      cm.id::text                           AS id,
      cm.created_at                         AS occurred_at,
      'Mensagem enviada'                    AS title_raw,
      LEFT(cm.text, 120)                    AS summary,
      jsonb_build_object('senderRole', cm.sender_role, 'conversationId', cm.conversation_id) AS meta
    FROM chat_messages cm
    JOIN chat_conversations cc ON cc.id = cm.conversation_id
    WHERE cc.personal_id = $1
      AND cc.student_id  = $2
      AND cm.sender_role = 'personal'
      AND ($3::int IS NULL OR cc.academy_id IS NULL OR cc.academy_id = $3)

    UNION ALL

    -- Treinos registrados pelo aluno
    SELECT
      'workout'                             AS kind,
      uwl.id::text                          AS id,
      uwl.completed_at                      AS occurred_at,
      'Treino registrado'                   AS title_raw,
      ''                                    AS summary,
      jsonb_build_object('workoutId', uwl.id) AS meta
    FROM user_workout_logs uwl
    WHERE uwl.user_id = $2
      AND ($3::int IS NULL OR uwl.academy_id IS NULL OR uwl.academy_id = $3)
      AND uwl.completed_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- Check-ins do aluno
    SELECT
      'checkin'                             AS kind,
      udc.id::text                          AS id,
      udc.created_at                        AS occurred_at,
      'Check-in'                            AS title_raw,
      COALESCE(udc.notes, '')               AS summary,
      jsonb_build_object('feeling', udc.feeling, 'sleptWell', udc.slept_well) AS meta
    FROM user_daily_checkins udc
    WHERE udc.user_id = $2
      AND ($3::int IS NULL OR udc.academy_id IS NULL OR udc.academy_id = $3)
      AND udc.created_at >= NOW() - INTERVAL '90 days'

    UNION ALL

    -- Notas técnicas do personal
    SELECT
      'note'                                AS kind,
      sen.id::text                          AS id,
      sen.recorded_at                       AS occurred_at,
      COALESCE(sen.exercise_name, 'Nota técnica') AS title_raw,
      LEFT(sen.note, 120)                   AS summary,
      jsonb_build_object('exerciseKey', sen.exercise_key, 'kind', sen.kind, 'severity', sen.severity) AS meta
    FROM student_exercise_notes sen
    WHERE sen.personal_id = $1
      AND sen.student_id  = $2
      AND ($3::int IS NULL OR sen.academy_id IS NULL OR sen.academy_id = $3)
      AND sen.recorded_at >= NOW() - INTERVAL '90 days'

    ORDER BY occurred_at DESC
    LIMIT $4
    `,
    [personalId, studentId, academyId, limit]
  );

  return result.rows.map((row) => ({
    kind: row.kind as TimelineItem['kind'],
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    title: humanizeTitle(row.kind, row.title_raw),
    summary: row.summary || '',
    meta: row.meta || {},
  }));
}

function humanizeTitle(kind: string, raw: string): string {
  if (kind === 'action') {
    const map: Record<string, string> = {
      follow_up_marked: 'Acompanhamento marcado',
      observation: 'Observação registrada',
      bonus_offered: 'Sessão bônus oferecida',
      light_workout_offered: 'Treino leve oferecido',
      gradual_return_offered: 'Retorno gradual oferecido',
      message_sent: 'Mensagem enviada',
      quick_nudge: 'Contato rápido',
    };
    return map[raw] ?? raw;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Record message_sent action automatically (best-effort, never throws)
// ---------------------------------------------------------------------------

export async function recordMessageSentAction(
  personalId: number,
  studentId: number,
  academyId: number | null,
  conversationId: number
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO personal_relationship_actions
         (personal_id, student_id, academy_id, action_type, payload_json, source)
       VALUES ($1, $2, $3, 'message_sent', $4, 'auto')`,
      [
        personalId,
        studentId,
        academyId,
        JSON.stringify({ conversationId }),
      ]
    );
  } catch {
    // best-effort — never block message delivery
  }
}
