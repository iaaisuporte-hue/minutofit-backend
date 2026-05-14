/**
 * Script manual (NÃO roda no boot) para atualizar o snapshot do free-exercise-db.
 * Repositório: https://github.com/yuhonas/free-exercise-db
 *
 * Uso: npx tsx src/scripts/refreshFreeExerciseDb.ts
 *
 * O snapshot resultante é commitado em src/seeds/freeExerciseDb.snapshot.json
 * para garantir zero dependência de rede em runtime e em CI.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

const URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const OUTPUT = path.resolve(__dirname, '../seeds/freeExerciseDb.snapshot.json');

function download(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Downloading free-exercise-db from ${URL}...`);
  const raw = await download(URL);
  const parsed = JSON.parse(raw) as unknown[];
  console.log(`Downloaded ${parsed.length} exercises (${(raw.length / 1024).toFixed(0)} KB)`);

  fs.writeFileSync(OUTPUT, JSON.stringify(parsed, null, 2), 'utf8');
  console.log(`Snapshot saved to ${OUTPUT}`);
  console.log('Commit the updated snapshot file to the repository.');
}

main().catch((err) => {
  console.error('Failed to refresh snapshot:', err);
  process.exit(1);
});
