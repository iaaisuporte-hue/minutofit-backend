/**
 * Prepara um banco de testes do ZERO (uso: CI e ambiente local novo).
 *
 * Monta o schema exatamente como a produção o monta:
 *
 *   schema base (`db:seed`)  →  runBootChain()  =  migrations + ensure*
 *
 * Roda a MESMA `runBootChain` do `index.ts`, e não uma lista paralela de
 * passos. Se as duas divergissem, o CI passaria a validar um schema que não
 * existe em lugar nenhum — que é a pior forma de teste verde.
 *
 * Recusa-se a rodar contra qualquer banco que não pareça de teste: o script faz
 * DDL, e apontá-lo para produção seria irreversível.
 */
import pool from '../config/database';
import logger from '../lib/logger';
import { runBootChain } from '../db/bootChain';
import { assertSafeQaDatabase, UnsafeQaDatabaseError } from '../utils/qaSafety';

async function main(): Promise<void> {
  // SPEC 035: checagem consolidada em `qaSafety.ts` (fonte única) — este
  // script fazia sua própria checagem inline; agora reusa a mesma regra que
  // `config/database.ts` aplica quando QA_SAFE_MODE=1.
  try {
    assertSafeQaDatabase(process.env.DATABASE_URL);
  } catch (err) {
    if (err instanceof UnsafeQaDatabaseError) {
      console.error(`[prepare-test-db] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const nomeDoBanco = new URL(process.env.DATABASE_URL as string).pathname.replace(/^\//, '');
  logger.info({ banco: nomeDoBanco }, '[prepare-test-db] montando schema');
  await runBootChain();
  logger.info('[prepare-test-db] schema pronto');
  await pool.end();
}

main().catch((err) => {
  console.error('[prepare-test-db] falhou:', err);
  process.exit(1);
});
