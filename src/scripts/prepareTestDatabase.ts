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

const NOMES_PERMITIDOS = /(test|ci|local|verify)/i;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('[prepare-test-db] DATABASE_URL ausente.');
    process.exit(1);
  }

  const nomeDoBanco = url.split('/').pop()?.split('?')[0] ?? '';
  if (!NOMES_PERMITIDOS.test(nomeDoBanco)) {
    console.error(
      `[prepare-test-db] recusado: "${nomeDoBanco}" não parece banco de teste. ` +
        'O nome precisa conter test, ci, local ou verify. Este script faz DDL.',
    );
    process.exit(1);
  }

  logger.info({ banco: nomeDoBanco }, '[prepare-test-db] montando schema');
  await runBootChain();
  logger.info('[prepare-test-db] schema pronto');
  await pool.end();
}

main().catch((err) => {
  console.error('[prepare-test-db] falhou:', err);
  process.exit(1);
});
