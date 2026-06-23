import pool from '../config/database';

export type TemplateScope = 'personal' | 'academy' | 'corefit';

export type MessageTemplate = {
  id: number;
  personalId: number | null;
  academyId: number | null;
  scope: TemplateScope;
  category: string;
  title: string;
  body: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateTemplateInput = {
  category: string;
  title: string;
  body: string;
  isDefault?: boolean;
};

// ---------------------------------------------------------------------------
// List: corefit (global) + academy (if context) + personal (own)
// Deduplicado por title; ordenado corefit first, depois academy, depois personal.
// ---------------------------------------------------------------------------

export async function listVisibleTemplates(
  personalId: number,
  academyId: number | null
): Promise<MessageTemplate[]> {
  const result = await pool.query(
    `SELECT
       id, personal_id, academy_id, scope, category, title, body, is_default,
       created_at, updated_at,
       CASE scope WHEN 'corefit' THEN 0 WHEN 'academy' THEN 1 ELSE 2 END AS sort_order
     FROM personal_message_templates
     WHERE scope = 'corefit'
        OR (scope = 'personal' AND personal_id = $1)
        OR (scope = 'academy' AND ($2::int IS NULL OR academy_id = $2))
     ORDER BY sort_order, is_default DESC, title ASC`,
    [personalId, academyId]
  );
  return result.rows.map(mapTemplate);
}

export async function createPersonalTemplate(
  personalId: number,
  academyId: number | null,
  input: CreateTemplateInput
): Promise<MessageTemplate> {
  const result = await pool.query(
    `INSERT INTO personal_message_templates
       (personal_id, academy_id, scope, category, title, body, is_default)
     VALUES ($1, $2, 'personal', $3, $4, $5, $6)
     RETURNING *`,
    [personalId, academyId, input.category, input.title, input.body, input.isDefault ?? false]
  );
  return mapTemplate(result.rows[0]);
}

export async function updatePersonalTemplate(
  id: number,
  personalId: number,
  input: Partial<CreateTemplateInput>
): Promise<MessageTemplate> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (input.title !== undefined) { sets.push(`title = $${i++}`); values.push(input.title); }
  if (input.body !== undefined) { sets.push(`body = $${i++}`); values.push(input.body); }
  if (input.category !== undefined) { sets.push(`category = $${i++}`); values.push(input.category); }
  if (input.isDefault !== undefined) { sets.push(`is_default = $${i++}`); values.push(input.isDefault); }

  if (sets.length === 0) throw new Error('Nothing to update');
  sets.push(`updated_at = NOW()`);

  values.push(id, personalId);
  const result = await pool.query(
    `UPDATE personal_message_templates
     SET ${sets.join(', ')}
     WHERE id = $${i++} AND personal_id = $${i++} AND scope = 'personal'
     RETURNING *`,
    values
  );
  if (result.rowCount === 0) {
    const err = new Error('Template not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  return mapTemplate(result.rows[0]);
}

export async function deletePersonalTemplate(id: number, personalId: number): Promise<void> {
  const result = await pool.query(
    `DELETE FROM personal_message_templates
     WHERE id = $1 AND personal_id = $2 AND scope = 'personal'`,
    [id, personalId]
  );
  if (result.rowCount === 0) {
    const err = new Error('Template not found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
}

function mapTemplate(row: any): MessageTemplate {
  return {
    id: row.id,
    personalId: row.personal_id,
    academyId: row.academy_id,
    scope: row.scope,
    category: row.category,
    title: row.title,
    body: row.body,
    isDefault: row.is_default,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
