/**
 * Retenção de dados — LGPD / custo de armazenamento.
 *
 * Política: dados operacionais com mais de 12 meses são removidos das tabelas
 * de logs e mensagens.
 *
 * Tabelas limpas:
 *   - academy_audit_log   → registros de ações administrativas
 *   - chat_messages       → mensagens individuais de conversas
 *
 * NÃO remove: dados de usuário, assinaturas, pagamentos, workouts, checkins.
 * Esses dados têm retenção indefinida até exclusão explícita de conta.
 *
 * Agendamento: `src/scripts/runCronJobs.ts` (Render Cron `daily`). Não se
 * auto-agenda mais — o `setInterval` in-process não sobrevivia aos reinícios do
 * serviço, então a purga prometida na Política de Privacidade não completava.
 */

import pool from '../config/database';
import logger from '../lib/logger';

const RETENTION_MONTHS = 12;

export interface DataRetentionResult {
  auditDeleted: number;
  chatDeleted: number;
  retentionMonths: number;
}

/**
 * Erros são PROPAGADOS de propósito: o runner de cron reporta ao Sentry e falha
 * a execução. Antes esta função engolia a exceção num `logger.error` e retornava
 * normalmente — uma rotina de LGPD falhando em silêncio parecia ter rodado.
 */
export async function runDataRetention(): Promise<DataRetentionResult> {
  const cutoff = `NOW() - INTERVAL '${RETENTION_MONTHS} months'`;

  const auditResult = await pool.query(`DELETE FROM academy_audit_log WHERE created_at < ${cutoff}`);
  const auditDeleted = auditResult.rowCount ?? 0;

  const chatResult = await pool.query(`DELETE FROM chat_messages WHERE created_at < ${cutoff}`);
  const chatDeleted = chatResult.rowCount ?? 0;

  if (auditDeleted > 0 || chatDeleted > 0) {
    logger.info(
      { auditDeleted, chatDeleted, retentionMonths: RETENTION_MONTHS },
      '[dataRetention] cleanup completo',
    );
  }

  return { auditDeleted, chatDeleted, retentionMonths: RETENTION_MONTHS };
}
