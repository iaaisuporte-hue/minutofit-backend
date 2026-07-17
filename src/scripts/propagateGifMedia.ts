/**
 * Propaga a mídia primária do gifdotreino para exercícios DUPLICADOS de outros
 * sources (ex.: 'metacore'), casando por normalized_name.
 *
 * Contexto: o banco tem dois conjuntos paralelos de exercícios (source 'corefit'
 * e 'metacore'). A seed (seedExercisesLibrary) só grava mídia nos 'corefit'
 * (ON CONFLICT por normalized_name+source), mas as fichas referenciam os
 * 'metacore' — então o GIF não aparecia no treino. Este script copia o GIF do
 * exercício 'corefit' para o exercício de mesmo normalized_name em qualquer
 * outro source, como mídia primária (demovendo o free-exercise-db).
 *
 * Idempotente (ON CONFLICT (exercise_id, url) DO UPDATE). Read-only-safe: só
 * mexe em exercise_media.
 *
 * Uso: npx tsx src/scripts/propagateGifMedia.ts
 */
import pool from '../config/database';
import logger from '../lib/logger';

async function main(): Promise<void> {
  // 1) fonte da verdade: gifs primários já gravados (gifdotreino)
  const gifs = await pool.query<{ normalized_name: string; url: string }>(
    `SELECT DISTINCT e.normalized_name, m.url
       FROM exercises e
       JOIN exercise_media m
         ON m.exercise_id = e.id
        AND m.is_primary = true
        AND m.source = 'gifdotreino'`,
  );
  logger.info({ count: gifs.rows.length }, '[propagate-gif] GIFs de origem encontrados');

  // 2) alvos: exercícios de MESMO normalized_name que ainda não têm esse gif
  const client = await pool.connect();
  let promoted = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const { normalized_name, url } of gifs.rows) {
      const targets = await client.query<{ id: string }>(
        `SELECT id FROM exercises WHERE normalized_name = $1`,
        [normalized_name],
      );
      for (const { id } of targets.rows) {
        // já tem esse gif como primário? pula
        const exists = await client.query(
          `SELECT 1 FROM exercise_media
            WHERE exercise_id = $1 AND url = $2 AND is_primary = true`,
          [id, url],
        );
        if (exists.rowCount) {
          skipped++;
          continue;
        }
        // demove outras primárias e insere/promove o gif
        await client.query(
          `UPDATE exercise_media SET is_primary = false, updated_at = NOW()
            WHERE exercise_id = $1 AND url <> $2 AND is_primary = true`,
          [id, url],
        );
        await client.query(
          `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
           VALUES ($1, 'gif', $2, 'gifdotreino', true)
           ON CONFLICT (exercise_id, url)
           DO UPDATE SET is_primary = true, source = 'gifdotreino', updated_at = NOW()`,
          [id, url],
        );
        promoted++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info({ promoted, skipped }, '[propagate-gif] Concluído');
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[propagate-gif] Falha');
  process.exit(1);
});
