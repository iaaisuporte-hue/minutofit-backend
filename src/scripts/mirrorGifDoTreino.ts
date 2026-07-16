/**
 * Espelha os GIFs de exercícios do gifdotreino.com para o NOSSO bucket público (R2/S3).
 *
 * Por que espelhar (e não hotlink): o gifdotreino.com é site de terceiro — hotlink é
 * frágil (pode renomear/remover/bloquear) e consome banda do servidor dele. Baixamos
 * uma vez e servimos do nosso storage, com CORS/cache/disponibilidade sob controle.
 *
 * Bucket SEPARADO do de fotos: fotos de usuário são privadas (URL assinada); GIFs de
 * exercício são conteúdo público, imutável e cacheável → bucket público + URL estável.
 *
 * Config (env):
 *   EXERCISE_MEDIA_S3_BUCKET   bucket PÚBLICO de mídia (ex.: corefit-media-public)
 *   EXERCISE_MEDIA_BASE_URL    base pública p/ montar a URL final (ex.: https://media.s2core.com.br)
 *   AWS_S3_ENDPOINT            endpoint R2/S3-compatível (reusa o de fotos)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
 *
 * Uso:
 *   npx tsx src/scripts/mirrorGifDoTreino.ts            # baixa+sobe o que falta
 *   npx tsx src/scripts/mirrorGifDoTreino.ts --force    # re-sobe tudo
 *   npx tsx src/scripts/mirrorGifDoTreino.ts --dry-run  # só lista, não sobe
 *
 * Idempotente: pula objetos que já existem (HeadObject) salvo --force.
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { GIF_DO_TREINO_SOURCE, gifDoTreinoKey } from '../seeds/gifDoTreino.map';

const SOURCE_ORIGIN = 'https://www.gifdotreino.com';
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[mirror] Falta env ${name}.`);
    process.exit(1);
  }
  return v;
}

function buildClient(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.AWS_S3_ENDPOINT),
    credentials: {
      accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    },
  });
}

/** URL de origem no gifdotreino (path relativo → URL absoluta encodada). */
function sourceUrl(relPath: string): string {
  // encode cada segmento preservando as barras
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${SOURCE_ORIGIN}/${encoded}`;
}

async function fetchGif(url: string): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (CoreFit media mirror)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('gif') && !ct.includes('octet-stream')) {
        throw new Error(`content-type inesperado: ${ct}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

interface Task {
  name: string;
  relPath: string;
  key: string;
}

async function processTask(client: S3Client, bucket: string, t: Task): Promise<'uploaded' | 'skipped' | 'error'> {
  try {
    if (!force && (await objectExists(client, bucket, t.key))) return 'skipped';
    if (dryRun) {
      console.log(`[dry] ${t.name} ← ${sourceUrl(t.relPath)} → ${t.key}`);
      return 'uploaded';
    }
    const body = await fetchGif(sourceUrl(t.relPath));
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: t.key,
        Body: body,
        ContentType: 'image/gif',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    console.log(`[ok]  ${t.name} (${(body.length / 1024).toFixed(0)} KB) → ${t.key}`);
    return 'uploaded';
  } catch (err) {
    console.error(`[err] ${t.name}: ${err instanceof Error ? err.message : err}`);
    return 'error';
  }
}

async function main(): Promise<void> {
  const bucket = requireEnv('EXERCISE_MEDIA_S3_BUCKET');
  const base = process.env.EXERCISE_MEDIA_BASE_URL || '(EXERCISE_MEDIA_BASE_URL não setada)';
  const client = buildClient();

  const tasks: Task[] = Object.entries(GIF_DO_TREINO_SOURCE).map(([name, relPath]) => ({
    name,
    relPath,
    key: gifDoTreinoKey(name),
  }));
  // dedupe por key (nomes com/sem acento podem compartilhar o mesmo GIF/key)
  const seen = new Set<string>();
  const unique = tasks.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));

  console.log(
    `[mirror] ${unique.length} GIFs → bucket "${bucket}" | base pública: ${base} | ` +
      `${force ? 'FORCE ' : ''}${dryRun ? 'DRY-RUN' : ''}`,
  );

  const stats = { uploaded: 0, skipped: 0, error: 0 };
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const t = unique[cursor++];
      const r = await processTask(client, bucket, t);
      stats[r]++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`[mirror] concluído: ${stats.uploaded} enviados, ${stats.skipped} já existiam, ${stats.error} erros`);
  if (stats.error > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[mirror] falha fatal:', err);
  process.exit(1);
});
