/**
 * mapFreeDbIds.ts
 *
 * Script de mapeamento automático PT→EN para exercícios sem freeDbId.
 * Usa dicionário de termos fitness + similaridade de tokens para sugerir
 * correspondências no free-exercise-db snapshot.
 *
 * Uso:
 *   npx tsx src/scripts/mapFreeDbIds.ts [--apply]
 *
 * Sem --apply: imprime sugestões em console + gera reports/freeDbId_suggestions.json
 * Com --apply: aplica mapeamentos com score >= 0.55 diretamente no seed
 */

import * as fs from 'fs';
import * as path from 'path';

const SNAPSHOT_PATH = path.join(__dirname, '../seeds/freeExerciseDb.snapshot.json');
const SEED_PATH = path.join(__dirname, '../seeds/exercisesLibrary.seed.ts');
const OUTPUT_PATH = path.join(__dirname, '../../reports/freeDbId_suggestions.json');

// ─── Dicionário PT→EN de termos fitness ─────────────────────────────────────
const PT_EN: Record<string, string[]> = {
  // Movimentos compostos
  agachamento: ['squat'],
  supino: ['bench press', 'bench'],
  remada: ['row', 'rowing'],
  puxada: ['pulldown', 'lat pulldown', 'pull'],
  levantamento: ['deadlift', 'lift'],
  afundo: ['lunge'],
  desenvolvimento: ['press', 'overhead press', 'shoulder press'],
  mergulho: ['dip', 'tricep dip'],
  flexão: ['push up', 'pushup'],
  hiperextensão: ['hyperextension', 'back extension'],
  passada: ['lunge', 'walking lunge'],
  step: ['step up', 'step'],

  // Isolados / nomes de exercícios
  rosca: ['curl'],
  tríceps: ['tricep', 'triceps'],
  bíceps: ['bicep', 'biceps'],
  crucifixo: ['fly', 'flyes', 'flies'],
  elevação: ['raise', 'lateral raise', 'front raise'],
  extensão: ['extension'],
  abdução: ['abduction'],
  adução: ['adduction'],
  prancha: ['plank'],
  crunch: ['crunch'],
  abdominal: ['crunch', 'ab', 'sit up'],
  abdo: ['crunch'],
  glúteo: ['glute', 'glutes'],
  panturrilha: ['calf', 'calf raise'],
  cadeira: ['machine', 'seated'],
  mesa: ['lying', 'prone'],
  burpee: ['burpee'],
  polichinelo: ['jumping jacks'],
  jumping: ['jumping'],

  // Equipamentos
  haltere: ['dumbbell'],
  barra: ['barbell'],
  cabo: ['cable'],
  corda: ['rope'],
  máquina: ['machine'],
  elástico: ['band', 'resistance band'],
  kettlebell: ['kettlebell'],
  smith: ['smith machine'],
  polia: ['cable', 'pulley'],
  pulley: ['cable'],

  // Variações / adjetivos
  inclinado: ['incline'],
  declinado: ['decline'],
  inverso: ['reverse'],
  posterior: ['rear', 'reverse', 'posterior'],
  unilateral: ['one arm', 'single arm', 'unilateral'],
  alternado: ['alternate', 'alternating'],
  sumô: ['sumo'],
  búlgaro: ['bulgarian'],
  livre: ['bodyweight', 'free weight'],
  baixa: ['low', 'low cable'],
  alta: ['high', 'high cable'],
  frontal: ['front'],
  lateral: ['lateral', 'side'],
  diamante: ['diamond'],

  // Músculos / regiões
  peitoral: ['chest', 'pectoral'],
  costas: ['back'],
  ombro: ['shoulder', 'delt'],
  perna: ['leg'],
  quadríceps: ['quadriceps', 'quads'],
  femoral: ['hamstring'],
  isquiotibial: ['hamstring'],
  lombar: ['lower back', 'lumbar'],
  core: ['core', 'ab'],
  oblíquo: ['oblique'],
  trapézio: ['trapezius', 'trap'],
  deltóide: ['delt', 'deltoid'],

  // Termos específicos
  scott: ['preacher', 'scott'],
  martelo: ['hammer'],
  arnold: ['arnold'],
  stiff: ['romanian deadlift', 'stiff leg'],
  'hip thrust': ['hip thrust'],
  donkey: ['donkey kick'],
  mountain: ['mountain climber'],
  plank: ['plank'],
  'jumping jacks': ['jumping jacks'],
  hiit: ['hiit', 'cardio'],
  esteira: ['treadmill', 'run'],
  'peck deck': ['pec deck', 'pec fly machine'],

  // Conectivos / preposições (irrelevantes para matching)
  com: [],
  de: [],
  no: [],
  na: [],
  em: [],
  ao: [],
  às: [],
  para: [],
  por: [],
  sobre: [],
  pé: ['standing'],
  apoios: [],
  infra: ['lower', 'reverse'],
  'leg press': ['leg press'],
  'leg curl': ['leg curl'],
  'leg extension': ['leg extension'],
};

interface SnapExercise {
  id: string;
  name: string;
}

interface Suggestion {
  ptName: string;
  freeDbId: string;
  enName: string;
  score: number;
  tokens_matched: string[];
}

// ─── Tokenise name ───────────────────────────────────────────────────────────
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[()°/\-–]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// ─── Translate PT tokens to EN ───────────────────────────────────────────────
function translateTokens(tokens: string[]): string[] {
  const result: string[] = [];
  // also try bigrams
  for (let i = 0; i < tokens.length; i++) {
    const bigram = tokens[i] + ' ' + (tokens[i + 1] || '');
    if (PT_EN[bigram]) {
      result.push(...PT_EN[bigram]);
      i++; // skip next token
      continue;
    }
    const en = PT_EN[tokens[i]];
    if (en && en.length > 0) {
      result.push(...en);
    } else {
      // passthrough (English term already, or unknown)
      result.push(tokens[i]);
    }
  }
  return [...new Set(result)];
}

// ─── Score similarity between translated tokens and snapshot name tokens ─────
function score(translated: string[], snapName: string): { score: number; matched: string[] } {
  const snapTokens = tokenize(snapName);
  const matched: string[] = [];

  for (const t of translated) {
    // Check if any snap token contains or equals the translated token
    for (const st of snapTokens) {
      if (st === t || st.includes(t) || t.includes(st)) {
        if (!matched.includes(t)) matched.push(t);
      }
    }
  }

  const s = matched.length / Math.max(translated.length, snapTokens.length, 1);
  return { score: s, matched };
}

// ─── Find best match in snapshot ─────────────────────────────────────────────
function findBestMatch(ptName: string, snapshot: SnapExercise[]): Suggestion | null {
  const tokens = tokenize(ptName);
  const translated = translateTokens(tokens);

  if (translated.length === 0) return null;

  let best: Suggestion | null = null;

  for (const ex of snapshot) {
    const { score: s, matched } = score(translated, ex.name);
    if (s > 0 && (!best || s > best.score)) {
      best = {
        ptName,
        freeDbId: ex.id,
        enName: ex.name,
        score: s,
        tokens_matched: matched,
      };
    }
  }

  return best;
}

// ─── Extract unmapped exercises from seed ────────────────────────────────────
function extractUnmapped(): string[] {
  const content = fs.readFileSync(SEED_PATH, 'utf8');
  const lines = content.split('\n');
  const unmapped: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^\s+name:\s+'([^']+)'/);
    if (!nameMatch) continue;

    // Look forward up to 10 lines for freeDbId
    let hasFreeDb = false;
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      if (lines[j].match(/freeDbId:\s*(?:'[^']*'|null)/)) {
        hasFreeDb = true;
        break;
      }
      // Stop at next exercise boundary
      if (j > i && lines[j].match(/^\s+\{/) ) break;
    }

    if (!hasFreeDb) unmapped.push(nameMatch[1]);
  }

  return unmapped;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const applyMode = process.argv.includes('--apply');
  const snapshot: SnapExercise[] = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const unmapped = extractUnmapped();

  console.log(`\n📋 Exercícios sem freeDbId: ${unmapped.length}`);
  console.log(`📦 Snapshot disponível: ${snapshot.length} exercícios`);
  console.log(`\n🔍 Buscando correspondências...\n`);

  const suggestions: Suggestion[] = [];
  const noMatch: string[] = [];

  for (const name of unmapped) {
    const match = findBestMatch(name, snapshot);
    if (match && match.score >= 0.25) {
      suggestions.push(match);
    } else {
      noMatch.push(name);
    }
  }

  // Sort by score desc
  suggestions.sort((a, b) => b.score - a.score);

  const high = suggestions.filter(s => s.score >= 0.55);
  const mid = suggestions.filter(s => s.score >= 0.35 && s.score < 0.55);
  const low = suggestions.filter(s => s.score < 0.35);

  console.log(`✅ Alta confiança (≥0.55): ${high.length}`);
  console.log(`⚠️  Média confiança (0.35-0.54): ${mid.length}`);
  console.log(`❓ Baixa confiança (<0.35): ${low.length}`);
  console.log(`❌ Sem match: ${noMatch.length}`);

  console.log('\n── ALTA CONFIANÇA ──────────────────────────────────────');
  for (const s of high) {
    const flag = applyMode ? '✅ APLICANDO' : '→';
    console.log(`  ${flag} "${s.ptName}"\n     ${s.freeDbId}  [${s.enName}]  score=${s.score.toFixed(2)}  tokens=[${s.tokens_matched.join(', ')}]`);
  }

  console.log('\n── MÉDIA CONFIANÇA (revisar) ────────────────────────────');
  for (const s of mid) {
    console.log(`  ? "${s.ptName}"\n     ${s.freeDbId}  [${s.enName}]  score=${s.score.toFixed(2)}`);
  }

  console.log('\n── SEM MATCH ────────────────────────────────────────────');
  for (const n of noMatch) {
    console.log(`  ✗ "${n}"`);
  }

  // Save report
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ high, mid, low, noMatch }, null, 2));
  console.log(`\n📄 Relatório salvo em: ${OUTPUT_PATH}`);

  if (applyMode) {
    applyMappings(high);
  } else {
    console.log('\n💡 Execute com --apply para aplicar os mapeamentos de alta confiança.');
  }
}

// ─── Apply mappings to seed file ─────────────────────────────────────────────
function applyMappings(suggestions: Suggestion[]): void {
  let content = fs.readFileSync(SEED_PATH, 'utf8');
  let applied = 0;

  for (const s of suggestions) {
    // Find the exercise block by name and inject freeDbId after name line
    // Strategy: find `  name: 'ExactName',` and inject `  freeDbId: 'ID',` after it
    // but only if there's no freeDbId in the next ~5 lines

    const escapedName = s.ptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`(\\s+name:\\s+'${escapedName}',)`, 'g');

    let match;
    let newContent = content;

    while ((match = nameRegex.exec(content)) !== null) {
      const nameIdx = match.index;
      // Check the next 300 chars for freeDbId
      const ahead = content.slice(nameIdx, nameIdx + 300);
      if (ahead.includes('freeDbId:')) continue; // already has one

      // Inject freeDbId after this name line
      const nameLine = match[0];
      const indent = nameLine.match(/^(\s+)/)?.[1] || '    ';
      const insertion = `\n${indent}freeDbId: '${s.freeDbId}',`;

      // Replace only first occurrence
      newContent = content.slice(0, nameIdx + nameLine.length) + insertion + content.slice(nameIdx + nameLine.length);
      applied++;
      break;
    }

    content = newContent;
  }

  fs.writeFileSync(SEED_PATH, content);
  console.log(`\n✅ Aplicados ${applied} mapeamentos no seed.`);
}

main().catch(console.error);
