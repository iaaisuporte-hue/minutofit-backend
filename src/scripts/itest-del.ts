import 'dotenv/config';
import { getStorage } from '../lib/storage';
(async () => {
  const s = getStorage();
  const key = `progress-photos/__deltest__/${Date.now()}.png`;
  const { uploadUrl } = await s.createUploadUrl(key, 'image/png', 300);
  await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('89504e470d0a1a0a','hex') });
  const before = await s.headObject(key);
  await s.deleteObject(key);                 // exatamente o que o admin faz pós-COMMIT
  const after = await s.headObject(key);
  console.log('  antes do delete: ', before ? 'EXISTE' : 'ausente');
  console.log('  depois do delete:', after ? '❌ AINDA EXISTE' : '✅ removido do R2');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
