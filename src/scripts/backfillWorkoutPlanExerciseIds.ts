/**
 * Script de backfill: mapeia exercícios em personal_workout_plans e workout_protocols
 * pelo nome para exercise_id UUID da biblioteca MetaCore.
 *
 * Itens resolvidos: exerciseId = UUID, legacy_exercise_id = original
 * Itens não resolvidos: exerciseId = original mantido, legacy: true
 *
 * Também faz backfill em student_exercise_notes (exercise_key → exercise_id).
 *
 * Uso: npm run backfill:exercises
 */

import pool from '../config/database';
import { findExerciseByName } from '../services/exerciseLibraryService';
import logger from '../lib/logger';

type PlanItem = {
  exerciseId: string;
  name: string;
  legacy?: boolean;
  legacy_exercise_id?: string;
  [key: string]: unknown;
};

async function backfillTable(
  tableName: string,
  idCol: string,
  payloadCol: string
) {
  const rows = await pool.query(`SELECT ${idCol}, ${payloadCol} FROM ${tableName} WHERE ${payloadCol} IS NOT NULL`);
  let planResolved = 0;
  let planUnresolved = 0;

  for (const row of rows.rows) {
    const rawPayload = row[payloadCol];
    const items: PlanItem[] = Array.isArray(rawPayload) ? rawPayload : [];

    if (!items.length) continue;

    let changed = false;
    const newItems: PlanItem[] = [];

    for (const item of items) {
      if (!item.legacy && item.exerciseId && item.exerciseId.match(/^[0-9a-f-]{36}$/i)) {
        // Already a UUID — skip
        newItems.push(item);
        continue;
      }

      const match = await findExerciseByName(item.name || '');
      if (match) {
        newItems.push({
          ...item,
          exerciseId: match.id,
          legacy_exercise_id: item.exerciseId,
          legacy: undefined,
        });
        planResolved++;
        changed = true;
      } else {
        newItems.push({ ...item, legacy: true });
        planUnresolved++;
        changed = true;
      }
    }

    if (changed) {
      await pool.query(
        `UPDATE ${tableName} SET ${payloadCol} = $1::jsonb WHERE ${idCol} = $2`,
        [JSON.stringify(newItems), row[idCol]]
      );
    }
  }

  return { planResolved, planUnresolved };
}

async function backfillStudentNotes() {
  const rows = await pool.query(
    `SELECT id, exercise_name FROM student_exercise_notes WHERE exercise_id IS NULL`
  );

  let resolved = 0;
  let unresolved = 0;

  for (const row of rows.rows) {
    const match = await findExerciseByName(String(row.exercise_name || ''));
    if (match) {
      await pool.query(
        `UPDATE student_exercise_notes SET exercise_id = $1 WHERE id = $2`,
        [match.id, row.id]
      );
      resolved++;
    } else {
      unresolved++;
    }
  }

  return { resolved, unresolved };
}

async function main() {
  logger.info('[backfill:exercises] Iniciando backfill de exercise IDs...');

  const plansResult = await backfillTable('personal_workout_plans', 'id', 'payload_json');
  logger.info(plansResult, '[backfill:exercises] personal_workout_plans processado');

  const protocolsResult = await backfillTable('workout_protocols', 'id', 'payload_json');
  logger.info(protocolsResult, '[backfill:exercises] workout_protocols processado');

  const notesResult = await backfillStudentNotes();
  logger.info(notesResult, '[backfill:exercises] student_exercise_notes processado');

  logger.info('[backfill:exercises] Concluído');
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[backfill:exercises] Falha fatal');
  process.exit(1);
});
