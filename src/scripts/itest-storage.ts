/**
 * Teste de integração da Frente 1.2 (storage R2 + consent) — roda via tsx.
 * Carrega .env, exercita a lib real (não mock) e os critérios de aceite
 * verificáveis headless. CORS de browser e 403 HTTP completo são marcados
 * como "precisa browser/servidor".
 */
import 'dotenv/config';
import { getStorage, isStorageConfigured } from '../lib/storage';

const PASS = (m: string) => console.log(`  ✅ ${m}`);
const FAIL = (m: string) => { console.log(`  ❌ ${m}`); process.exitCode = 1; };
const INFO = (m: string) => console.log(`  ℹ️  ${m}`);

// 1x1 PNG (válido) — ~70 bytes
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  console.log('\n=== Frente 1.2 — teste de integração de storage ===\n');

  // (5) /health: storage configurado?
  console.log('[5] isStorageConfigured (espelha /health):');
  if (!isStorageConfigured()) {
    FAIL("storage NÃO configurado — defina AWS_S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_S3_ENDPOINT (R2) no .env");
    console.log('\n(abortando — sem credenciais não há como testar o round-trip)\n');
    return;
  }
  PASS(`configurado (provider=${getStorage().name})`);

  const storage = getStorage();
  const key = `progress-photos/__itest__/${Date.now()}-${Math.round(Math.random() * 1e6)}.png`;

  // (1) presigned PUT → upload chega no bucket
  console.log('\n[1] presigned PUT + upload real:');
  try {
    const { uploadUrl } = await storage.createUploadUrl(key, 'image/png', 300);
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_1x1 });
    if (put.ok) PASS(`PUT presigned ok (HTTP ${put.status})`);
    else FAIL(`PUT falhou (HTTP ${put.status}) — ${await put.text().catch(() => '')}`);
  } catch (e: any) { FAIL(`PUT erro: ${e.message}`); }

  // confirma objeto no bucket via HEAD
  console.log('\n[1b] HEAD confirma objeto + tamanho/content-type:');
  try {
    const head = await storage.headObject(key);
    if (head && head.byteSize === PNG_1x1.length) PASS(`HEAD ok (byteSize=${head.byteSize}, type=${head.contentType})`);
    else FAIL(`HEAD inesperado: ${JSON.stringify(head)}`);
  } catch (e: any) { FAIL(`HEAD erro: ${e.message}`); }

  // (4) leitura via URL assinada GET + expiração
  console.log('\n[4] download via URL assinada + expiração:');
  try {
    const url = await storage.createDownloadUrl(key, 300);
    const get = await fetch(url);
    const buf = Buffer.from(await get.arrayBuffer());
    if (get.ok && buf.length === PNG_1x1.length) PASS(`GET assinado ok (${buf.length} bytes batem)`);
    else FAIL(`GET inesperado (HTTP ${get.status}, ${buf.length} bytes)`);

    // expiração: URL de 1s deve falhar após ~2s
    const shortUrl = await storage.createDownloadUrl(key, 1);
    await new Promise((r) => setTimeout(r, 2500));
    const expired = await fetch(shortUrl);
    if (!expired.ok) PASS(`URL expirada rejeitada (HTTP ${expired.status})`);
    else FAIL('URL expirada AINDA funcionou — expiração não está valendo');
  } catch (e: any) { FAIL(`download erro: ${e.message}`); }

  // limpeza
  try { await storage.deleteObject(key); PASS('cleanup: objeto de teste removido'); }
  catch (e: any) { INFO(`cleanup falhou (não-crítico): ${e.message}`); }

  // (3) CORS — não testável headless
  console.log('\n[3] CORS do bucket p/ PUT direto do client:');
  INFO('NÃO testável via node (CORS é regra de browser). Validar no app real + confirmar a CORS policy no painel R2.');

  console.log('\n=== fim (critérios 2, 6 e consent rodam no teste de service à parte) ===\n');
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
