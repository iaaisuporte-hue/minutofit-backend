/**
 * Regressão do seed da biblioteca de exercícios contra o índice PARCIAL
 * (Sprint P1, migration 1837000000000).
 *
 * `exercises_name_source_uq` deixou de ser um UNIQUE simples e virou um
 * índice único parcial (`WHERE owner_personal_id IS NULL AND status =
 * 'active'`). Todo `ON CONFLICT (normalized_name, source)` precisa repetir
 * esse predicado ou o Postgres recusa a query com "no unique or exclusion
 * constraint matching the ON CONFLICT specification" — e só acontece quando
 * já existe linha em conflito (por isso um mock/unit test não pega: precisa
 * de dado real já gravado). Foi exatamente esse defeito que passou batido em
 * `seedExercisesLibrary.core.ts` nesta sprint, achado só em QA de navegador.
 *
 * `corefit_ci_test` já chega com o catálogo global populado (boot chain do
 * `db:prepare-test`) — então basta rodar `runExercisesSeed` de novo aqui
 * para cair direto no caminho `DO UPDATE` que reproduz o bug quando o
 * predicado está errado.
 */
import type { Client } from 'pg';

import { acquireSuiteLock, connect, describeWithDb, finishSuite, hasTestDb } from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(60_000);

describeWithDb('Seed da biblioteca de exercícios · ON CONFLICT contra índice parcial', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
  });

  afterAll(async () => {
    await finishSuite(c);
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  it('roda sem erro de ON CONFLICT mesmo com o catálogo global já populado', async () => {
    const pool = (await import('../config/database')).default;
    const { runExercisesSeed } = await import('../db/seedExercisesLibrary.core');

    const result = await runExercisesSeed(pool);

    expect(result.total).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
  });
});
