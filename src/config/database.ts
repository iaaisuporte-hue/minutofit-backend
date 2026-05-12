import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

// In production: require valid SSL cert by default.
// Set POSTGRES_SSL_REJECT_UNAUTHORIZED=false as escape hatch if the hosting
// provider uses a self-signed cert (document the exception in PROGRESSO.md if used).
const sslConfig =
  process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

pool.on('error', (err: any) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;
