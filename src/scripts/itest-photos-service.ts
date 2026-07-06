/**
 * Teste de service da Frente 1.2 — critérios [2] (validação) e [6] (consent 403).
 * [2] não toca DB; [6] consulta hasActiveConsent (precisa DATABASE_URL/PGSSLMODE).
 */
import 'dotenv/config';
import { createUploadTarget, listPhotosForProfessional } from '../services/progressPhotoService';

const PASS = (m: string) => console.log(`  ✅ ${m}`);
const FAIL = (m: string) => { console.log(`  ❌ ${m}`); process.exitCode = 1; };

async function expectThrow(fn: () => Promise<unknown>, code: string, label: string) {
  try {
    await fn();
    FAIL(`${label}: NÃO lançou (esperava ${code})`);
  } catch (e: any) {
    if (e?.code === code) PASS(`${label}: lançou ${code}`);
    else FAIL(`${label}: lançou ${e?.code || e?.message} (esperava ${code})`);
  }
}

async function main() {
  console.log('\n=== [2] validação de content-type e tamanho ===');
  await expectThrow(() => createUploadTarget(1, 'image/gif', 1000), 'VALIDATION', 'content-type não suportado (gif)');
  await expectThrow(() => createUploadTarget(1, 'application/pdf', 1000), 'VALIDATION', 'content-type não-imagem (pdf)');
  await expectThrow(() => createUploadTarget(1, 'image/png', 11 * 1024 * 1024), 'VALIDATION', 'acima de 10MB');
  try {
    const t = await createUploadTarget(1, 'image/png', 500_000);
    if (t.uploadUrl && t.storageKey.startsWith('progress-photos/1/')) PASS('caso válido: gera uploadUrl + storageKey do próprio user');
    else FAIL('caso válido: retorno inesperado');
  } catch (e: any) { FAIL(`caso válido lançou: ${e.message}`); }

  console.log('\n=== [6] consent body_photos — caminho NEGADO ===');
  // Par sem consent (ids improváveis) → hasActiveConsent=false → CONSENT_REQUIRED (403 na rota).
  await expectThrow(
    () => listPhotosForProfessional(999_999, 999_998, 'personal'),
    'CONSENT_REQUIRED',
    'personal sem grant não lê fotos',
  );
  await expectThrow(
    () => listPhotosForProfessional(999_999, 999_998, 'nutri'),
    'CONSENT_REQUIRED',
    'nutri sem grant não lê fotos',
  );

  console.log('\n=== fim ===\n');
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
