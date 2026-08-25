import pool from '../config/database';
import logger from '../lib/logger';
import { autoAssignDefaultPersonalForDirectSignup } from '../services/authService';

/**
 * Backfill one-off: vincula um aluno já existente ao personal padrão
 * (personal@treinai.com), reusando exatamente a mesma lógica do signup
 * público direto. Uso: tsx src/scripts/backfillDefaultPersonalAssignment.ts <userId> [userId...]
 */
async function main() {
  const ids = process.argv.slice(2).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error('Uso: tsx src/scripts/backfillDefaultPersonalAssignment.ts <userId> [userId...]');
    process.exit(1);
  }

  for (const studentId of ids) {
    await autoAssignDefaultPersonalForDirectSignup(studentId);
    console.log(`[backfill] processed studentId=${studentId}`);
  }

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[backfill] default personal assignment failed');
  process.exit(1);
});
