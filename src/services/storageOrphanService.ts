/**
 * Storage Orphan Sweep (Spec 023 — residual LGPD da Frente 1.4).
 *
 * Rastro durável + reconciliação de objetos de storage cuja deleção falhou.
 * Produtores (admin user-delete, deletePhoto do aluno) registram via
 * `recordStorageOrphan`; o job `sweepStorageOrphans` re-tenta os pendentes até
 * apagar de verdade (ou abandonar após MAX_ATTEMPTS). Ver migration
 * 1812000000000_storage-orphans.
 *
 * Tabela de OPERAÇÃO — sem `academy_id`, sem isolamento por tenant. `getStorageOrphanSummary`
 * devolve só contagens agregadas (nunca `storage_key`), para observabilidade admin.
 */
import pool from '../config/database';
import logger from '../lib/logger';
import { getStorage, isStorageConfigured } from '../lib/storage';

export type StorageOrphanReason = 'admin_user_delete' | 'student_delete' | 'storage_not_configured';

const MAX_ATTEMPTS = 10;
const SWEEP_BATCH = 100;

/**
 * Registra um objeto cuja deleção falhou (ou não pôde ser tentada). Idempotente:
 * no máximo 1 linha PENDENTE por `storage_key` (índice único parcial + ON CONFLICT
 * DO NOTHING). NUNCA lança — registrar o órfão não pode derrubar o fluxo chamador
 * (ex.: exclusão de conta não pode falhar porque o log de órfão falhou).
 */
export async function recordStorageOrphan(
  storageKey: string,
  reason: StorageOrphanReason,
  context?: Record<string, unknown>,
  lastError?: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO storage_orphans (storage_key, reason, context, last_error)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (storage_key) WHERE status = 'pending' DO NOTHING`,
      [storageKey, reason, context ? JSON.stringify(context) : null, lastError ?? null],
    );
  } catch (err: any) {
    // Último recurso: se nem registrar deu, ao menos loga (o fluxo chamador segue).
    logger.error({ err: err?.message, storageKey, reason }, '[storageOrphan] falha ao registrar órfão');
  }
}

/**
 * Job: re-tenta apagar os objetos pendentes. Sucesso → `resolved`; após
 * MAX_ATTEMPTS falhas → `abandoned` (não re-tenta infinito). No-op se o storage
 * não estiver configurado (tenta de novo na próxima janela).
 */
export async function sweepStorageOrphans(): Promise<void> {
  if (!isStorageConfigured()) return;
  const storage = getStorage();

  const { rows } = await pool.query<{ id: number; storage_key: string; attempts: number }>(
    `SELECT id, storage_key, attempts FROM storage_orphans
      WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [SWEEP_BATCH],
  );
  if (rows.length === 0) return;

  let resolved = 0;
  let abandoned = 0;
  let stillPending = 0;
  for (const row of rows) {
    try {
      await storage.deleteObject(row.storage_key);
      await pool.query(
        `UPDATE storage_orphans SET status='resolved', resolved_at=NOW(), updated_at=NOW(),
           attempts = attempts + 1 WHERE id = $1`,
        [row.id],
      );
      resolved++;
    } catch (err: any) {
      const attempts = row.attempts + 1;
      const nextStatus = attempts >= MAX_ATTEMPTS ? 'abandoned' : 'pending';
      await pool.query(
        `UPDATE storage_orphans SET status=$2, attempts=$3, last_error=$4, updated_at=NOW() WHERE id=$1`,
        [row.id, nextStatus, attempts, err?.message ?? 'unknown'],
      );
      if (nextStatus === 'abandoned') abandoned++;
      else stillPending++;
    }
  }
  logger.info({ resolved, abandoned, stillPending }, '[storageOrphanSweep] varredura concluída');
}

/** Contagens agregadas para observabilidade admin — nunca expõe `storage_key`. */
export async function getStorageOrphanSummary(): Promise<{
  pending: number;
  abandoned: number;
  resolvedLast24h: number;
}> {
  const { rows } = await pool.query<{ pending: string; abandoned: string; resolved_24h: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')                                                    AS pending,
       COUNT(*) FILTER (WHERE status = 'abandoned')                                                  AS abandoned,
       COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at > NOW() - INTERVAL '24 hours')     AS resolved_24h
     FROM storage_orphans`,
  );
  const r = rows[0];
  return {
    pending: Number(r?.pending ?? 0),
    abandoned: Number(r?.abandoned ?? 0),
    resolvedLast24h: Number(r?.resolved_24h ?? 0),
  };
}
