import { resolve } from 'path';
import type { PoolClient } from 'pg';
import logger from '../lib/logger';
import pool from '../config/database';

/**
 * `node-pg-migrate` v8 é ESM-only e exporta `runner` (não `run`).
 * Como o backend compila para CommonJS, `tsc` reescreveria `import('node-pg-migrate')`
 * para `require(...)` — quebrando módulos ESM em runtimes que não suportam
 * `require(ESM)`. Este wrapper bypassa a transformação do TS preservando o
 * `import()` dinâmico nativo do Node.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = unknown>(
  specifier: string
) => Promise<T>;

interface NodePgMigrateModule {
  runner: (options: {
    dbClient: PoolClient;
    migrationsTable: string;
    dir: string;
    direction: 'up' | 'down';
    count?: number;
    singleTransaction?: boolean;
    log?: (msg: string) => void;
  }) => Promise<Array<{ name: string }>>;
}

/**
 * Executa migrations pendentes via node-pg-migrate antes do boot chain dos ensure*.
 * Idempotente: migrations já aplicadas (registradas em `pgmigrations`) são ignoradas.
 * Em erro, loga e re-lança para parar o boot (migrations são pré-requisito de schema).
 *
 * Reutiliza o pool central (`config/database.ts`) para herdar a configuração SSL
 * exigida pelo Postgres gerenciado da Render.
 */
export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn('[migrations] DATABASE_URL não definida — pulando migrations');
    return;
  }

  const migrationsDir = resolve(__dirname, '../../migrations');
  const t = Date.now();

  let client: PoolClient | null = null;
  try {
    const { runner } = await dynamicImport<NodePgMigrateModule>('node-pg-migrate');
    client = await pool.connect();
    const applied = await runner({
      dbClient: client,
      migrationsTable: 'pgmigrations',
      dir: migrationsDir,
      direction: 'up',
      count: Infinity,
      singleTransaction: true,
      log: (msg) => logger.debug({ msg }, '[migrations]'),
    });
    logger.info(
      { applied: applied.length, names: applied.map((m) => m.name), ms: Date.now() - t },
      '[migrations] completed'
    );
  } catch (err) {
    logger.error({ err, ms: Date.now() - t }, '[migrations] FAILED — aborting boot');
    throw err;
  } finally {
    client?.release();
  }
}
