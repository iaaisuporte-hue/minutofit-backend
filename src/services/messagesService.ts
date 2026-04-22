import pool from '../config/database';
import { assertStudentAssignedToPersonal } from './personalWorkoutPlanService';

type ViewerRole = 'user' | 'personal' | 'admin' | 'nutri';

type ConversationRow = {
  id: number;
  personal_id: number;
  personal_name: string | null;
  personal_email: string;
  student_id: number;
  student_name: string | null;
  student_email: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_read_at_by_student: Date | string | null;
  last_read_at_by_personal: Date | string | null;
};

type MessageRow = {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender_role: ViewerRole;
  text: string;
  created_at: Date | string;
};

function isAllowedViewerRole(role: string): role is ViewerRole {
  return role === 'user' || role === 'personal' || role === 'admin' || role === 'nutri';
}

function toIsoOrNull(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function mapMessage(row: MessageRow) {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderId: String(row.sender_id),
    senderRole: row.sender_role,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapConversation(
  row: ConversationRow & {
    last_message_id: number | null;
    last_message_text: string | null;
    last_message_created_at: Date | string | null;
    last_message_sender_id: number | null;
    last_message_sender_role: ViewerRole | null;
    unread_for_student: string | number;
    unread_for_personal: string | number;
  },
  viewerRole: ViewerRole
) {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    studentName: row.student_name || row.student_email || `Aluno ${row.student_id}`,
    studentEmail: row.student_email,
    personalId: String(row.personal_id),
    personalName: row.personal_name || row.personal_email || `Personal ${row.personal_id}`,
    personalEmail: row.personal_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastReadAtByStudent: toIsoOrNull(row.last_read_at_by_student),
    lastReadAtByPersonal: toIsoOrNull(row.last_read_at_by_personal),
    unreadCount:
      viewerRole === 'personal'
        ? Number(row.unread_for_personal || 0)
        : Number(row.unread_for_student || 0),
    lastMessage: row.last_message_id
      ? {
          id: String(row.last_message_id),
          senderId: String(row.last_message_sender_id),
          senderRole: row.last_message_sender_role,
          text: row.last_message_text || '',
          createdAt: new Date(row.last_message_created_at as Date | string).toISOString(),
        }
      : null,
  };
}

async function resolveConversationForViewer(conversationId: number, viewerId: number, viewerRole: ViewerRole) {
  const params: Array<number | string> = [conversationId];
  let accessClause = '';

  if (viewerRole === 'personal') {
    params.push(viewerId);
    accessClause = `AND cc.personal_id = $2`;
  } else if (viewerRole === 'user') {
    params.push(viewerId);
    accessClause = `AND cc.student_id = $2`;
  }

  const result = await pool.query<ConversationRow>(
    `SELECT
        cc.id,
        cc.personal_id,
        cc.student_id,
        cc.created_at,
        cc.updated_at,
        cc.last_read_at_by_student,
        cc.last_read_at_by_personal,
        personal_user.name AS personal_name,
        personal_user.email AS personal_email,
        student_user.name AS student_name,
        student_user.email AS student_email
      FROM chat_conversations cc
      JOIN users personal_user
        ON personal_user.id = cc.personal_id
      JOIN users student_user
        ON student_user.id = cc.student_id
      JOIN personal_student_assignments psa
        ON psa.personal_id = cc.personal_id
       AND psa.student_id = cc.student_id
       AND psa.status = 'active'
      WHERE cc.id = $1
        ${accessClause}
      LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

async function resolvePersonalForStudent(studentId: number): Promise<number | null> {
  const result = await pool.query<{ personal_id: number }>(
    `SELECT personal_id
     FROM personal_student_assignments
     WHERE student_id = $1
       AND status = 'active'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [studentId]
  );

  return result.rows[0]?.personal_id ?? null;
}

export async function listChatConversations(viewerId: number, viewerRoleRaw: string) {
  if (!isAllowedViewerRole(viewerRoleRaw)) {
    throw new Error('Unsupported role for chat');
  }

  const viewerRole = viewerRoleRaw;
  const params: Array<number | string> = [viewerId];
  let viewerFilter = '';

  if (viewerRole === 'personal') {
    viewerFilter = 'cc.personal_id = $1';
  } else if (viewerRole === 'user') {
    viewerFilter = 'cc.student_id = $1';
  } else {
    viewerFilter = 'TRUE';
  }

  const result = await pool.query<
    ConversationRow & {
      last_message_id: number | null;
      last_message_text: string | null;
      last_message_created_at: Date | string | null;
      last_message_sender_id: number | null;
      last_message_sender_role: ViewerRole | null;
      unread_for_student: string | number;
      unread_for_personal: string | number;
    }
  >(
    `SELECT
        cc.id,
        cc.personal_id,
        cc.student_id,
        cc.created_at,
        cc.updated_at,
        cc.last_read_at_by_student,
        cc.last_read_at_by_personal,
        personal_user.name AS personal_name,
        personal_user.email AS personal_email,
        student_user.name AS student_name,
        student_user.email AS student_email,
        last_message.id AS last_message_id,
        last_message.text AS last_message_text,
        last_message.created_at AS last_message_created_at,
        last_message.sender_id AS last_message_sender_id,
        last_message.sender_role AS last_message_sender_role,
        (
          SELECT COUNT(*)
          FROM chat_messages cm_student
          WHERE cm_student.conversation_id = cc.id
            AND cm_student.sender_role = 'personal'
            AND cm_student.created_at > COALESCE(cc.last_read_at_by_student, TO_TIMESTAMP(0))
        ) AS unread_for_student,
        (
          SELECT COUNT(*)
          FROM chat_messages cm_personal
          WHERE cm_personal.conversation_id = cc.id
            AND cm_personal.sender_role = 'user'
            AND cm_personal.created_at > COALESCE(cc.last_read_at_by_personal, TO_TIMESTAMP(0))
        ) AS unread_for_personal
      FROM chat_conversations cc
      JOIN users personal_user
        ON personal_user.id = cc.personal_id
      JOIN users student_user
        ON student_user.id = cc.student_id
      JOIN personal_student_assignments psa
        ON psa.personal_id = cc.personal_id
       AND psa.student_id = cc.student_id
       AND psa.status = 'active'
      LEFT JOIN LATERAL (
        SELECT id, sender_id, sender_role, text, created_at
        FROM chat_messages
        WHERE conversation_id = cc.id
        ORDER BY created_at DESC
        LIMIT 1
      ) last_message
        ON TRUE
      WHERE ${viewerFilter}
      ORDER BY cc.updated_at DESC`,
    params
  );

  return result.rows.map((row) => mapConversation(row, viewerRole));
}

export async function ensureChatConversation(
  viewerId: number,
  viewerRoleRaw: string,
  input: { studentId?: number | null; personalId?: number | null }
) {
  if (!isAllowedViewerRole(viewerRoleRaw)) {
    throw new Error('Unsupported role for chat');
  }

  const viewerRole = viewerRoleRaw;
  let studentId = input.studentId ?? null;
  let personalId = input.personalId ?? null;

  if (viewerRole === 'personal') {
    personalId = viewerId;
    if (!studentId) {
      const err = new Error('studentId is required for personal conversations');
      (err as Error & { code?: string }).code = 'VALIDATION';
      throw err;
    }
  } else if (viewerRole === 'user') {
    studentId = viewerId;
    personalId = personalId ?? (await resolvePersonalForStudent(viewerId));
    if (!personalId) {
      const err = new Error('No active personal assignment found for this student');
      (err as Error & { code?: string }).code = 'ASSIGNMENT_REQUIRED';
      throw err;
    }
  } else {
    const err = new Error('Chat creation is only available for students and personal trainers');
    (err as Error & { code?: string }).code = 'FORBIDDEN';
    throw err;
  }

  const assigned = await assertStudentAssignedToPersonal(personalId, studentId);
  if (!assigned) {
    const err = new Error('Student is not assigned to this personal trainer');
    (err as Error & { code?: string }).code = 'ASSIGNMENT_REQUIRED';
    throw err;
  }

  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO chat_conversations (
       personal_id,
       student_id,
       last_read_at_by_personal,
       last_read_at_by_student
     )
     VALUES (
       $1,
       $2,
       CASE WHEN $3 = 'personal' THEN NOW() ELSE NULL END,
       CASE WHEN $3 = 'user' THEN NOW() ELSE NULL END
     )
     ON CONFLICT (personal_id, student_id)
     DO UPDATE SET updated_at = chat_conversations.updated_at
     RETURNING id`,
    [personalId, studentId, viewerRole]
  );

  const conversationId = upsert.rows[0].id;
  const conversation = await resolveConversationForViewer(conversationId, viewerId, viewerRole);
  if (!conversation) {
    throw new Error('Conversation could not be created');
  }

  const list = await listChatConversations(viewerId, viewerRole);
  return list.find((item) => item.id === String(conversationId)) || null;
}

export async function listMessagesForConversation(
  viewerId: number,
  viewerRoleRaw: string,
  conversationId: number,
  limit = 200
) {
  if (!isAllowedViewerRole(viewerRoleRaw)) {
    throw new Error('Unsupported role for chat');
  }

  const viewerRole = viewerRoleRaw;
  const conversation = await resolveConversationForViewer(conversationId, viewerId, viewerRole);
  if (!conversation) {
    const err = new Error('Conversation not found');
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const result = await pool.query<MessageRow>(
    `SELECT id, conversation_id, sender_id, sender_role, text, created_at
     FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [conversationId, safeLimit]
  );

  return result.rows.map(mapMessage);
}

export async function markConversationRead(viewerId: number, viewerRoleRaw: string, conversationId: number) {
  if (!isAllowedViewerRole(viewerRoleRaw)) {
    throw new Error('Unsupported role for chat');
  }

  const viewerRole = viewerRoleRaw;
  const conversation = await resolveConversationForViewer(conversationId, viewerId, viewerRole);
  if (!conversation) {
    const err = new Error('Conversation not found');
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  if (viewerRole === 'personal') {
    await pool.query(
      `UPDATE chat_conversations
       SET last_read_at_by_personal = NOW()
       WHERE id = $1`,
      [conversationId]
    );
  } else if (viewerRole === 'user') {
    await pool.query(
      `UPDATE chat_conversations
       SET last_read_at_by_student = NOW()
       WHERE id = $1`,
      [conversationId]
    );
  }
}

export async function sendMessageToConversation(
  viewerId: number,
  viewerRoleRaw: string,
  conversationId: number,
  textRaw: string
) {
  if (!isAllowedViewerRole(viewerRoleRaw)) {
    throw new Error('Unsupported role for chat');
  }

  const viewerRole = viewerRoleRaw;
  if (viewerRole !== 'personal' && viewerRole !== 'user') {
    const err = new Error('Only users and personal trainers can send chat messages');
    (err as Error & { code?: string }).code = 'FORBIDDEN';
    throw err;
  }

  const conversation = await resolveConversationForViewer(conversationId, viewerId, viewerRole);
  if (!conversation) {
    const err = new Error('Conversation not found');
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  const text = String(textRaw || '').trim();
  if (!text) {
    const err = new Error('Message text is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }

  const insert = await pool.query<MessageRow>(
    `INSERT INTO chat_messages (conversation_id, sender_id, sender_role, text)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id, sender_id, sender_role, text, created_at`,
    [conversationId, viewerId, viewerRole, text.slice(0, 4000)]
  );

  const createdAt = insert.rows[0].created_at;
  if (viewerRole === 'personal') {
    await pool.query(
      `UPDATE chat_conversations
       SET updated_at = $2,
           last_read_at_by_personal = $2
       WHERE id = $1`,
      [conversationId, createdAt]
    );
  } else {
    await pool.query(
      `UPDATE chat_conversations
       SET updated_at = $2,
           last_read_at_by_student = $2
       WHERE id = $1`,
      [conversationId, createdAt]
    );
  }

  return mapMessage(insert.rows[0]);
}
