import pool from '../config/database';

export interface ProfessionalContextProfessional {
  id: number;
  name: string;
  photo: string | null;
  lastObservation: { text: string; createdAt: string } | null;
}

export interface ProfessionalContext {
  personal: ProfessionalContextProfessional | null;
  nutri: ProfessionalContextProfessional | null;
}

async function getLatestPersonalObservation(
  personalId: number,
  studentId: number
): Promise<ProfessionalContextProfessional['lastObservation']> {
  const result = await pool.query(
    `SELECT payload_json, created_at
       FROM personal_relationship_actions
      WHERE personal_id = $1
        AND student_id  = $2
        AND action_type = 'observation'
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 1`,
    [personalId, studentId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const text = String(row.payload_json?.note ?? '').trim();
  if (!text) return null;
  return { text, createdAt: new Date(row.created_at).toISOString() };
}

export async function getProfessionalContextForStudent(
  studentId: number
): Promise<ProfessionalContext> {
  const personalRes = await pool.query(
    `SELECT u.id, u.name, u.avatar_url
       FROM personal_student_assignments psa
       JOIN users u ON u.id = psa.personal_id
      WHERE psa.student_id = $1 AND psa.status = 'active'
      ORDER BY psa.updated_at DESC NULLS LAST, psa.id DESC
      LIMIT 1`,
    [studentId]
  );

  let personal: ProfessionalContextProfessional | null = null;
  if (personalRes.rowCount && personalRes.rows[0]) {
    const r = personalRes.rows[0];
    personal = {
      id: r.id,
      name: r.name,
      photo: r.avatar_url ?? null,
      lastObservation: await getLatestPersonalObservation(r.id, studentId),
    };
  }

  const nutriRes = await pool.query(
    `SELECT u.id, u.name, u.avatar_url
       FROM nutri_patient_assignments npa
       JOIN users u ON u.id = npa.nutri_id
      WHERE npa.patient_id = $1 AND npa.status = 'active'
      ORDER BY npa.updated_at DESC NULLS LAST, npa.id DESC
      LIMIT 1`,
    [studentId]
  );

  let nutri: ProfessionalContextProfessional | null = null;
  if (nutriRes.rowCount && nutriRes.rows[0]) {
    const r = nutriRes.rows[0];
    // Nutri ainda não tem timeline de observations equivalente ao personal_relationship_actions
    nutri = {
      id: r.id,
      name: r.name,
      photo: r.avatar_url ?? null,
      lastObservation: null,
    };
  }

  return { personal, nutri };
}
