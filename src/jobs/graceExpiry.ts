/**
 * Job de expiração de graça — fecha o footgun "graça nunca expira sozinha".
 *
 * Cancelar Academia/Personal/Nutri coloca o App bônus em `grace_period` (30 dias).
 * `expireOverdueGraces()` marca como `expired` o que já venceu — antes só rodava via
 * endpoint admin manual (`POST /api/admin/memberships/expire-graces`), fácil de esquecer.
 * Aqui agendamos a mesma função (idempotente) para rodar sozinha 1×/dia.
 *
 * O endpoint admin manual continua disponível para forçar fora do ciclo.
 */

import logger from '../lib/logger';
import { expireOverdueGraces } from '../services/membershipService';

const DAY_MS = 24 * 60 * 60 * 1000;

async function runGraceExpiry(): Promise<void> {
  try {
    const count = await expireOverdueGraces();
    if (count > 0) {
      logger.info({ count }, '[graceExpiry] graças vencidas expiradas');
    }
  } catch (err) {
    logger.error({ err }, '[graceExpiry] erro ao expirar graças');
  }
}

export function scheduleGraceExpiry(): void {
  // Primeira passada logo após o boot (delay para o DB estar pronto).
  setTimeout(() => {
    void runGraceExpiry();
  }, 60_000);

  // Depois, diariamente.
  setInterval(() => {
    void runGraceExpiry();
  }, DAY_MS);

  logger.info('[graceExpiry] job agendado (expira graças vencidas 1×/dia)');
}
