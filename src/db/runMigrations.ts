import { resolve } from 'path';
import logger from '../lib/logger';

// node-pg-migrate exports via CJS bundle; `require` avoids moduleResolution issues with 'node' strategy
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgMigrate = require('node-pg-migrate') as { run: Function };

/**
 * Executa migrations pendentes via node-pg-migrate antes do boot chain dos ensure*.
 * Idempotente: migrations já aplicadas são ignoradas.
 * Em erro, loga e re-lança para parar o boot (migrations são pré-requisito de schema).
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn('[migrations] DATABASE_URL não definida — pulando migrations');
    return;
  }

  const migrationsDir = resolve(__dirname, '../../migrations');

  const t = Date.now();
  try {
    const result = await pgMigrate.run({
      databaseUrl,
      migrationsTable: 'pgmigrations',
      dir: migrationsDir,
      direction: 'up',
      count: Infinity,
      log: (msg: string) => logger.debug({ msg }, '[migrations]'),
    });
    logger.info(
      { applied: result.length, ms: Date.now() - t },
      '[migrations] completed'
    );
  } catch (err) {
    logger.error({ err, ms: Date.now() - t }, '[migrations] FAILED — aborting boot');
    throw err;
  }
}
