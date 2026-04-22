import pool from '../config/database';

export async function ensureMessagesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id                       SERIAL PRIMARY KEY,
      personal_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_read_at_by_student  TIMESTAMPTZ,
      last_read_at_by_personal TIMESTAMPTZ,
      UNIQUE(personal_id, student_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role     VARCHAR(20) NOT NULL CHECK (sender_role IN ('user', 'personal', 'admin', 'nutri')),
      text            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_personal_updated
      ON chat_conversations(personal_id, updated_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_student_updated
      ON chat_conversations(student_id, updated_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
      ON chat_messages(conversation_id, created_at ASC)
  `);
}
