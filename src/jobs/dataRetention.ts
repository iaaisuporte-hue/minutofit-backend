/**
 * Job de retenção de dados — LGPD / custo de armazenamento.
 *
 * Política: dados operacionais com mais de 12 meses são removidos das tabelas
 * de logs e mensagens. Executa uma vez por dia no boot e depois a cada 24h.
 *
 * Tabelas limpas:
 *   - academy_audit_log   → registros de ações administrativas
 *   - chat_messages       → mensagens individuais de conversas
 *
 * NÃO remove: dados de usuário, assinaturas, pagamentos, workouts, checkins.
 * Esses dados têm retenção indefinida até exclusão explícita de conta.
 */

import pool from '../config/database';
import logger from '../lib/logger';

const RETENTION_MONTHS = 12;

export async function runDataRetention(): Promise<void> {
  const cutoff = `NOW() - INTERVAL '${RETENTION_MONTHS} months'`;

  try {
    const auditResult = await pool.query(
      `DELETE FROM academy_audit_log WHERE created_at < ${cutoff}`
    );
    const auditDeleted = auditResult.rowCount ?? 0;

    const chatResult = await pool.query(
      `DELETE FROM chat_messages WHERE created_at < ${cutoff}`
    );
    const chatDeleted = chatResult.rowCount ?? 0;

    if (auditDeleted > 0 || chatDeleted > 0) {
      logger.info(
        { auditDeleted, chatDeleted, retentionMonths: RETENTION_MONTHS },
        '[dataRetention] cleanup completo'
      );
    } else {
      logger.debug({ retentionMonths: RETENTION_MONTHS }, '[dataRetention] nenhum registro removido');
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, '[dataRetention] erro ao executar cleanup');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function scheduleDataRetention(): void {
  // Executa imediatamente no primeiro boot (com delay para o DB estar pronto)
  setTimeout(() => {
    runDataRetention();
  }, 30_000);

  // Depois repete a cada 24h
  setInterval(() => {
    runDataRetention();
  }, DAY_MS);

  logger.info('[dataRetention] job agendado (12 meses de retenção)');
}
