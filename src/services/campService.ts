import pool from '../config/database';
import type { CompetitionCamp, CampWithDerived, CampPhase } from '../types/sport';

function deriveCampPhase(daysRemaining: number, weeksPlanned: number | null): CampPhase {
  const totalDays = (weeksPlanned ?? 8) * 7;
  const elapsed = totalDays - daysRemaining;
  const pct = totalDays > 0 ? elapsed / totalDays : 0;

  if (daysRemaining <= 7) return 'taper';
  if (pct >= 0.7) return 'peak';
  if (pct >= 0.35) return 'specific';
  return 'base';
}

function toCampWithDerived(row: CompetitionCamp & { current_weight_kg?: number | null }): CampWithDerived {
  const ms = new Date(row.event_date).getTime() - Date.now();
  const daysRemaining = Math.max(0, Math.ceil(ms / 86400000));
  return {
    ...row,
    days_remaining: daysRemaining,
    camp_phase: deriveCampPhase(daysRemaining, row.weeks_planned ?? null),
    current_weight_kg: row.current_weight_kg ?? null,
  };
}

export async function autoCompletePastCamps(userId: number): Promise<void> {
  await pool.query(
    `UPDATE athlete_competition_camp
     SET status = 'completed', updated_at = NOW()
     WHERE user_id = $1 AND status = 'active' AND event_date < CURRENT_DATE`,
    [userId],
  );
}

export async function listCamps(userId: number, status?: string): Promise<CampWithDerived[]> {
  await autoCompletePastCamps(userId);

  let q = `SELECT c.*, sp.current_weight_kg
           FROM athlete_competition_camp c
           LEFT JOIN user_sport_profile sp ON sp.user_id = c.user_id
           WHERE c.user_id = $1`;
  const params: unknown[] = [userId];

  if (status) {
    params.push(status);
    q += ` AND c.status = $${params.length}`;
  }
  q += ` ORDER BY c.event_date ASC`;

  const { rows } = await pool.query(q, params);
  return rows.map(toCampWithDerived);
}

export async function getActiveCamp(userId: number): Promise<CampWithDerived | null> {
  await autoCompletePastCamps(userId);
  const camps = await listCamps(userId, 'active');
  return camps[0] ?? null;
}

export async function createCamp(
  userId: number,
  data: Pick<CompetitionCamp, 'event_name' | 'event_date'> & Partial<Omit<CompetitionCamp, 'id' | 'user_id' | 'created_at' | 'updated_at'>>,
): Promise<CampWithDerived> {
  const { rows } = await pool.query<CompetitionCamp>(
    `INSERT INTO athlete_competition_camp
       (user_id, event_name, event_date, category, target_weight_kg, weeks_planned, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      userId,
      data.event_name,
      data.event_date,
      data.category ?? null,
      data.target_weight_kg ?? null,
      data.weeks_planned ?? null,
      data.status ?? 'planning',
    ],
  );

  // Auto-activate if this is the only camp and status is planning
  if (rows[0].status === 'planning') {
    const active = await listCamps(userId, 'active');
    if (active.length === 0) {
      await pool.query(
        `UPDATE athlete_competition_camp SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [rows[0].id],
      );
      rows[0].status = 'active';
    }
  }

  const sp = await pool.query(`SELECT current_weight_kg FROM user_sport_profile WHERE user_id = $1`, [userId]);
  return toCampWithDerived({ ...rows[0], current_weight_kg: sp.rows[0]?.current_weight_kg ?? null });
}

export async function updateCamp(
  userId: number,
  campId: number,
  data: Partial<Pick<CompetitionCamp, 'status' | 'target_weight_kg' | 'event_name' | 'event_date' | 'category' | 'weeks_planned'>>,
): Promise<CampWithDerived | null> {
  const fields: string[] = [];
  const params: unknown[] = [userId, campId];

  const allowed: (keyof typeof data)[] = ['status', 'target_weight_kg', 'event_name', 'event_date', 'category', 'weeks_planned'];
  for (const key of allowed) {
    if (key in data) {
      params.push(data[key]);
      fields.push(`${key} = $${params.length}`);
    }
  }
  if (fields.length === 0) return null;
  fields.push('updated_at = NOW()');

  const { rows } = await pool.query<CompetitionCamp>(
    `UPDATE athlete_competition_camp SET ${fields.join(', ')}
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    params,
  );
  if (!rows[0]) return null;

  const sp = await pool.query(`SELECT current_weight_kg FROM user_sport_profile WHERE user_id = $1`, [userId]);
  return toCampWithDerived({ ...rows[0], current_weight_kg: sp.rows[0]?.current_weight_kg ?? null });
}
