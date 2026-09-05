/**
 * Guard defensivo contra escrita acidental em produção a partir de scripts de
 * QA/fixture (SPEC 035 — nasceu de um incidente real: um script de auditoria
 * setou `process.env.DATABASE_URL` dentro do próprio `.ts`, mas o hoisting de
 * `import` fez `config/database.ts` — e o `dotenv.config()` que lê o `.env` de
 * produção — rodar ANTES dessa atribuição. O `Pool` já nasceu apontando para
 * produção; reatribuir a env var depois não desfaz isso).
 *
 * A defesa não pode viver só no script: um script pode reordenar imports por
 * engano de novo. Por isso o ponto de verificação fica em `config/database.ts`,
 * no exato lugar onde o `Pool` é construído — o único choke point que toda
 * query atravessa — e roda quando a env var `QA_SAFE_MODE=1` está presente.
 *
 * Uso: scripts de QA/fixture devem invocar com
 *   QA_SAFE_MODE=1 DATABASE_URL=postgresql://.../corefit_algo_qa npx tsx script.ts
 * Nunca dependa do `.env` do repo para esses scripts — ele aponta para produção
 * (ver memória `backend-env-aponta-producao`).
 */

const SAFE_NAME_PATTERN = /(test|ci|local|verify|qa)/i;
const KNOWN_PRODUCTION_DB_NAMES = new Set(['minutofit_db']);
const PRODUCTION_HOST_MARKERS = /\.render\.com$|\.rds\.amazonaws\.com$/i;

export class UnsafeQaDatabaseError extends Error {}

/**
 * Falha fechado: lança (derruba o processo) se a `DATABASE_URL` efetiva não
 * parecer um banco de QA/teste. Chamada apenas quando `QA_SAFE_MODE=1` — nunca
 * no boot normal do servidor, para não travar produção com um falso positivo.
 */
export function assertSafeQaDatabase(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new UnsafeQaDatabaseError(
      '[qa-safety] DATABASE_URL ausente. Scripts com QA_SAFE_MODE=1 exigem a variável explícita na linha de comando — nunca o .env do projeto.',
    );
  }

  let host = '';
  let dbName = '';
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname;
    dbName = parsed.pathname.replace(/^\//, '');
  } catch {
    throw new UnsafeQaDatabaseError('[qa-safety] DATABASE_URL malformada.');
  }

  const looksSafeByName = SAFE_NAME_PATTERN.test(dbName) && !KNOWN_PRODUCTION_DB_NAMES.has(dbName);
  const looksLikeProdHost = PRODUCTION_HOST_MARKERS.test(host);

  if (!looksSafeByName || looksLikeProdHost) {
    throw new UnsafeQaDatabaseError(
      `[qa-safety] RECUSADO: host="${host}" database="${dbName}" não parece ambiente de QA/teste. ` +
        'O nome do banco precisa conter test, ci, local, verify ou qa (e não pode ser "minutofit_db"), ' +
        'e o host não pode ser um Postgres gerenciado de produção. Passe DATABASE_URL explícito de um banco descartável.',
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new UnsafeQaDatabaseError('[qa-safety] RECUSADO: NODE_ENV=production com QA_SAFE_MODE=1.');
  }
}
