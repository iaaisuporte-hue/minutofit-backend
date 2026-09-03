/**
 * Biblioteca de Exercícios Personalizados do Personal (Sprint P1) com banco real.
 *
 * O que só o Postgres prova aqui: as duas UNIQUE parciais (`exercises_name_
 * source_uq` escopada a `owner_personal_id IS NULL`, `exercises_personal_
 * owner_name_uq` escopada a dono+`status='active'`) sustentam dedup entre
 * corefit/metacore SEM colapsar exercício de personal, dois personais podem
 * ter exercício de mesmo nome, o MESMO personal não pode duplicar nome
 * ativo, arquivar libera o nome e restaurar pode colidir de propósito — e
 * que a biblioteca de personal se integra à execução real (PR/histórico)
 * sem nenhum código novo nesse ponto (D1).
 *
 * Storage (upload de mídia) é mockado — este é um teste de integração de
 * BANCO, e `AWS_S3_BUCKET` não está configurado no processo de teste. O
 * mock fica no limite exato do serviço externo (`../lib/storage`); tudo o
 * que toca Postgres (posse, chave prefixada, troca de `is_primary`) continua
 * batendo no banco real.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-p1-exercises';

// Fake de storage — só a superfície usada por `personalExerciseService.ts`.
// `createUploadUrl` "registra" a chave para que o `headObject` subsequente a
// encontre, simulando o PUT que na vida real o browser faz entre os dois
// passos.
const fakeObjects = new Map<string, { contentType: string; byteSize: number }>();
jest.mock('../lib/storage', () => {
  class StorageNotConfiguredError extends Error {
    code = 'STORAGE_NOT_CONFIGURED';
  }
  return {
    StorageNotConfiguredError,
    assertStorageConfigured: () => {},
    isStorageConfigured: () => true,
    getStorage: () => ({
      name: 'fake',
      isConfigured: () => true,
      createUploadUrl: async (key: string, contentType: string) => {
        fakeObjects.set(key, { contentType, byteSize: 1024 });
        return { uploadUrl: `https://fake.local/${key}`, expiresIn: 300 };
      },
      createDownloadUrl: async (key: string) => `https://fake.local/${key}`,
      headObject: async (key: string) => fakeObjects.get(key) ?? null,
      deleteObject: async (key: string) => {
        fakeObjects.delete(key);
      },
    }),
  };
});

type ExerciseSvc = typeof import('../services/personalExerciseService');
type LibrarySvc = typeof import('../services/exerciseLibraryService');
type PlanSvc = typeof import('../services/personalWorkoutPlanService');

describeWithDb('Exercícios personalizados do personal · CRUD, visibilidade e isolamento', () => {
  let c: Client;
  let svc: ExerciseSvc;
  let lib: LibrarySvc;
  let planSvc: PlanSvc;

  /** Personais criados nesta suíte — limpos ANTES de `cleanFixtures` apagar os usuários. */
  const personalIds: number[] = [];
  /**
   * Exercícios que ficam ÓRFÃOS de propósito (owner_personal_id vira NULL) —
   * o teste de exclusão de conta é o único caso. Não são achados pelo DELETE
   * por `owner_personal_id`, então precisam de rastro próprio ou sobrevivem
   * para sempre como linha `source='personal'` arquivada e sem dono.
   */
  const orphanedExerciseIds: string[] = [];

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    svc = await import('../services/personalExerciseService');
    lib = await import('../services/exerciseLibraryService');
    planSvc = await import('../services/personalWorkoutPlanService');
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      // `owner_personal_id` é ON DELETE SET NULL — sem apagar antes, os
      // exercícios de personal desta suíte sobreviveriam ao DELETE dos
      // usuários como linhas globais órfãs (owner NULL), poluindo a busca
      // global de outras suítes.
      if (personalIds.length) {
        await c.query(`DELETE FROM exercises WHERE owner_personal_id = ANY($1::int[])`, [personalIds]);
        // Mesmo defeito documentado no CLAUDE.md (02/ago) que `accountDeletionService.ts`
        // já corrige em produção: `workout_protocols.owner_personal_id` também é
        // ON DELETE SET NULL, mas o CHECK exige dono quando `scope='personal'` —
        // os testes de `assertExercisesExist` criam ficha de verdade (que gera
        // snapshot de protocolo), então a limpeza precisa do mesmo passo aqui.
        await c.query(
          `DELETE FROM workout_protocols WHERE owner_personal_id = ANY($1::int[]) AND scope = 'personal'`,
          [personalIds],
        );
      }
      if (orphanedExerciseIds.length) {
        await c.query(`DELETE FROM exercises WHERE id = ANY($1::uuid[])`, [orphanedExerciseIds]);
      }
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  async function personalUser(label: string): Promise<number> {
    seq += 1;
    const id = await createUser(c, TAG, `${label}-${seq}`);
    personalIds.push(id);
    return id;
  }

  /** Personal + aluno com vínculo ativo — pré-requisito de `assertStudentAssignedToPersonal`. */
  async function dupla(): Promise<{ personalId: number; studentId: number }> {
    const personalId = await personalUser('personal');
    seq += 1;
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );
    return { personalId, studentId };
  }

  // -------------------------------------------------------------------------
  // CRUD e posse
  // -------------------------------------------------------------------------

  it('cria exercício válido com dono, status active e nome normalizado', async () => {
    const personalId = await personalUser('criador');
    const created = await svc.createPersonalExercise(personalId, {
      name: '  Supino Reto Halteres  ',
      bodyPart: 'peito',
      equipment: 'halteres',
    });
    expect(created.ownerPersonalId).toBe(String(personalId));
    expect(created.status).toBe('active');
    expect(created.source).toBe('personal');
    expect(created.normalizedName).toBe('supino reto halteres');
  });

  it('nome vazio é rejeitado com 400', async () => {
    const personalId = await personalUser('sem-nome');
    await expect(
      svc.createPersonalExercise(personalId, { name: '   ', bodyPart: 'peito' }),
    ).rejects.toMatchObject({ message: 'invalid_name', status: 400 });
  });

  it('grupo muscular principal (bodyPart) vazio é rejeitado com 400', async () => {
    const personalId = await personalUser('sem-bodypart');
    await expect(
      svc.createPersonalExercise(personalId, { name: 'Puxada Alta', bodyPart: '' }),
    ).rejects.toMatchObject({ message: 'invalid_body_part', status: 400 });
  });

  it('personal edita o próprio exercício', async () => {
    const personalId = await personalUser('editor');
    const created = await svc.createPersonalExercise(personalId, { name: 'Remada Curvada', bodyPart: 'costas' });
    const updated = await svc.updatePersonalExercise(personalId, created.id, { equipment: 'barra', tags: ['costas', 'puxada'] });
    expect(updated.equipment).toBe('barra');
    expect(updated.tags).toEqual(['costas', 'puxada']);
    expect(updated.name).toBe('Remada Curvada');
  });

  it('personal B não edita nem arquiva exercício de personal A — 404 (serviço)', async () => {
    const a = await personalUser('dono-a');
    const b = await personalUser('estranho-b');
    const created = await svc.createPersonalExercise(a, { name: 'Leg Press 45', bodyPart: 'perna' });

    await expect(
      svc.updatePersonalExercise(b, created.id, { equipment: 'maquina' }),
    ).rejects.toMatchObject({ message: 'exercise_not_found', status: 404 });
    await expect(svc.archivePersonalExercise(b, created.id)).rejects.toMatchObject({
      message: 'exercise_not_found',
      status: 404,
    });
    await expect(svc.restorePersonalExercise(b, created.id)).rejects.toMatchObject({
      message: 'exercise_not_found',
      status: 404,
    });

    // Nada mudou do lado de A.
    const intacto = await lib.getExerciseById(created.id);
    expect(intacto?.status).toBe('active');
    expect(intacto?.equipment).not.toBe('maquina');
  });

  // -------------------------------------------------------------------------
  // Ciclo de vida: arquivar / restaurar
  // -------------------------------------------------------------------------

  it('arquivar remove da busca padrão; includeArchived/ownerOnly ainda mostram', async () => {
    const personalId = await personalUser('arquivista');
    const created = await svc.createPersonalExercise(personalId, { name: 'Crucifixo Inverso XPT', bodyPart: 'ombro' });

    const antes = await lib.searchExercises({ q: 'Crucifixo Inverso XPT', viewerPersonalId: personalId });
    expect(antes.map((e) => e.id)).toContain(created.id);

    const arquivado = await svc.archivePersonalExercise(personalId, created.id);
    expect(arquivado.status).toBe('archived');

    const depois = await lib.searchExercises({ q: 'Crucifixo Inverso XPT', viewerPersonalId: personalId });
    expect(depois.map((e) => e.id)).not.toContain(created.id);

    const gestaoTudo = await svc.listPersonalExercises(personalId, { status: 'all' });
    expect(gestaoTudo.map((e) => e.id)).toContain(created.id);

    const gestaoArquivados = await svc.listPersonalExercises(personalId, { status: 'archived' });
    expect(gestaoArquivados.map((e) => e.id)).toContain(created.id);
  });

  it('restaurar devolve à busca; nome ativo duplicado no restore → 409', async () => {
    const personalId = await personalUser('restaurador');
    const original = await svc.createPersonalExercise(personalId, { name: 'Cadeira Extensora RST', bodyPart: 'perna' });
    await svc.archivePersonalExercise(personalId, original.id);

    // A UNIQUE parcial é escopada a status='active' (correção pós-revisão do
    // desenho) — arquivar LIBERA o nome, então este segundo create sucede.
    const homonimo = await svc.createPersonalExercise(personalId, { name: 'Cadeira Extensora RST', bodyPart: 'perna' });
    expect(homonimo.id).not.toBe(original.id);

    // Restaurar o original agora colide com o homônimo ativo — 409 claro.
    await expect(svc.restorePersonalExercise(personalId, original.id)).rejects.toMatchObject({
      message: 'DUPLICATE_NAME',
      status: 409,
    });

    // Sem o homônimo no caminho, a restauração simples funciona.
    const outroPersonal = await personalUser('restaurador-simples');
    const solo = await svc.createPersonalExercise(outroPersonal, { name: 'Panturrilha em Pé RST', bodyPart: 'perna' });
    await svc.archivePersonalExercise(outroPersonal, solo.id);
    const restaurado = await svc.restorePersonalExercise(outroPersonal, solo.id);
    expect(restaurado.status).toBe('active');
    const buscaRestaurada = await lib.searchExercises({ q: 'Panturrilha em Pé RST', viewerPersonalId: outroPersonal });
    expect(buscaRestaurada.map((e) => e.id)).toContain(solo.id);
  });

  it('exercício arquivado continua resolvendo por id (ficha/histórico já salvos não quebram)', async () => {
    const personalId = await personalUser('resolve-arquivado');
    const created = await svc.createPersonalExercise(personalId, { name: 'Stiff com Barra RSV', bodyPart: 'posterior' });
    await svc.archivePersonalExercise(personalId, created.id);

    const porId = await lib.getExerciseById(created.id);
    expect(porId?.status).toBe('archived');
    expect(porId?.id).toBe(created.id);

    const emLote = await lib.getExercisesBatch([created.id]);
    expect(emLote).toHaveLength(1);
    expect(emLote[0].id).toBe(created.id);
  });

  // -------------------------------------------------------------------------
  // Unicidade por-dono (D2/D3) — dois personais podem repetir nome; um não
  // -------------------------------------------------------------------------

  it('dois personais diferentes criam exercício com o MESMO nome sem colidir', async () => {
    const p1 = await personalUser('p1-homonimo');
    const p2 = await personalUser('p2-homonimo');
    const e1 = await svc.createPersonalExercise(p1, { name: 'Rosca Direta Homônima', bodyPart: 'biceps' });
    const e2 = await svc.createPersonalExercise(p2, { name: 'Rosca Direta Homônima', bodyPart: 'biceps' });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.ownerPersonalId).toBe(String(p1));
    expect(e2.ownerPersonalId).toBe(String(p2));
  });

  it('o MESMO personal não cria dois exercícios ativos com o mesmo nome — 409', async () => {
    const personalId = await personalUser('duplicador');
    await svc.createPersonalExercise(personalId, { name: 'Tríceps Corda Único', bodyPart: 'triceps' });
    await expect(
      svc.createPersonalExercise(personalId, { name: 'tríceps CORDA único', bodyPart: 'triceps' }),
    ).rejects.toMatchObject({ message: 'DUPLICATE_NAME', status: 409 });
  });

  it('dedup da busca não colapsa exercício de personal com exercício global homônimo (D3)', async () => {
    const personalId = await personalUser('dedup');
    const globalId = await createExercise(c, TAG, 'Agachamento Livre Dedup');
    const meu = await svc.createPersonalExercise(personalId, { name: 'Agachamento Livre Dedup', bodyPart: 'perna' });

    const resultado = await lib.searchExercises({ q: 'Agachamento Livre Dedup', viewerPersonalId: personalId });
    const ids = resultado.map((e) => e.id);
    expect(ids).toContain(globalId);
    expect(ids).toContain(meu.id);
  });

  // -------------------------------------------------------------------------
  // Visibilidade (D4) — aluno com/sem personal atribuído
  // -------------------------------------------------------------------------

  it('aluno sem personal atribuído não vê exercício de nenhum personal', async () => {
    const { personalId } = await dupla();
    const meuExercicio = await svc.createPersonalExercise(personalId, { name: 'Puxada Frontal Solo XY', bodyPart: 'costas' });

    // `viewerPersonalId: null` é exatamente o que a rota resolve para um
    // aluno sem linha ativa em `personal_student_assignments` — testado de
    // ponta a ponta (incluindo a resolução em si) no bloco HTTP abaixo.
    const resultado = await lib.searchExercises({ q: 'Puxada Frontal Solo XY', viewerPersonalId: null });
    expect(resultado.map((e) => e.id)).not.toContain(meuExercicio.id);
  });

  it('aluno COM personal atribuído vê a biblioteca do SEU personal, não de outro', async () => {
    const { personalId: meuPersonal, studentId } = await dupla();
    const outroPersonal = await personalUser('nao-e-meu');

    const doMeu = await svc.createPersonalExercise(meuPersonal, { name: 'Elevação Lateral MP', bodyPart: 'ombro' });
    const doOutro = await svc.createPersonalExercise(outroPersonal, { name: 'Elevação Lateral OP', bodyPart: 'ombro' });

    // Resolução do viewer é exatamente a que a rota faz: personal ativo do aluno.
    const { rows } = await c.query<{ personal_id: number }>(
      `SELECT personal_id FROM personal_student_assignments WHERE student_id = $1 AND status = 'active' LIMIT 1`,
      [studentId],
    );
    const viewerPersonalId = rows[0]?.personal_id ?? null;
    expect(viewerPersonalId).toBe(meuPersonal);

    const buscaDoMeu = await lib.searchExercises({ q: 'Elevação Lateral', viewerPersonalId });
    const ids = buscaDoMeu.map((e) => e.id);
    expect(ids).toContain(doMeu.id);
    expect(ids).not.toContain(doOutro.id);
  });

  // -------------------------------------------------------------------------
  // `assertExercisesExist` — propriedade na ficha (D5)
  // -------------------------------------------------------------------------

  it('personal A não pode salvar ficha referenciando exerciseId privado de personal B', async () => {
    const a = await dupla();
    const b = await personalUser('dono-exercicio-privado');
    const exercicioDeB = await svc.createPersonalExercise(b, { name: 'Cross Over Privado', bodyPart: 'peito' });

    await expect(
      planSvc.createPersonalWorkoutPlan(a.personalId, a.studentId, null, {
        title: 'Ficha inválida',
        weekPreset: '3',
        selectedGroup: null,
        items: [
          {
            exerciseId: exercicioDeB.id,
            name: 'Cross Over Privado',
            sets: '3',
            reps: '10',
            rest: '60',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EXERCISES' });
  });

  it('personal pode salvar ficha referenciando exercício da PRÓPRIA biblioteca', async () => {
    const { personalId, studentId } = await dupla();
    const meuExercicio = await svc.createPersonalExercise(personalId, { name: 'Supino Máquina Próprio', bodyPart: 'peito' });

    const plano = await planSvc.createPersonalWorkoutPlan(personalId, studentId, null, {
      title: 'Ficha válida',
      weekPreset: '3',
      selectedGroup: null,
      items: [
        {
          exerciseId: meuExercicio.id,
          name: 'Supino Máquina Próprio',
          sets: '3',
          reps: '10',
          rest: '60',
        },
      ],
    });
    expect(plano.id).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Execução real — payoff do D1 (nenhum código novo aqui)
  // -------------------------------------------------------------------------

  it('exercício personalizado participa de execução real (PR + histórico) exatamente como um global', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const personalId = await personalUser('execucao');
    const meuExercicio = await svc.createPersonalExercise(personalId, { name: 'Supino Inclinado Halteres EXE', bodyPart: 'peito' });
    // A sessão é do ALUNO — mas o exercício em si não pertence a `users`, só
    // precisa existir em `exercises`; qualquer userId serve para provar o
    // caminho de PR/set-log.
    const userId = await createUser(c, TAG, `aluno-execucao-${++seq}`);

    const res = await createSession(userId, null, {
      source: 'free',
      status: 'completed',
      sessionRpe: 8,
      sets: [
        { exerciseId: meuExercicio.id, name: meuExercicio.name, setIndex: 1, repsDone: 10, loadDoneKg: 60, status: 'done' },
      ],
    });

    expect(res.prEvents.length).toBeGreaterThan(0);
    expect(res.prEvents.some((p) => p.exerciseId === meuExercicio.id)).toBe(true);

    const { rows: setLogs } = await c.query(
      `SELECT exercise_id FROM workout_set_logs WHERE session_id = $1`,
      [res.id],
    );
    expect(setLogs).toHaveLength(1);
    expect(setLogs[0].exercise_id).toBe(meuExercicio.id);

    const { rows: prRows } = await c.query(
      `SELECT exercise_id FROM user_pr_events WHERE user_id = $1`,
      [userId],
    );
    expect(prRows.some((r) => r.exercise_id === meuExercicio.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Mídia — presigned upload, YouTube, posse, troca de is_primary
  // -------------------------------------------------------------------------

  it('upload-url só é gerado para o dono; registro rejeita quem não é dono; is_primary troca certo', async () => {
    const dono = await personalUser('midia-dono');
    const estranho = await personalUser('midia-estranho');
    const exercicio = await svc.createPersonalExercise(dono, { name: 'Face Pull Mídia', bodyPart: 'ombro' });

    await expect(
      svc.createExerciseMediaUploadTarget(estranho, exercicio.id, 'image/jpeg', 1000),
    ).rejects.toMatchObject({ message: 'exercise_not_found', status: 404 });

    const target = await svc.createExerciseMediaUploadTarget(dono, exercicio.id, 'image/jpeg', 1000);
    expect(target.storageKey.startsWith(`exercise-media/${dono}/${exercicio.id}/`)).toBe(true);

    await expect(
      svc.registerExerciseMedia(estranho, exercicio.id, { storageKey: target.storageKey }),
    ).rejects.toMatchObject({ message: 'exercise_not_found', status: 404 });

    await svc.registerExerciseMedia(dono, exercicio.id, { storageKey: target.storageKey, isPrimary: true });

    const target2 = await svc.createExerciseMediaUploadTarget(dono, exercicio.id, 'image/png', 2000);
    await svc.registerExerciseMedia(dono, exercicio.id, { storageKey: target2.storageKey, isPrimary: true });

    const { rows: mediaRows } = await c.query(
      `SELECT url, is_primary FROM exercise_media WHERE exercise_id = $1 ORDER BY created_at`,
      [exercicio.id],
    );
    expect(mediaRows).toHaveLength(2);
    expect(mediaRows.filter((r) => r.is_primary)).toHaveLength(1);
    expect(mediaRows.find((r) => r.is_primary)?.url).toBe(target2.storageKey);
  });

  it('link do YouTube é aceito; URL inválida é rejeitada; delete de mídia exige posse', async () => {
    const dono = await personalUser('midia-youtube-dono');
    const estranho = await personalUser('midia-youtube-estranho');
    const exercicio = await svc.createPersonalExercise(dono, { name: 'Remada Unilateral YT', bodyPart: 'costas' });

    await expect(
      svc.registerExerciseYoutubeLink(dono, exercicio.id, { url: 'not-a-youtube-url' }),
    ).rejects.toMatchObject({ message: 'invalid_youtube_url', status: 400 });

    await svc.registerExerciseYoutubeLink(dono, exercicio.id, { url: 'https://www.youtube.com/watch?v=abc123' });

    const { rows } = await c.query(
      `SELECT id FROM exercise_media WHERE exercise_id = $1 AND media_type = 'youtube'`,
      [exercicio.id],
    );
    expect(rows).toHaveLength(1);
    const mediaId = rows[0].id;

    await expect(svc.deleteExerciseMedia(estranho, exercicio.id, mediaId)).rejects.toMatchObject({
      message: 'media_not_found',
      status: 404,
    });
    await svc.deleteExerciseMedia(dono, exercicio.id, mediaId);

    const { rows: depois } = await c.query(`SELECT id FROM exercise_media WHERE id = $1`, [mediaId]);
    expect(depois).toHaveLength(0);
  });

  it('leitura de volta assina a URL de mídia de personal; mídia global continua crua', async () => {
    const dono = await personalUser('midia-leitura-dono');
    const exercicioPersonal = await svc.createPersonalExercise(dono, { name: 'Cadeira Extensora Leitura', bodyPart: 'perna' });
    const target = await svc.createExerciseMediaUploadTarget(dono, exercicioPersonal.id, 'image/jpeg', 1000);
    await svc.registerExerciseMedia(dono, exercicioPersonal.id, { storageKey: target.storageKey, isPrimary: true });

    // Fixture de exercício GLOBAL com mídia gravada como URL pública de
    // verdade (padrão `gifdotreino`, ver memória do projeto) — nunca deve
    // ser assinada.
    const exercicioGlobalId = await createExercise(c, TAG, 'Puxada Frontal Leitura');
    orphanedExerciseIds.push(exercicioGlobalId);
    const globalUrl = 'https://media.s2core.com.br/gifdotreino/puxada-frontal.gif';
    await c.query(
      `INSERT INTO exercise_media (exercise_id, media_type, url, source, is_primary)
       VALUES ($1, 'gif', $2, 'gifdotreino', true)`,
      [exercicioGlobalId, globalUrl],
    );

    // getExerciseById: personal vem assinado (URL fetchável, != storageKey crua); global sai como estava.
    const porIdPersonal = await lib.getExerciseById(exercicioPersonal.id);
    const mediaPersonal = porIdPersonal!.media.find((m) => m.isPrimary)!;
    expect(mediaPersonal.url).not.toBe(target.storageKey);
    expect(mediaPersonal.url).toContain('http');
    expect(mediaPersonal.url).toContain(target.storageKey);

    const porIdGlobal = await lib.getExerciseById(exercicioGlobalId);
    expect(porIdGlobal!.media[0].url).toBe(globalUrl);

    // searchExercises (o caminho mais visitado — pickers do builder e do aluno):
    // mesma garantia via primary_media_url.
    const buscaPersonal = await lib.searchExercises({ ownerOnly: dono });
    const resumoPersonal = buscaPersonal.find((r) => r.id === exercicioPersonal.id)!;
    expect(resumoPersonal.primaryMediaUrl).not.toBe(target.storageKey);
    expect(resumoPersonal.primaryMediaUrl).toContain('http');

    const buscaGlobal = await lib.searchExercises({ q: 'Puxada Frontal Leitura' });
    const resumoGlobal = buscaGlobal.find((r) => r.id === exercicioGlobalId)!;
    expect(resumoGlobal.primaryMediaUrl).toBe(globalUrl);

    // getExercisesBatch: mesmo par personal+global numa chamada só.
    const lote = await lib.getExercisesBatch([exercicioPersonal.id, exercicioGlobalId]);
    const lotePersonal = lote.find((e) => e.id === exercicioPersonal.id)!;
    const loteGlobal = lote.find((e) => e.id === exercicioGlobalId)!;
    expect(lotePersonal.media[0].url).not.toBe(target.storageKey);
    expect(loteGlobal.media[0].url).toBe(globalUrl);
  });

  // -------------------------------------------------------------------------
  // Exclusão de conta do personal — arquiva ANTES do DELETE (D6)
  // -------------------------------------------------------------------------

  it('excluir a conta do personal arquiva os exercícios antes do DELETE', async () => {
    const { deleteUserAccount } = await import('../services/accountDeletionService');
    const personalId = await personalUser('exclusao');
    const exercicio = await svc.createPersonalExercise(personalId, { name: 'Desenvolvimento Militar EXCL', bodyPart: 'ombro' });
    // Depois do DELETE o dono vira NULL — a linha para de ser achável pelo
    // DELETE por `owner_personal_id` do afterAll; precisa do próprio rastro.
    orphanedExerciseIds.push(exercicio.id);

    await deleteUserAccount(personalId, { requestedBy: 'self' });

    const { rows } = await c.query(
      `SELECT status, owner_personal_id FROM exercises WHERE id = $1`,
      [exercicio.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('archived');
    expect(rows[0].owner_personal_id).toBeNull();

    // Remove da lista de limpeza — o usuário já não existe mais.
    const idx = personalIds.indexOf(personalId);
    if (idx >= 0) personalIds.splice(idx, 1);
  });

  // -------------------------------------------------------------------------
  // Contrato HTTP — molde de personal-finance.integration.test.ts
  // -------------------------------------------------------------------------

  describe('rotas HTTP /api/personal/exercises e /api/exercises', () => {
    let app: import('express').Express;
    let token: (userId: number, role?: 'user' | 'personal' | 'nutri' | 'admin', products?: string[]) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const personalExRoutes = (await import('../routes/personalExercises')).default;
      const catalogRoutes = (await import('../routes/exercises')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      app = express();
      app.use(express.json());
      app.use('/api/personal', personalExRoutes);
      app.use('/api/exercises', catalogRoutes);

      token = (userId, role = 'personal', products = ['personal']) =>
        generateAccessToken({ id: userId, email: `${userId}@test.local`, role, profileCompleted: true, products });
    });

    it('cria via HTTP (201) e aparece só para o dono na busca — não para outro personal nem admin', async () => {
      const request = (await import('supertest')).default;
      const dono = await personalUser('http-dono');
      const outro = await personalUser('http-outro');

      const criado = await request(app)
        .post('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(dono)}`)
        .send({ name: 'Voador Peitoral HTTP', bodyPart: 'peito', equipment: 'maquina' });
      expect(criado.status).toBe(201);
      const exercicio = criado.body.data.exercise;
      expect(exercicio.ownerPersonalId).toBe(String(dono));
      expect(exercicio.status).toBe('active');

      const buscaDono = await request(app)
        .get('/api/exercises?q=Voador Peitoral HTTP')
        .set('Authorization', `Bearer ${token(dono)}`);
      expect(buscaDono.body.exercises.map((e: any) => e.id)).toContain(exercicio.id);

      const buscaOutro = await request(app)
        .get('/api/exercises?q=Voador Peitoral HTTP')
        .set('Authorization', `Bearer ${token(outro)}`);
      expect(buscaOutro.body.exercises.map((e: any) => e.id)).not.toContain(exercicio.id);

      const buscaAdmin = await request(app)
        .get('/api/exercises?q=Voador Peitoral HTTP')
        .set('Authorization', `Bearer ${token(dono, 'admin', [])}`);
      expect(buscaAdmin.body.exercises.map((e: any) => e.id)).not.toContain(exercicio.id);
    });

    it('POST sem nome → 400; PATCH/archive de outro dono → 404 pelo HTTP', async () => {
      const request = (await import('supertest')).default;
      const dono = await personalUser('http-sem-nome');
      const outro = await personalUser('http-404');

      const semNome = await request(app)
        .post('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(dono)}`)
        .send({ bodyPart: 'peito' });
      expect(semNome.status).toBe(400);

      const criado = await request(app)
        .post('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(dono)}`)
        .send({ name: 'Panturrilha Sentado HTTP', bodyPart: 'perna' });
      const exerciseId = criado.body.data.exercise.id;

      const patchAlheio = await request(app)
        .patch(`/api/personal/exercises/${exerciseId}`)
        .set('Authorization', `Bearer ${token(outro)}`)
        .send({ equipment: 'maquina' });
      expect(patchAlheio.status).toBe(404);

      const archiveAlheio = await request(app)
        .post(`/api/personal/exercises/${exerciseId}/archive`)
        .set('Authorization', `Bearer ${token(outro)}`);
      expect(archiveAlheio.status).toBe(404);

      // Confirma que nada mudou do lado do dono.
      const lista = await request(app)
        .get('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(dono)}`);
      expect(lista.body.data.exercises.find((e: any) => e.id === exerciseId)?.status).toBe('active');
    });

    it('id fora do formato UUID responde 400 sem tocar o banco', async () => {
      const request = (await import('supertest')).default;
      const dono = await personalUser('http-uuid-invalido');
      const res = await request(app)
        .patch('/api/personal/exercises/nao-e-um-uuid')
        .set('Authorization', `Bearer ${token(dono)}`)
        .send({ equipment: 'barra' });
      expect(res.status).toBe(400);
    });

    it('GET /api/exercises resolve o viewer no SERVIDOR pelo papel — nunca por query param', async () => {
      const request = (await import('supertest')).default;
      const { personalId: meuPersonal, studentId } = await dupla();
      const outroPersonal = await personalUser('http-viewer-outro');

      const doMeu = await request(app)
        .post('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(meuPersonal)}`)
        .send({ name: 'Rosca Scott Viewer HTTP', bodyPart: 'biceps' });
      const doOutro = await request(app)
        .post('/api/personal/exercises')
        .set('Authorization', `Bearer ${token(outroPersonal)}`)
        .send({ name: 'Rosca Scott Viewer HTTP', bodyPart: 'biceps' });
      expect(doMeu.status).toBe(201);
      expect(doOutro.status).toBe(201);

      // Aluno COM o personal atribuído: vê o exercício do SEU personal, não
      // o do outro — mesmo tentando "passar" o outro personal por query
      // param (que a rota ignora de propósito, D4).
      const buscaComPersonal = await request(app)
        .get(`/api/exercises?q=Rosca Scott Viewer HTTP&viewerPersonalId=${outroPersonal}`)
        .set('Authorization', `Bearer ${token(studentId, 'user', ['personal'])}`);
      const idsComPersonal = buscaComPersonal.body.exercises.map((e: any) => e.id);
      expect(idsComPersonal).toContain(doMeu.body.data.exercise.id);
      expect(idsComPersonal).not.toContain(doOutro.body.data.exercise.id);

      // Aluno SEM personal atribuído: só o catálogo global (nenhum dos dois).
      seq += 1;
      const alunoSolto = await createUser(c, TAG, `aluno-solto-http-${seq}`);
      const buscaSemPersonal = await request(app)
        .get('/api/exercises?q=Rosca Scott Viewer HTTP')
        .set('Authorization', `Bearer ${token(alunoSolto, 'user', ['personal'])}`);
      const idsSemPersonal = buscaSemPersonal.body.exercises.map((e: any) => e.id);
      expect(idsSemPersonal).not.toContain(doMeu.body.data.exercise.id);
      expect(idsSemPersonal).not.toContain(doOutro.body.data.exercise.id);
    });
  });
});
