import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';

export interface VoiceNote {
  id: string;
  nutriId: number;
  patientId: number;
  body: string;
  anchorMealId: string | null;
  publishedAt: string;
  readAt: string | null;
  nutriName?: string;
  nutriPhoto?: string | null;
}

export interface NutriInsight {
  type: 'adherence_drop' | 'late_hunger' | 'ghost_meal' | 'silent_absence';
  label: string;
  detail: string;
}

// ── Voice notes ─────────────────────────────────────────────────────────────

export async function publishVoiceNote(opts: {
  nutriId: number;
  patientId: number;
  body: string;
  anchorMealId?: string;
  ip?: string;
}): Promise<VoiceNote> {
  const { nutriId, patientId, body, anchorMealId = null, ip } = opts;
  const trimmed = body.trim().slice(0, 240);
  if (!trimmed) throw Object.assign(new Error('body_required'), { status: 400 });

  const { rows } = await pool.query<{
    id: string; nutri_id: number; patient_id: number; body: string;
    anchor_meal_id: string | null; published_at: string; read_at: string | null;
  }>(
    `INSERT INTO nutrition_voice_notes (nutri_id, patient_id, body, anchor_meal_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [nutriId, patientId, trimmed, anchorMealId],
  );
  const note = rows[0]!;

  await logDataAccessEvent({
    actorId: nutriId,
    subjectUserId: patientId,
    eventType: 'voice_note.published',
    eventPayload: { noteId: note.id },
    ip,
  });

  return rowToVoiceNote(note);
}

export async function listVoiceNotesForNutri(
  nutriId: number,
  patientId: number,
): Promise<VoiceNote[]> {
  const { rows } = await pool.query<{
    id: string; nutri_id: number; patient_id: number; body: string;
    anchor_meal_id: string | null; published_at: string; read_at: string | null;
  }>(
    `SELECT * FROM nutrition_voice_notes
     WHERE nutri_id = $1 AND patient_id = $2
     ORDER BY published_at DESC
     LIMIT 20`,
    [nutriId, patientId],
  );
  return rows.map(rowToVoiceNote);
}

export async function listPendingVoiceNotesForPatient(
  patientId: number,
  ip?: string,
): Promise<VoiceNote[]> {
  const { rows } = await pool.query<{
    id: string; nutri_id: number; patient_id: number; body: string;
    anchor_meal_id: string | null; published_at: string; read_at: string | null;
    nutri_name: string; nutri_photo: string | null;
  }>(
    `SELECT vn.*, u.name AS nutri_name, u.avatar_url AS nutri_photo
     FROM nutrition_voice_notes vn
     JOIN users u ON u.id = vn.nutri_id
     WHERE vn.patient_id = $1
       AND vn.published_at >= now() - interval '72 hours'
       AND vn.read_at IS NULL
     ORDER BY vn.published_at DESC`,
    [patientId],
  );

  if (rows.length > 0) {
    for (const row of rows) {
      await logDataAccessEvent({
        actorId: patientId,
        subjectUserId: patientId,
        eventType: 'voice_note.read',
        eventPayload: { noteId: row.id },
        ip,
      });
    }
    // Mark as read in bulk
    const ids = rows.map((r) => r.id);
    await pool.query(
      `UPDATE nutrition_voice_notes SET read_at = now()
       WHERE id = ANY($1::uuid[]) AND read_at IS NULL`,
      [ids],
    );
  }

  return rows.map((r) => ({
    id: r.id,
    nutriId: r.nutri_id,
    patientId: r.patient_id,
    body: r.body,
    anchorMealId: r.anchor_meal_id,
    publishedAt: r.published_at,
    readAt: r.read_at,
    nutriName: r.nutri_name,
    nutriPhoto: r.nutri_photo,
  }));
}

// ── Insights heurísticas TS (on-read, sem AI, sem latência) ─────────────────

export async function computePatientInsights(
  nutriId: number,
  patientId: number,
): Promise<NutriInsight[]> {
  const insights: NutriInsight[] = [];

  // 1. Sumiço silencioso: 0 check-ins em 72h
  const { rows: recentCheckins } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM nutrition_meal_checkins nmc
     JOIN nutrition_plan_meals npm ON npm.id = nmc.meal_id
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE np.patient_id = $1
       AND np.nutri_id = $2
       AND nmc.checked_at >= now() - interval '72 hours'`,
    [patientId, nutriId],
  );
  if (parseInt(recentCheckins[0]?.cnt ?? '0', 10) === 0) {
    insights.push({
      type: 'silent_absence',
      label: 'Sumiço silencioso',
      detail: 'Nenhum check-in nos últimos 3 dias. Uma voz humana pode ajudar.',
    });
  }

  // 2. Adesão caindo: adherence_7d < adherence_30d - 20pp
  const { rows: adh } = await pool.query<{ adh7: string; adh30: string }>(
    `WITH plan_meals AS (
       SELECT npm.id AS meal_id
       FROM nutrition_plan_meals npm
       JOIN nutrition_plans np ON np.id = npm.plan_id
       WHERE np.patient_id = $1 AND np.nutri_id = $2 AND np.status = 'active'
     ),
     checkins_7d AS (
       SELECT COUNT(*) AS done
       FROM nutrition_meal_checkins nmc
       JOIN plan_meals pm ON pm.meal_id = nmc.meal_id
       WHERE nmc.checked_at >= now() - interval '7 days'
         AND nmc.status IN ('done','partial')
     ),
     total_7d AS (
       SELECT COUNT(*) AS total
       FROM nutrition_meal_checkins nmc
       JOIN plan_meals pm ON pm.meal_id = nmc.meal_id
       WHERE nmc.checked_at >= now() - interval '7 days'
     ),
     checkins_30d AS (
       SELECT COUNT(*) AS done
       FROM nutrition_meal_checkins nmc
       JOIN plan_meals pm ON pm.meal_id = nmc.meal_id
       WHERE nmc.checked_at >= now() - interval '30 days'
         AND nmc.status IN ('done','partial')
     ),
     total_30d AS (
       SELECT COUNT(*) AS total
       FROM nutrition_meal_checkins nmc
       JOIN plan_meals pm ON pm.meal_id = nmc.meal_id
       WHERE nmc.checked_at >= now() - interval '30 days'
     )
     SELECT
       CASE WHEN (SELECT total FROM total_7d) > 0
         THEN ROUND(100.0 * (SELECT done FROM checkins_7d) / (SELECT total FROM total_7d))
         ELSE NULL END AS adh7,
       CASE WHEN (SELECT total FROM total_30d) > 0
         THEN ROUND(100.0 * (SELECT done FROM checkins_30d) / (SELECT total FROM total_30d))
         ELSE NULL END AS adh30`,
    [patientId, nutriId],
  );
  const adh7 = adh[0]?.adh7 != null ? parseFloat(adh[0].adh7) : null;
  const adh30 = adh[0]?.adh30 != null ? parseFloat(adh[0].adh30) : null;
  if (adh7 != null && adh30 != null && adh7 < adh30 - 20) {
    insights.push({
      type: 'adherence_drop',
      label: 'Adesão caindo',
      detail: `Adesão esta semana (${adh7}%) caiu ${Math.round(adh30 - adh7)}pp vs. média 30d (${adh30}%). Considere conversar.`,
    });
  }

  // 3. Padrão de fome tardia: ≥3 check-ins com hunger_score≥4 entre 16h–18h em 7d
  const { rows: lateHunger } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM nutrition_meal_checkins nmc
     JOIN nutrition_plan_meals npm ON npm.id = nmc.meal_id
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE np.patient_id = $1
       AND np.nutri_id = $2
       AND nmc.checked_at >= now() - interval '7 days'
       AND nmc.hunger_score >= 4
       AND EXTRACT(HOUR FROM nmc.checked_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 15 AND 18`,
    [patientId, nutriId],
  );
  if (parseInt(lateHunger[0]?.cnt ?? '0', 10) >= 3) {
    insights.push({
      type: 'late_hunger',
      label: 'Picos de fome 16h–18h',
      detail: 'Fome alta repetida no fim da tarde. O lanche pode estar leve demais.',
    });
  }

  // 4. Refeição fantasma: mesma refeição substituída/pulada ≥4× em 7d
  const { rows: ghost } = await pool.query<{ meal_name: string; cnt: string }>(
    `SELECT npm.name AS meal_name, COUNT(*) AS cnt
     FROM nutrition_meal_checkins nmc
     JOIN nutrition_plan_meals npm ON npm.id = nmc.meal_id
     JOIN nutrition_plans np ON np.id = npm.plan_id
     WHERE np.patient_id = $1
       AND np.nutri_id = $2
       AND nmc.checked_at >= now() - interval '7 days'
       AND nmc.status IN ('skipped','substituted')
     GROUP BY npm.name
     HAVING COUNT(*) >= 4`,
    [patientId, nutriId],
  );
  for (const row of ghost) {
    insights.push({
      type: 'ghost_meal',
      label: `Refeição frequentemente pulada`,
      detail: `"${row.meal_name}" foi pulada ou substituída ${row.cnt}× nos últimos 7 dias. Considere ajustar.`,
    });
  }

  return insights;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToVoiceNote(r: {
  id: string; nutri_id: number; patient_id: number; body: string;
  anchor_meal_id: string | null; published_at: string; read_at: string | null;
}): VoiceNote {
  return {
    id: r.id,
    nutriId: r.nutri_id,
    patientId: r.patient_id,
    body: r.body,
    anchorMealId: r.anchor_meal_id,
    publishedAt: r.published_at,
    readAt: r.read_at,
  };
}
