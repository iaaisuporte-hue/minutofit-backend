/**
 * Executor de rotinas agendadas — chamado por Render Cron Jobs.
 *
 * ## Por que existe
 *
 * As rotinas viviam como `setTimeout(30-60s)` + `setInterval(24h)` DENTRO do
 * processo web (`src/index.ts`). Num serviço que reinicia a cada deploy — e o
 * Render reinicia também por health check e por escala — o intervalo de 24h
 * praticamente nunca chega a disparar: só a passada inicial roda, e o ciclo
 * morre junto com o processo. Na prática:
 *
 *   - assinatura Pro vencida nunca expirava (academia/personal usando sem pagar);
 *   - a purga de retenção de 12 meses (LGPD) não completava de forma consistente;
 *   - a graça de 30 dias do App bônus não expirava sozinha.
 *
 * Como processo separado com agendamento externo, a execução não depende mais do
 * uptime do web service.
 *
 * ## Uso
 *
 *   node dist/scripts/runCronJobs.js daily
 *   node dist/scripts/runCronJobs.js six-hourly
 *
 * ## Garantias
 *
 * - **Advisory lock por tarefa**: duas execuções concorrentes (cron sobreposto,
 *   ou cron + agendamento legado durante a transição) não duplicam efeito.
 *   O lock é liberado ao fim da sessão, inclusive se o processo morrer.
 * - **Falha é visível**: cada tarefa reporta ao Sentry e o processo termina com
 *   exit code ≠ 0, para o Render marcar a execução como falha. Antes os jobs
 *   engoliam o erro num `logger.error` e seguiam — falha silenciosa em rotina
 *   de negócio e de LGPD.
 * - **Uma tarefa que falha não impede as outras**: todas rodam, o exit code
 *   agrega o resultado.
 */

import * as Sentry from '@sentry/node';
import pool from '../config/database';
import logger from '../lib/logger';

import { expireOverdueGraces } from '../services/membershipService';
import { expireOverdueAcademySubs } from '../services/academySubscriptionService';
import { expireStaleRequests } from '../services/connectionRequestService';
import { sweepStorageOrphans } from '../services/storageOrphanService';
import { runDataRetention } from '../jobs/dataRetention';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
  });
}

type Schedule = 'daily' | 'six-hourly';

interface Task {
  name: string;
  /** Chave do advisory lock. Estável — mudar libera execução concorrente. */
  lockKey: number;
  run: () => Promise<unknown>;
}

const TASKS: Record<Schedule, Task[]> = {
  daily: [
    { name: 'graceExpiry', lockKey: 8101, run: expireOverdueGraces },
    { name: 'academySubExpiry', lockKey: 8102, run: expireOverdueAcademySubs },
    { name: 'staleRequestExpiry', lockKey: 8103, run: expireStaleRequests },
    { name: 'dataRetention', lockKey: 8104, run: runDataRetention },
    { name: 'revokedTokenCleanup', lockKey: 8105, run: cleanupRevokedTokens },
  ],
  'six-hourly': [
    { name: 'storageOrphanSweep', lockKey: 8106, run: sweepStorageOrphans },
  ],
};

/**
 * Limpa refresh tokens revogados já expirados. Antes só rodava no boot
 * (`ensureRevokedTokensSchema`), então uma instância de vida longa acumulava
 * linhas indefinidamente.
 */
async function cleanupRevokedTokens(): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM revoked_refresh_tokens WHERE expires_at < NOW()`);
  return rowCount ?? 0;
}

/**
 * Executa a tarefa sob advisory lock. Se o lock estiver tomado, pula — outra
 * execução já está fazendo o trabalho, e todas as tarefas são idempotentes.
 */
async function runWithLock(task: Task): Promise<{ ok: boolean; skipped: boolean }> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [task.lockKey]);
    if (!rows[0]?.acquired) {
      logger.warn({ task: task.name }, '[cron] lock ocupado — outra execução em andamento, pulando');
      return { ok: true, skipped: true };
    }

    const startedAt = Date.now();
    try {
      const result = await task.run();
      logger.info(
        { task: task.name, ms: Date.now() - startedAt, result: result ?? null },
        '[cron] tarefa concluída',
      );
      return { ok: true, skipped: false };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [task.lockKey]);
    }
  } catch (err) {
    logger.error({ err, task: task.name }, '[cron] tarefa FALHOU');
    Sentry.captureException(err, { tags: { cron_task: task.name } });
    return { ok: false, skipped: false };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const schedule = process.argv[2] as Schedule | undefined;
  if (!schedule || !(schedule in TASKS)) {
    console.error(`Uso: runCronJobs.js <${Object.keys(TASKS).join('|')}>`);
    process.exit(2);
  }

  logger.info({ schedule }, '[cron] início');
  const results = await Promise.all(TASKS[schedule].map(runWithLock));

  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  logger.info({ schedule, total: results.length, failed, skipped }, '[cron] fim');

  if (process.env.SENTRY_DSN) await Sentry.flush(2000);
  await pool.end();

  // Exit ≠ 0 faz o Render marcar a execução como falha e alertar.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  logger.fatal({ err }, '[cron] erro fatal');
  Sentry.captureException(err, { tags: { cron_task: 'bootstrap' } });
  if (process.env.SENTRY_DSN) await Sentry.flush(2000);
  process.exit(1);
});
