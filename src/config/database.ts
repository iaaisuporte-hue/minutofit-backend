import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePgSsl(),
});

pool.on('error', (err: any) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;
