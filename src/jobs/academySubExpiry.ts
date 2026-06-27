/**
 * Spec 018 — Job de auto-expiração da assinatura da academia.
 *
 * A assinatura Pro só muda de status via webhook do Mercado Pago. Se o webhook se
 * perde, a academia fica "Pro" para sempre sem pagar. `expireOverdueAcademySubs()`
 * marca como `expired` (Pro off) o que venceu além da graça — idempotente.
 *
 * Mesmo padrão do graceExpiry: setInterval in-process 1×/dia + endpoint admin manual
 * (`POST /api/admin/academies/subscriptions/expire-overdue`) para forçar fora do ciclo.
 */

import logger from '../lib/logger';
import { expireOverdueAcademySubs } from '../services/academySubscriptionService';

const DAY_MS = 24 * 60 * 60 * 1000;

async function runAcademySubExpiry(): Promise<void> {
  try {
    const { evaluated, expired } = await expireOverdueAcademySubs();
    if (expired > 0) {
      logger.info({ evaluated, expired }, '[academySubExpiry] assinaturas vencidas expiradas');
    }
  } catch (err) {
    logger.error({ err }, '[academySubExpiry] erro ao expirar assinaturas');
  }
}

export function scheduleAcademySubExpiry(): void {
  // Primeira passada logo após o boot (delay para o DB estar pronto).
  setTimeout(() => {
    void runAcademySubExpiry();
  }, 60_000);

  // Depois, diariamente.
  setInterval(() => {
    void runAcademySubExpiry();
  }, DAY_MS);

  logger.info('[academySubExpiry] job agendado (expira assinaturas vencidas 1×/dia)');
}
