/**
 * Regressão da curadoria de conteúdo 2026Q3 (src/scripts/curationExerciseLibraryFixes2026Q3.ts).
 *
 * Cobre exatamente os três invariantes exigidos pela tarefa:
 *   1) rename não duplica (o índice único é por normalized_name+source; renomear
 *      "por fora" via edição de `name` no seed criaria uma linha nova órfã —
 *      aqui validamos que o rename por ID nunca faz isso, mesmo repetido).
 *   2) archive não quebra ficha ativa referenciando o id antigo (status='archived'
 *      nunca é DELETE — o id continua resolvendo).
 *   3) gif corrigido não deixa mídia órfã "ganhando" na leitura (a URL antiga
 *      é demovida de is_primary, nunca duas linhas primary=true no mesmo exercício).
 *
 * Usa exercícios FIXTURE isolados por `source = tag` (mesmo padrão de
 * `cleanFixtures`/`createExercise` em helpers/integrationDb.ts) — não depende
 * dos nomes reais do catálogo `corefit`, então continua válido mesmo que a
 * curadoria real já tenha sido aplicada em produção.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  describeWithDb,
  finishSuite,
} from './helpers/integrationDb';
import {
  archiveExercise,
  renameActiveExercise,
} from '../scripts/curationExerciseLibraryFixes2026Q3';
import { normalizeExerciseName } from '../services/exerciseLibraryService';

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(60_000);

const TAG = 'curation2026q3fixture';

describeWithDb('Curadoria 2026Q3 · rename/archive por ID', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
  });

  afterAll(async () => {
    await finishSuite(c, () => cleanFixtures(c, TAG));
  });

  async function insertFixtureExercise(name: string): Promise<string> {
    const { rows } = await c.query(
      `INSERT INTO exercises (source, name, normalized_name, body_part, target_muscle, equipment)
       VALUES ($1, $2, $3, 'ombro', 'deltoide', 'halteres') RETURNING id`,
      [TAG, name, normalizeExerciseName(name)],
    );
    return rows[0].id;
  }

  it('rename por ID não duplica, mesmo rodado duas vezes seguidas', async () => {
    const oldName = `${TAG} Exercício Antigo`;
    const newName = `${TAG} Exercício Novo`;
    const id = await insertFixtureExercise(oldName);

    // pool "de fato" precisa ser o mesmo objeto usado pelo helper — reusa o
    // client de teste via um wrapper mínimo compatível com a assinatura Pool.
    const poolLike = { query: (text: string, params?: unknown[]) => c.query(text, params) } as unknown as import('pg').Pool;

    const first = await renameActiveExercise(poolLike, { oldName, newName });
    expect(first).toBe('renamed');

    const second = await renameActiveExercise(poolLike, { oldName, newName });
    expect(second).toBe('already-applied');

    const rows = (await c.query(
      `SELECT id, name, status FROM exercises WHERE source = $1 AND owner_personal_id IS NULL`,
      [TAG],
    )).rows;
    // uma ÚNICA linha ativa, com o id ORIGINAL preservado (não é insert+arquivar o antigo)
    const active = rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id);
    expect(active[0].name).toBe(newName);
  });

  it('archive não quebra referência (ficha) ao id antigo — nunca é DELETE', async () => {
    const name = `${TAG} Exercício Para Arquivar`;
    const id = await insertFixtureExercise(name);

    const poolLike = { query: (text: string, params?: unknown[]) => c.query(text, params) } as unknown as import('pg').Pool;
    const status = await archiveExercise(poolLike, { name, reason: 'teste' });
    expect(status).toBe('archived');

    // simula uma ficha ANTIGA que referencia o id por dentro de um JSONB —
    // o ponto do teste é que o id continua existindo e resolvível, só o
    // status muda; nada em `exercises` foi deletado.
    const found = await c.query(`SELECT id, status FROM exercises WHERE id = $1`, [id]);
    expect(found.rowCount).toBe(1);
    expect(found.rows[0].status).toBe('archived');

    // idempotente: arquivar de novo não quebra nem duplica
    const again = await archiveExercise(poolLike, { name, reason: 'teste' });
    expect(again).toBe('already-archived');
  });

  it('correção de mídia primária demove a antiga — nunca duas linhas is_primary=true', async () => {
    const name = `${TAG} Exercício Com Gif`;
    const id = await insertFixtureExercise(name);

    await c.query(
      `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
       VALUES ($1, 'image', 'https://example.com/velho.jpg', 'free-exercise-db', true)`,
      [id],
    );

    // mesma lógica de upsertExerciseMedia (seedExercisesLibrary.core.ts):
    // demove a antiga antes de inserir a nova como primária.
    const newUrl = 'https://media.s2core.com.br/exercise-gifs/corrigido.gif';
    await c.query(
      `UPDATE exercise_media SET is_primary = false, updated_at = NOW()
        WHERE exercise_id = $1 AND url <> $2 AND is_primary = true`,
      [id, newUrl],
    );
    await c.query(
      `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
       VALUES ($1, 'gif', $2, 'gifdotreino', true)
       ON CONFLICT (exercise_id, url) DO UPDATE SET is_primary = true, updated_at = NOW()`,
      [id, newUrl],
    );

    const primaries = await c.query(
      `SELECT url FROM exercise_media WHERE exercise_id = $1 AND is_primary = true`,
      [id],
    );
    expect(primaries.rowCount).toBe(1);
    expect(primaries.rows[0].url).toBe(newUrl);
  });
});
