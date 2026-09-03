/**
 * Curadoria de conteúdo da biblioteca de exercícios — 2026Q3.
 * Relatório completo (item a item, DONE/BLOCKED) em
 * docs/content/exercise_library_curation_2026Q3.md.
 *
 * O QUE ESTE SCRIPT FAZ (e por quê não dá pra fazer só editando o seed):
 *
 * 1) RENOMEIA exercícios já existentes por ID (UPDATE direto, nunca editando
 *    só `name` no seed) — o índice único é (normalized_name, source) e o
 *    ON CONFLICT do seed só re-liga numa linha existente se o normalized_name
 *    já bater; editar `name` no seed sem isso faria o próximo reseed inserir
 *    uma linha NOVA com o nome novo, deixando a antiga órfã (duplicata
 *    fantasma). O rename aqui casa por QUALQUER `source` com o mesmo
 *    normalized_name antigo (corefit e também 'metacore', se existir uma
 *    cópia com o mesmo nome em produção) — sempre `owner_personal_id IS NULL`
 *    (nunca renomeia exercício de personal) e `status = 'active'`.
 * 2) ARQUIVA (status='archived') os IDs escolhidos como duplicata/remoção —
 *    NUNCA DELETE físico. As entradas correspondentes já foram removidas dos
 *    arquivos de seed (comentário no lugar), então um reseed não recria a
 *    linha.
 * 3) Roda `runExercisesSeed` (mesma função do boot/CLI padrão) para: gravar
 *    os exercícios NOVOS adicionados ao seed, reafirmar campos alterados sem
 *    rename (body_part, equipment, tags — casam pelo normalized_name que não
 *    mudou) e resolver a mídia via `gifDoTreino.map.ts` já editado (o próprio
 *    `upsertExerciseMedia` demove a URL antiga de `is_primary` — não deixa
 *    mídia velha "ganhando" na leitura).
 *
 * Idempotente: rodar de novo é seguro — os renames só agem se ainda
 * encontrarem o nome ANTIGO ativo (already-applied vira no-op logado); os
 * archives fazem UPDATE incondicional (arquivar já-arquivado não quebra
 * nada); o reseed já é idempotente por natureza.
 *
 * Uso (LOCAL — nunca sem DATABASE_URL explícito, o .env aponta pra produção):
 *   DATABASE_URL=postgresql://corefit:corefit@localhost:5433/corefitdb_test \
 *     npx tsx src/scripts/curationExerciseLibraryFixes2026Q3.ts
 *
 * Em produção, depois do deploy que leva os arquivos de seed atualizados:
 *   DATABASE_URL=<produção> npx tsx src/scripts/curationExerciseLibraryFixes2026Q3.ts
 *   DATABASE_URL=<produção> npx tsx src/scripts/propagateGifMedia.ts
 * (o segundo comando propaga os GIFs corrigidos/novos para eventuais cópias
 * 'metacore' de mesmo nome — mesmo script já usado sempre que se corrige gif).
 */

import { Pool } from 'pg';
import { runExercisesSeed } from '../db/seedExercisesLibrary.core';
import { normalizeExerciseName } from '../services/exerciseLibraryService';
import logger from '../lib/logger';

/** Rename por ID — nunca editando só `name` no seed (ver cabeçalho). */
export interface RenameOp {
  oldName: string;
  newName: string;
}

/** Arquivamento por ID (status='archived') — nunca DELETE físico. */
export interface ArchiveOp {
  name: string;
  reason: string;
}

const RENAMES: RenameOp[] = [
  { oldName: 'Band Pull-Apart', newName: 'Elevação Lateral com Elástico' },
  { oldName: 'Crucifixo Inverso (Elevação Posterior)', newName: 'Crucifixo Inverso' },
  { oldName: 'Rosca Scott (Preacher Curl)', newName: 'Rosca Scott com Barra' },
  { oldName: 'Fundinho (Bench Dip)', newName: 'Dip no Banco' },
  { oldName: 'Mergulho (Tríceps Dip)', newName: 'Tríceps na Barra Paralela Livre' },
  { oldName: 'Puxada na Polia Alta (Close Grip)', newName: 'Puxada Supinada Fechada' },
  { oldName: 'Remada T-Bar', newName: 'Remada Cavalinho' },
  { oldName: 'Afundo (Lunge)', newName: 'Afundo com Halter' },
  { oldName: 'Nordic Curl (Curl Nórdico)', newName: 'Flexão Nórdica' },
  { oldName: 'Glúteo 4 Apoios (Donkey Kick)', newName: 'Glúteo 4 Apoios' },
  { oldName: 'Extensão de Tríceps com Haltere Unilateral', newName: 'Francês Unilateral com Halter' },
  { oldName: 'Extensão de Tríceps Acima da Cabeça na Polia', newName: 'Tríceps Francês na Polia' },
  { oldName: 'Mergulho na Máquina', newName: 'Paralela na Máquina' },
  { oldName: 'Tríceps Francês com Barra W em Pé', newName: 'Tríceps Francês com Barra em Pé' },
  { oldName: 'Tríceps Inverso na Polia', newName: 'Tríceps Pegada Inversa na Polia' },
  { oldName: 'Remada Invertida', newName: 'Remada Livre' },
  { oldName: 'Passada Caminhando', newName: 'Passada com Barra' },
];

const ARCHIVES: ArchiveOp[] = [
  { name: 'Tríceps Testa (Skull Crusher)', reason: 'Remoção pedida pelo usuário (curadoria 2026Q3, item TRÍCEPS).' },
  { name: 'Extensão de Perna na Máquina', reason: 'Remoção pedida pelo usuário (curadoria 2026Q3, item PERNAS).' },
  { name: 'Panturrilha em Pé (Calf Raise)', reason: 'Remoção pedida pelo usuário (curadoria 2026Q3, item PERNAS).' },
  { name: 'Frog Pump', reason: 'Remoção pedida pelo usuário (curadoria 2026Q3, item PERNAS).' },
  { name: 'Glute Kickback de Joelhos', reason: "Remoção pedida pelo usuário — coberto por 'Glúteo 4 Apoios' (curadoria 2026Q3, item PERNAS)." },
  { name: 'Encolhimento com Barra', reason: "Duplicata de 'Encolhimento de Ombros com Barra' (mesmo freeDbId/gif) — curadoria 2026Q3, item OMBROS." },
  { name: 'Abdução na Máquina', reason: "Duplicata de 'Abdução de Quadril na Máquina' (mesmo freeDbId/gif) — curadoria 2026Q3, item PERNAS." },
];

export async function renameActiveExercise(pool: Pool, op: RenameOp): Promise<'renamed' | 'already-applied' | 'not-found'> {
  const oldNormalized = normalizeExerciseName(op.oldName);
  const newNormalized = normalizeExerciseName(op.newName);

  const found = await pool.query(
    `SELECT id, source FROM exercises
      WHERE normalized_name = $1 AND owner_personal_id IS NULL AND status = 'active'`,
    [oldNormalized],
  );

  if (!found.rowCount) {
    // Já rodou antes (nome já é o novo) ou nunca existiu — checa qual dos dois.
    const already = await pool.query(
      `SELECT 1 FROM exercises
        WHERE normalized_name = $1 AND owner_personal_id IS NULL AND status = 'active' LIMIT 1`,
      [newNormalized],
    );
    if (already.rowCount) return 'already-applied';
    return 'not-found';
  }

  for (const row of found.rows) {
    await pool.query(
      `UPDATE exercises SET name = $1, normalized_name = $2, updated_at = NOW() WHERE id = $3`,
      [op.newName, newNormalized, row.id],
    );
  }
  return 'renamed';
}

export async function archiveExercise(pool: Pool, op: ArchiveOp): Promise<'archived' | 'already-archived' | 'not-found'> {
  const normalized = normalizeExerciseName(op.name);
  const result = await pool.query(
    `UPDATE exercises SET status = 'archived', updated_at = NOW()
      WHERE normalized_name = $1 AND owner_personal_id IS NULL AND status = 'active'
      RETURNING id`,
    [normalized],
  );
  if (result.rowCount) return 'archived';

  const exists = await pool.query(
    `SELECT 1 FROM exercises WHERE normalized_name = $1 AND owner_personal_id IS NULL LIMIT 1`,
    [normalized],
  );
  return exists.rowCount ? 'already-archived' : 'not-found';
}

export interface CurationResult {
  renames: Record<string, string>;
  archives: Record<string, string>;
  seed: Awaited<ReturnType<typeof runExercisesSeed>>;
}

export async function runCuration2026Q3(pool: Pool): Promise<CurationResult> {
  const renames: Record<string, string> = {};
  for (const op of RENAMES) {
    const status = await renameActiveExercise(pool, op);
    renames[`${op.oldName} → ${op.newName}`] = status;
    logger.info({ ...op, status }, '[curation-2026q3] rename');
  }

  const archives: Record<string, string> = {};
  for (const op of ARCHIVES) {
    const status = await archiveExercise(pool, op);
    archives[op.name] = status;
    logger.info({ name: op.name, status }, '[curation-2026q3] archive');
  }

  const seed = await runExercisesSeed(pool);
  logger.info(seed, '[curation-2026q3] seed rerun (novos itens + mídia)');

  return { renames, archives, seed };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('[curation-2026q3] DATABASE_URL ausente — recusando rodar sem alvo explícito.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const result = await runCuration2026Q3(pool);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error({ err }, '[curation-2026q3] falha fatal');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}
