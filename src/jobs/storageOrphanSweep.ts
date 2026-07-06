/**
 * Job de varredura de objetos órfãos no storage (Spec 023 — residual LGPD da 1.4).
 *
 * Re-tenta apagar objetos cuja deleção falhou (registrados em `storage_orphans`).
 * Executa 45s após o boot (defasado do dataRetention p/ não competir) e depois a
 * cada 6h — órfão de dado sensível merece janela mais curta que a retenção diária.
 */
import logger from '../lib/logger';
import { sweepStorageOrphans } from '../services/storageOrphanService';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

async function run(): Promise<void> {
  try {
    await sweepStorageOrphans();
  } catch (err: any) {
    logger.error({ err: err?.message }, '[storageOrphanSweep] erro na varredura');
  }
}

export function scheduleStorageOrphanSweep(): void {
  setTimeout(() => {
    void run();
  }, 45_000);

  setInterval(() => {
    void run();
  }, SIX_HOURS_MS);

  logger.info('[storageOrphanSweep] job agendado (varredura a cada 6h)');
}
