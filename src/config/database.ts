import pkg from 'pg';
import dotenv from 'dotenv';
import logger from '../lib/logger';
import { assertSafeQaDatabase } from '../utils/qaSafety';

dotenv.config();

// Guard opt-in (SPEC 035): scripts de QA/fixture setam QA_SAFE_MODE=1 junto
// com DATABASE_URL explícito. Roda ANTES do Pool ser construído — o único
// choke point que toda query atravessa — porque o Pool baked a connection
// string no momento da construção; reatribuir a env var depois não desfaz.
// Nunca ativo por padrão: um falso positivo aqui não pode travar o boot real.
if (process.env.QA_SAFE_MODE === '1') {
  assertSafeQaDatabase(process.env.DATABASE_URL);
}

const { Pool } = pkg;

/**
 * SSL para `pg` com `DATABASE_URL` em nuvem (Render, RDS, etc.).
 *
 * Muitos provedores usam cadeias que o Node acusa como self-signed (`DEPTH_ZERO_SELF_SIGNED_CERT`).
 * Padrão: TLS com `rejectUnauthorized: false` quando detectamos host gerenciado ou URL exige SSL
 * (criptografia mantida; sem validação do certificado contra CAs do sistema).
 *
 * `POSTGRES_SSL_REJECT_UNAUTHORIZED=true` força validação estrita (ex.: com `NODE_EXTRA_CA_CERTS`).
 * `POSTGRES_SSL_DISABLE=true` força sem SSL (homelab / Postgres sem TLS).
 */
function resolvePgSsl(): false | { rejectUnauthorized: boolean } {
  if (!process.env.DATABASE_URL) return false;

  if (process.env.POSTGRES_SSL_DISABLE === 'true') {
    return false;
  }

  const url = process.env.DATABASE_URL;

  // Compose / dev: Postgres local sem TLS
  if (
    /localhost|127\.0\.0\.1/i.test(url) ||
    /@postgres[/:]/i.test(url) ||
    /@db[/:]/i.test(url)
  ) {
    return false;
  }

  if (/sslmode=disable/i.test(url)) {
    return false;
  }

  const managedHost =
    /\.render\.com\b/i.test(url) ||
    /\.amazonaws\.com\b/i.test(url) ||
    /\.rds\.amazonaws\.com\b/i.test(url) ||
    /\.neon\.tech\b/i.test(url) ||
    /\.supabase\.co\b/i.test(url) ||
    /\.azure\.com\b/i.test(url) ||
    /\.digitalocean\.com\b/i.test(url) ||
    /\.ondigitalocean\.com\b/i.test(url);

  const urlWantsSsl =
    /sslmode=require/i.test(url) ||
    /sslmode=verify-full/i.test(url) ||
    /sslmode=verify-ca/i.test(url) ||
    /sslmode=no-verify/i.test(url);

  const prod = process.env.NODE_ENV === 'production';

  if (!managedHost && !urlWantsSsl && !prod) {
    return false;
  }

  const strict = process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true';
  return { rejectUnauthorized: strict };
}

/**
 * Limites do pool — explícitos, não default.
 *
 * ## Por que isto existe
 *
 * Sem `connectionTimeoutMillis`, o `pg` espera por uma conexão
 * INDEFINIDAMENTE. Saturação deixa de ser um erro (que aparece no log, vira
 * 503 e é investigável) e vira um travamento silencioso: a requisição fica
 * pendurada até o cliente desistir, e nenhuma métrica acusa a causa.
 *
 * ## De onde saem os números
 *
 * O `max` é dimensionado a partir do orçamento do Postgres, não de um chute:
 *
 * - `max_connections` do Postgres gerenciado: **100** (padrão do Render e do
 *   compose local — confirmado em `SHOW max_connections`).
 * - `superuser_reserved_connections`: **3** — indisponíveis para a aplicação.
 * - Sobram ~97 para TODOS os consumidores, que hoje são: a(s) instância(s)
 *   web, os dois cron jobs (`cron:daily` e `cron:six-hourly`, processos
 *   próprios), migrations no boot de cada deploy (que roda em paralelo com a
 *   instância antiga durante o rollover) e o acesso administrativo — psql,
 *   backup, painel do provedor.
 *
 * Com `max = 20`, três instâncias web simultâneas mais um deploy em rollover
 * chegam a ~80, deixando folga real para cron e administração. Subir para 40
 * ou 50 pareceria "mais capacidade" e na prática entregaria o oposto: duas
 * instâncias esgotariam o servidor, e o erro apareceria como `too many
 * connections` — do lado do Postgres, afetando inclusive quem tenta
 * investigar.
 *
 * `PG_POOL_MAX` permite ajustar sem deploy quando a topologia mudar (mais
 * instâncias → menor por instância).
 */
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 20;

/**
 * Tempo máximo esperando por uma conexão livre.
 *
 * 10s é maior que qualquer query saudável deste backend (as mais pesadas são
 * agregações de dashboard, na casa de centenas de ms) e menor que o timeout
 * típico de um cliente HTTP. Quem espera mais que isso não está lento: está
 * numa fila que não vai andar, e falhar rápido devolve a conexão ao próximo em
 * vez de acumular espera.
 */
const POOL_CONNECTION_TIMEOUT_MS = Number(process.env.PG_POOL_CONNECTION_TIMEOUT_MS) || 10_000;

/**
 * Quanto uma conexão ociosa fica aberta.
 *
 * 30s devolve capacidade ao servidor nos vales de tráfego sem causar
 * reconexão constante no uso normal — e o backend dorme de madrugada, então
 * segurar 20 conexões ociosas a noite inteira é desperdício puro.
 */
const POOL_IDLE_TIMEOUT_MS = Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30_000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePgSsl(),
  max: POOL_MAX,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
});

logger.info(
  {
    max: POOL_MAX,
    connectionTimeoutMs: POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
  },
  '[db] pool configurado',
);

/** Números do pool para health check e diagnóstico de saturação. */
export function poolStats() {
  return {
    max: POOL_MAX,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

pool.on('error', (err: any) => {
  logger.error({ err }, 'Unexpected error on idle client');
});

export default pool;
