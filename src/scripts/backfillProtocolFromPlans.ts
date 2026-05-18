/**
 * Backfill assigned workout plans into personal protocols and link them via
 * personal_workout_plans.source_protocol_id.
 *
 * Usage: npm run script:backfill-protocols
 */

import pool from '../config/database';
import logger from '../lib/logger';

type PlanDay = {
  index: number;
  name: string;
  focus: string | null;
  items: unknown[];
};

function normalizeDays(row: Record<string, unknown>): PlanDay[] {
  const rawDays = Array.isArray(row.days) ? row.days : [];
  const days = rawDays
    .filter((day) => day && day.index != null)
    .map((day, idx) => ({
      index: Number(day.index) || idx + 1,
      name: String(day.name || `Dia ${idx + 1}`),
      focus: day.focus == null ? null : String(day.focus),
      items: Array.isArray(day.items) ? day.items : [],
    }));

  if (days.length > 0) return days;
  return [{
    index: 1,
    name: 'Único',
    focus: row.selected_group == null ? null : String(row.selected_group),
    items: Array.isArray(row.payload_json) ? row.payload_json : [],
  }];
}

async function main() {
  logger.info('[backfill:protocols] Iniciando vínculo fichas ↔ protocolos...');

  const rows = await pool.query(
    `SELECT p.id,
            p.personal_id,
            p.academy_id,
            p.title,
            p.week_preset,
            p.selected_group,
            p.payload_json,
            COALESCE(
              json_agg(
                json_build_object(
                  'index', d.day_index,
                  'name', d.name,
                  'focus', d.focus,
                  'items', d.payload_json
                ) ORDER BY d.day_index
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'::json
            ) AS days
     FROM personal_workout_plans p
     LEFT JOIN personal_workout_plan_days d ON d.plan_id = p.id
     WHERE p.source_protocol_id IS NULL
     GROUP BY p.id
     ORDER BY p.id`
  );

  let linked = 0;
  let created = 0;

  for (const row of rows.rows) {
    const days = normalizeDays(row);
    const primaryItems = days.find((day) => day.items.length > 0)?.items ?? [];

    const existing = await pool.query(
      `SELECT id
       FROM workout_protocols
       WHERE scope = 'personal'
         AND owner_personal_id = $1
         AND ($2::int IS NULL AND academy_id IS NULL OR academy_id = $2)
         AND title = $3
         AND (days_json = $4::jsonb OR payload_json = $5::jsonb)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [row.personal_id, row.academy_id ?? null, row.title, JSON.stringify(days), JSON.stringify(primaryItems)]
    );

    let protocolId: number;
    if (existing.rows.length) {
      protocolId = Number(existing.rows[0].id);
      linked++;
    } else {
      const inserted = await pool.query(
        `INSERT INTO workout_protocols
           (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json, days_json, updated_at)
         VALUES ('personal', $1, $2, $3, NULL, '{}'::jsonb, $4, $5, $6::jsonb, $7::jsonb, NOW())
         RETURNING id`,
        [
          row.academy_id ?? null,
          row.personal_id,
          row.title,
          String(row.week_preset || '5'),
          row.selected_group ?? null,
          JSON.stringify(primaryItems),
          JSON.stringify(days),
        ]
      );
      protocolId = Number(inserted.rows[0].id);
      created++;
    }

    await pool.query(
      `UPDATE personal_workout_plans
       SET source_protocol_id = $1, updated_at = updated_at
       WHERE id = $2 AND source_protocol_id IS NULL`,
      [protocolId, row.id]
    );
  }

  logger.info({ scanned: rows.rowCount, linked, created }, '[backfill:protocols] Concluído');
  await pool.end();
}

main().catch(async (err) => {
  logger.error({ err }, '[backfill:protocols] Falha fatal');
  await pool.end().catch(() => undefined);
  process.exit(1);
});
