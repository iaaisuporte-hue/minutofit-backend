/**
 * Suporte a testes de integração com banco REAL.
 *
 * Os testes unitários deste repo mockam `config/database`. Alguns invariantes,
 * porém, só existem no banco: cascata de FK, semântica de NULL em índice único,
 * conversão de fuso por tipo de coluna, atomicidade de transação. Testar isso
 * com mock é testar o mock.
 *
 * ## Como rodar
 *
 *     docker compose up -d
 *     TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/corefit_test \
 *       npm test -- integration
 *
 * Sem `TEST_DATABASE_URL` os testes de integração se auto-pulam (`describe.skip`)
 * em vez de falhar: quem não tem Postgres na máquina continua rodando a suíte
 * inteira. Em troca, quem PRECISA da garantia roda o comando acima — e o CI
 * pode passar a variável quando houver serviço de banco.
 *
 * NUNCA aponte para o banco de produção: o setup faz DDL e DELETE.
 */
import { createRequire } from 'module';

import fs from 'fs';
import path from 'path';

import { Client } from 'pg';

/** Migrations são CommonJS; `createRequire` é o padrão já usado nos testes. */
const loadCjs = createRequire(__filename);

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasTestDb = TEST_DATABASE_URL.length > 0;

/** `describe` que se auto-pula quando não há banco configurado. */
export const describeWithDb: jest.Describe = hasTestDb ? describe : describe.skip;

/**
 * Prefixo dos dados criados pelos testes.
 *
 * Cada suíte usa o SEU prefixo. Com um prefixo único compartilhado, o
 * `cleanFixtures` do `beforeAll` de uma suíte apagava as fixtures da outra no
 * meio da execução (o Jest roda arquivos em paralelo) — e as falhas apareciam
 * como "backfill não é idempotente", que é exatamente a conclusão errada.
 */
export type FixtureTag = string;

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  return client;
}

/** Identificador do lock que serializa as suítes de integração. */
const SUITE_LOCK_ID = 903_301;

/**
 * Serializa as suítes de integração que compartilham o MESMO banco.
 *
 * O Jest roda arquivos de teste em paralelo. Como o backfill varre a tabela
 * inteira, uma suíte reexecutando-o enquanto a outra insere sessões faz a
 * contagem de idempotência oscilar — e a falha aparece como "o backfill não é
 * idempotente", que é exatamente a conclusão errada a tirar.
 *
 * Um advisory lock de SESSÃO (não transacional) faz as suítes se enfileirarem
 * sozinhas, sem exigir que ninguém lembre de `--runInBand`. Os testes unitários,
 * que não tocam o banco, seguem paralelos.
 */
export async function acquireSuiteLock(c: Client): Promise<void> {
  await c.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK_ID]);
}

export async function releaseSuiteLock(c: Client): Promise<void> {
  await c.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK_ID]);
}

/**
 * Encerramento de suíte que NUNCA retém o lock.
 *
 * O `afterAll` típico era `limpeza(); releaseSuiteLock(); c.end();` em
 * sequência — e uma limpeza que falhasse abortava antes das duas últimas. O
 * resultado observado: um erro de schema de 2 segundos virou **14 horas** de
 * espera. A suíte falhava, deixava a conexão aberta segurando o advisory lock
 * de sessão, e todas as suítes seguintes bloqueavam em
 * `pg_advisory_lock` até alguém matar o processo à mão.
 *
 * A regra aqui é a mesma de qualquer recurso: liberar no `finally`. Falha de
 * limpeza vira aviso; o lock e a conexão saem de qualquer jeito.
 */
export async function finishSuite(
  c: Client,
  limpeza?: () => Promise<void>,
): Promise<void> {
  try {
    if (limpeza) await limpeza();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[itest] limpeza da suíte falhou — liberando o lock mesmo assim:', err);
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK_ID]).catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** Remove o que ESTA suíte criou. Seguro de rodar antes e depois. */
export async function cleanFixtures(c: Client, tag: FixtureTag): Promise<void> {
  await c.query(`DELETE FROM users WHERE email LIKE $1`, [`${tag}-%@test.local`]);
  await c.query(`DELETE FROM exercises WHERE source = $1`, [tag]);
}

let seq = 0;
/** Usuário de teste com os NOT NULL do schema legado preenchidos. */
export async function createUser(c: Client, tag: FixtureTag, label: string): Promise<number> {
  seq += 1;
  const unique = `${Date.now() % 100000}${seq}`.slice(-9).padStart(9, '0');
  const { rows } = await c.query(
    `INSERT INTO users (email, password, role, name, cpf, phone)
     VALUES ($1, 'x', 'user', $2, $3, $4) RETURNING id`,
    [`${tag}-${label}-${unique}@test.local`, `Fixture ${label}`, unique, `119${unique}`],
  );
  return rows[0].id;
}

export async function createExercise(c: Client, tag: FixtureTag, name: string): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO exercises (source, name, normalized_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [tag, name, name.toLowerCase()],
  );
  return rows[0].id;
}

/** Sessão executada `daysAgo` dias atrás. */
export async function createSessionRow(
  c: Client,
  opts: {
    userId: number;
    daysAgo: number;
    status?: 'completed' | 'partial' | 'abandoned';
    sessionRpe?: number | null;
    atTime?: string;
  },
): Promise<number> {
  const status = opts.status ?? 'completed';
  // `atTime` permite fixar a hora NO FUSO DO ALUNO — necessário para os testes
  // de virada de dia.
  const ts = opts.atTime
    ? `((CURRENT_DATE - ${opts.daysAgo} + TIME '${opts.atTime}') AT TIME ZONE 'America/Sao_Paulo')`
    : `(NOW() - INTERVAL '${opts.daysAgo} days')`;
  const { rows } = await c.query(
    `INSERT INTO workout_sessions
       (user_id, source, status, session_rpe, prescribed_snapshot, started_at, ended_at, performed_at)
     VALUES ($1, 'free', $2, $3, '[]'::jsonb, ${ts}, ${ts}, ${ts})
     RETURNING id`,
    [opts.userId, status, opts.sessionRpe ?? null],
  );
  return rows[0].id;
}

export async function createSetLog(
  c: Client,
  opts: {
    sessionId: number;
    exerciseId: string | null;
    name: string;
    setIndex: number;
    reps: number | null;
    loadKg: number | null;
    status?: 'done' | 'skipped';
  },
): Promise<void> {
  await c.query(
    `INSERT INTO workout_set_logs
       (session_id, exercise_id, exercise_name, order_index, set_index, reps_done, load_done_kg, status)
     VALUES ($1, $2, $3, 0, $4, $5, $6, $7)`,
    [
      opts.sessionId,
      opts.exerciseId,
      opts.name,
      opts.setIndex,
      opts.reps,
      opts.loadKg,
      opts.status ?? 'done',
    ],
  );
}

/**
 * Reconstrói o schema do módulo Performance aplicando TODAS as migrations dele,
 * em ordem.
 *
 * ## O problema que isto resolve
 *
 * A suíte da P1 exercita `down` + `up` da migration 1823 para provar que a
 * reversão é real. Mas a 1823 é a PRIMEIRA de uma série: seu `down` derruba as
 * quatro tabelas e seu `up` as recria no desenho de agosto — sem nada do que as
 * ondas seguintes acrescentaram. A tabela `pgmigrations` continua dizendo que a
 * 1824 e a 1825 foram aplicadas, então nada as reaplica, e o banco fica num
 * estado que não corresponde a nenhuma versão real do produto: schema da P1 com
 * registro de migrations da P4.
 *
 * A primeira correção (Onda P4) foi cada suíte reaplicar manualmente a migration
 * de que precisava. Isso funcionava e envelhecia mal — toda onda futura teria de
 * lembrar de fazer o mesmo, e esquecer só apareceria como falha em outra suíte,
 * longe da causa.
 *
 * ## A regra aqui
 *
 * O helper DESCOBRE as migrations do módulo pelo diretório e aplica em ordem de
 * nome (que é ordem cronológica, por construção do `node-pg-migrate`). Uma
 * migration nova do módulo entra sozinha, sem ninguém editar este arquivo.
 *
 * Só o `up` é chamado, e todas as migrations do módulo são idempotentes
 * (`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` antes de `ADD`), então rodar
 * sobre um banco já correto não faz nada.
 *
 * Nada disto altera comportamento de produção: lá as migrations rodam em ordem,
 * uma vez, e ninguém chama `down` da 1823 no meio.
 */
const PERFORMANCE_MIGRATIONS_DIR = path.join(__dirname, '../../../migrations');
const FIRST_PERFORMANCE_MIGRATION = '1823000000000';

export async function restorePerformanceSchema(c: Client): Promise<void> {
  const pgm = { db: { query: (sql: string, params?: unknown[]) => c.query(sql, params) } };
  const files = fs
    .readdirSync(PERFORMANCE_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js') && f >= FIRST_PERFORMANCE_MIGRATION)
    .sort();

  for (const file of files) {
    const migration = loadCjs(path.join(PERFORMANCE_MIGRATIONS_DIR, file));
    await migration.up(pgm);
  }
}

/** Reexecuta o backfill da migration 1823 sobre o banco de teste. */
export async function runBackfill(c: Client): Promise<void> {
  const migration = loadCjs('../../../migrations/1823000000000_performance-foundation.js');
  await migration.up({ db: { query: (sql: string, params?: unknown[]) => c.query(sql, params) } });
}
