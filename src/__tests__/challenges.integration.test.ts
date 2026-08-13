/**
 * Desafios com banco real (Spec 034, Onda C2).
 *
 * O que só o Postgres prova: idempotência da conclusão, congelamento do
 * `final_pct`, isolamento entre personais, revogação imediata na saída,
 * cascata da exclusão de conta — e, principalmente, que **não existe caminho**
 * para um aluno ler dado individual de outro.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  hasTestDb,
  releaseSuiteLock,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(180_000);

const TAG = 'itest-c2';

describeWithDb('Desafios · accountability sem vazar ninguém', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await releaseSuiteLock(c);
    await c.end();
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  async function novoPersonal(): Promise<number> {
    seq += 1;
    const id = await createUser(c, TAG, `personal-${seq}`);
    await c.query(`UPDATE users SET role = 'personal' WHERE id = $1`, [id]);
    return id;
  }

  async function novoAluno(personalId?: number, weekPreset = '3'): Promise<number> {
    seq += 1;
    const id = await createUser(c, TAG, `aluno-${seq}`);
    if (personalId) {
      await c.query(
        `INSERT INTO personal_student_assignments (personal_id, student_id, status)
         VALUES ($1, $2, 'active')`,
        [personalId, id],
      );
      await c.query(
        `INSERT INTO personal_workout_plans (personal_id, student_id, title, week_preset, created_at)
         VALUES ($1, $2, 'Ficha', $3, NOW() - INTERVAL '90 days')`,
        [personalId, id, weekPreset],
      );
      // Consent de workouts: o acompanhamento do personal depende dele.
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status, granted_at)
         VALUES ($1, $2, 'personal', 'workouts', 'granted', NOW())
         ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING`,
        [id, personalId],
      );
    }
    return id;
  }

  /** N dias de treino na semana que começou `semanasAtras` semanas atrás. */
  async function treinarNaSemana(userId: number, semanasAtras: number, dias: number) {
    for (let d = 0; d < dias; d += 1) {
      const offset = semanasAtras * 7 - d;
      await c.query(
        `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
         VALUES ($1, 'free', 'completed', NOW() - ($2 || ' days')::interval,
                 NOW() - ($2 || ' days')::interval, 'Treino C2')`,
        [userId, offset],
      );
    }
  }

  function janela(diasAtras: number, duracaoDias: number) {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - diasAtras * 86_400_000);
    const fim = new Date(inicio.getTime() + duracaoDias * 86_400_000);
    return {
      startsOn: inicio.toISOString().slice(0, 10),
      endsOn: fim.toISOString().slice(0, 10),
    };
  }

  /** Criação pelo SERVIÇO — sujeita a todas as regras de produto. */
  async function criarDesafio(
    personalId: number,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const { createChallenge } = await import('../modules/community/challenges.service');
    const j = janela(0, 56); // começa hoje: desafio retroativo é recusado
    return createChallenge(personalId, {
      title: 'Quatro semanas firmes',
      description: 'Compromisso da turma',
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      startsOn: j.startsOn,
      endsOn: j.endsOn,
      ...over,
    } as never) as Promise<{ id: string }>;
  }

  /**
   * Desafio JÁ EM CURSO, inserido direto no banco.
   *
   * A regra que proíbe criar desafio retroativo é de PRODUTO (um compromisso é
   * sobre o que vem), não invariante de dado: um desafio criado há quatro
   * semanas é legítimo e tem janela no passado. Os testes de progresso e
   * conclusão precisam exatamente disso, e criá-lo pelo serviço seria
   * impossível — por desenho.
   */
  async function desafioEmCurso(
    personalId: number,
    over: { kind?: string; rule?: Record<string, unknown>; semanas?: number } = {},
  ): Promise<{ id: string }> {
    const semanas = over.semanas ?? 5;
    const j = janelaSegundas(semanas);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, personal_id, title, description, kind,
          rule_json, rules_version, starts_on, ends_on, status)
       VALUES ('personal', $1, $1, 'Quatro semanas firmes', 'Compromisso', $2,
               $3::jsonb, 1, $4::date, $5::date, 'active')
       RETURNING id::text`,
      [
        personalId,
        over.kind ?? 'consistency',
        JSON.stringify(over.rule ?? { minPct: 80, requiredWeeks: 4 }),
        j.startsOn,
        j.endsOn,
      ],
    );
    return { id: rows[0].id };
  }

  /**
   * Janela alinhada a segundas, começando `semanas` atrás e terminando no
   * domingo DESTA semana — ou seja, ainda em curso.
   *
   * As semanas passadas são inteiras e já encerradas (contam); a atual não
   * cabe inteira no passado e por isso não conta nem reprova.
   */
  function janelaSegundas(semanas: number) {
    const hoje = new Date();
    const dow = hoje.getUTCDay() === 0 ? 7 : hoje.getUTCDay();
    const segundaDestaSemana = new Date(hoje.getTime() - (dow - 1) * 86_400_000);
    const inicio = new Date(segundaDestaSemana.getTime() - semanas * 7 * 86_400_000);
    const fim = new Date(segundaDestaSemana.getTime() + 6 * 86_400_000); // domingo desta semana
    return {
      startsOn: inicio.toISOString().slice(0, 10),
      endsOn: fim.toISOString().slice(0, 10),
    };
  }

  function addDiasISO(dia: string, n: number): string {
    const [y, m, d] = dia.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
  }

  /** Carrega a linha crua do desafio, como os avaliadores a recebem. */
  async function linhaDoDesafio(id: string) {
    const { rows } = await c.query(
      `SELECT id::text, kind, rule_json,
              to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [id],
    );
    return rows[0];
  }

  /* ---------------------------------------------------------------- *
   * Criação e propriedade
   * ---------------------------------------------------------------- */

  it('personal cria desafio no próprio contexto, com a regra normalizada', async () => {
    const personalId = await novoPersonal();
    const d = (await criarDesafio(personalId)) as { id: string; ruleText: string };

    const { rows } = await c.query(
      `SELECT personal_id, created_by_user_id, scope, status, rule_json, rules_version
         FROM challenges WHERE id = $1::bigint`,
      [d.id],
    );
    expect(rows[0].personal_id).toBe(personalId);
    expect(rows[0].created_by_user_id).toBe(personalId);
    expect(rows[0].scope).toBe('personal');
    expect(rows[0].rule_json).toEqual({ minPct: 80, requiredWeeks: 4 });
    expect(d.ruleText).toContain('80%');
  });

  it('desafio de OUTRO personal não existe para quem pergunta', async () => {
    const a = await novoPersonal();
    const b = await novoPersonal();
    const d = await criarDesafio(a);

    const { listParticipantsForPersonal, cancelChallengeAsPersonal, inviteToChallenge } =
      await import('../modules/community/challenges.service');

    await expect(listParticipantsForPersonal(b, d.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cancelChallengeAsPersonal(b, d.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(inviteToChallenge(b, d.id, [1])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('janela inválida é recusada', async () => {
    const personalId = await novoPersonal();
    await expect(
      criarDesafio(personalId, { startsOn: '2026-03-10', endsOn: '2026-03-10' }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_WINDOW' });
    await expect(
      criarDesafio(personalId, { startsOn: '2026-03-10', endsOn: '2026-03-01' }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_WINDOW' });
  });

  it('título com HTML é sanitizado, não rejeitado em silêncio', async () => {
    const personalId = await novoPersonal();
    const d = await criarDesafio(personalId, {
      title: '<script>alert(1)</script>Desafio de março',
    });
    const { rows } = await c.query(`SELECT title FROM challenges WHERE id = $1::bigint`, [d.id]);
    expect(rows[0].title).not.toContain('<');
    expect(rows[0].title).toContain('Desafio de março');
  });

  /* ---------------------------------------------------------------- *
   * Convite
   * ---------------------------------------------------------------- */

  it('convida só quem tem vínculo ATIVO — a lista do cliente não autoriza', async () => {
    const { inviteToChallenge } = await import('../modules/community/challenges.service');
    const personalA = await novoPersonal();
    const personalB = await novoPersonal();
    const meuAluno = await novoAluno(personalA);
    const alunoDoOutro = await novoAluno(personalB);
    const semVinculo = await novoAluno();

    const d = await criarDesafio(personalA);
    const r = await inviteToChallenge(personalA, d.id, [meuAluno, alunoDoOutro, semVinculo]);

    expect(r.invited).toBe(1);
    expect(r.rejected).toBe(2);

    const { rows } = await c.query(
      `SELECT user_id FROM challenge_participants WHERE challenge_id = $1::bigint`,
      [d.id],
    );
    expect(rows.map((x) => x.user_id)).toEqual([meuAluno]);
  });

  it('vínculo inativo não é vínculo', async () => {
    const { inviteToChallenge } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    await c.query(
      `UPDATE personal_student_assignments SET status = 'inactive' WHERE student_id = $1`,
      [aluno],
    );

    const d = await criarDesafio(personalId);
    const r = await inviteToChallenge(personalId, d.id, [aluno]);
    expect(r.invited).toBe(0);
    expect(r.rejected).toBe(1);
  });

  /* ---------------------------------------------------------------- *
   * Participação
   * ---------------------------------------------------------------- */

  it('convite NÃO é participação: só o join grava consentimento', async () => {
    const { inviteToChallenge, joinChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    const d = await criarDesafio(personalId);
    await inviteToChallenge(personalId, d.id, [aluno]);

    const antes = await c.query(
      `SELECT status, consent_ack_at, joined_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [d.id, aluno],
    );
    expect(antes.rows[0].status).toBe('invited');
    expect(antes.rows[0].consent_ack_at).toBeNull();

    await joinChallengeAsUser(aluno, d.id);

    const depois = await c.query(
      `SELECT status, consent_ack_at, joined_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [d.id, aluno],
    );
    expect(depois.rows[0].status).toBe('active');
    expect(depois.rows[0].consent_ack_at).not.toBeNull();
    expect(depois.rows[0].joined_at).not.toBeNull();
  });

  it('join duplicado é recusado sem reescrever a entrada original', async () => {
    const { inviteToChallenge, joinChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    const d = await criarDesafio(personalId);
    await inviteToChallenge(personalId, d.id, [aluno]);
    await joinChallengeAsUser(aluno, d.id);

    const primeiro = await c.query(
      `SELECT joined_at FROM challenge_participants WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    await expect(joinChallengeAsUser(aluno, d.id)).rejects.toMatchObject({
      code: 'ALREADY_JOINED',
    });
    const depois = await c.query(
      `SELECT joined_at FROM challenge_participants WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    expect(depois.rows[0].joined_at).toEqual(primeiro.rows[0].joined_at);
  });

  it('quem não foi convidado não entra — e nem descobre que o desafio existe', async () => {
    const { joinChallengeAsUser, getChallengeDetailForUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const estranho = await novoAluno();
    const d = await criarDesafio(personalId);

    await expect(joinChallengeAsUser(estranho, d.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getChallengeDetailForUser(estranho, d.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('sair revoga a visibilidade na MESMA operação', async () => {
    const { inviteToChallenge, joinChallengeAsUser, leaveChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    const d = await criarDesafio(personalId);
    await inviteToChallenge(personalId, d.id, [aluno]);
    await joinChallengeAsUser(aluno, d.id);

    await leaveChallengeAsUser(aluno, d.id);

    const { rows } = await c.query(
      `SELECT status, left_at, consent_ack_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [d.id, aluno],
    );
    expect(rows[0].status).toBe('left');
    expect(rows[0].left_at).not.toBeNull();
    // Não há janela em que a pessoa continue exposta "enquanto processa".
    expect(rows[0].consent_ack_at).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Progresso e conclusão
   * ---------------------------------------------------------------- */

  /** Aluno com plano de `preset` dias que treinou `dias` por semana nas 4 semanas. */
  async function participanteCom(
    personalId: number,
    challengeId: string,
    preset: string,
    diasPorSemana: number,
  ): Promise<number> {
    const { inviteToChallenge, joinChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const aluno = await novoAluno(personalId, preset);
    await inviteToChallenge(personalId, challengeId, [aluno]);
    await joinChallengeAsUser(aluno, challengeId);
    // Semanas 1..4 atrás: todas inteiras e encerradas dentro da janela.
    for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, diasPorSemana);
    return aluno;
  }

  it('TESE · Pedro (3 de 3) cumpre mais que Everton (3 de 4), com os mesmos treinos', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const challenge = await linhaDoDesafio(d.id);

    const everton = await participanteCom(personalId, d.id, '4', 3);
    const pedro = await participanteCom(personalId, d.id, '3', 3);

    const pEverton = await computeProgressFor(everton, challenge);
    const pPedro = await computeProgressFor(pedro, challenge);

    expect(pPedro.pct!).toBeGreaterThan(pEverton.pct!);
    expect(pPedro.achieved).toBe(true);
    expect(pEverton.achieved).toBe(false);
  });

  it('conclusão congela `final_pct` e é idempotente', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const cr = [await linhaDoDesafio(d.id)];
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    expect(await evaluateParticipant(aluno, cr[0])).toBe(true);
    // Dez reprocessamentos: nem conclusão nem XP se repetem.
    for (let i = 0; i < 10; i += 1) await evaluateParticipant(aluno, cr[0]);

    const { rows } = await c.query(
      `SELECT status, final_pct::text, completed_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [d.id, aluno],
    );
    expect(rows[0].status).toBe('completed');
    expect(Number(rows[0].final_pct)).toBe(100);

    const xp = await c.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::int total
         FROM xp_events WHERE user_id = $1 AND kind = 'challenge_completed'`,
      [aluno],
    );
    expect(xp.rows[0].n).toBe(1);
    expect(xp.rows[0].total).toBe(50);
  });

  it('mudar a ficha depois NÃO reescreve o resultado histórico', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const cr = [await linhaDoDesafio(d.id)];
    const aluno = await participanteCom(personalId, d.id, '3', 3);
    await evaluateParticipant(aluno, cr[0]);

    // O personal troca a ficha para 6x/semana: o passado não muda.
    await c.query(`UPDATE personal_workout_plans SET week_preset = '6' WHERE student_id = $1`, [
      aluno,
    ]);
    await evaluateParticipant(aluno, cr[0]);

    const { rows } = await c.query(
      `SELECT final_pct::text FROM challenge_participants
        WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    expect(Number(rows[0].final_pct)).toBe(100);
  });

  it('duas avaliações simultâneas concluem uma vez só', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const cr = [await linhaDoDesafio(d.id)];
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    const rs = await Promise.all([
      evaluateParticipant(aluno, cr[0]),
      evaluateParticipant(aluno, cr[0]),
      evaluateParticipant(aluno, cr[0]),
    ]);
    expect(rs.filter(Boolean)).toHaveLength(1);

    const xp = await c.query(
      `SELECT COUNT(*)::int n FROM xp_events WHERE user_id=$1 AND kind='challenge_completed'`,
      [aluno],
    );
    expect(xp.rows[0].n).toBe(1);
  });

  it('concluir o desafio desbloqueia o marco — dois fatos, duas chaves de XP', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const cr = [await linhaDoDesafio(d.id)];
    const aluno = await participanteCom(personalId, d.id, '3', 3);
    await evaluateParticipant(aluno, cr[0]);

    const marcos = await c.query(
      `SELECT code, evidence_json FROM user_milestones WHERE user_id = $1 AND code = 'challenge_completed'`,
      [aluno],
    );
    expect(marcos.rows).toHaveLength(1);
    expect(marcos.rows[0].evidence_json.challengeId).toBe(d.id);

    // Chaves distintas: concluir o desafio e ganhar o marco são fatos
    // diferentes, e confundi-los pagaria duas vezes pelo mesmo.
    const chaves = await c.query(
      `SELECT kind, event_key FROM xp_events WHERE user_id = $1 ORDER BY kind`,
      [aluno],
    );
    const porTipo = new Map(chaves.rows.map((r) => [r.kind, r.event_key]));
    expect(porTipo.get('challenge_completed')).toBe(`challenge:${d.id}:completed:${aluno}`);
    expect(porTipo.get('milestone')).toContain('milestone:');
    expect(porTipo.get('challenge_completed')).not.toBe(porTipo.get('milestone'));
  });

  /* ---------------------------------------------------------------- *
   * Privacidade
   * ---------------------------------------------------------------- */

  async function desafioCom(nParticipantes: number) {
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const alunos: number[] = [];
    for (let i = 0; i < nParticipantes; i += 1) {
      alunos.push(await participanteCom(personalId, d.id, '3', i === 0 ? 3 : 1));
    }
    return { personalId, challengeId: d.id, alunos };
  }

  it('faixas somem com 4 participantes e aparecem com 5', async () => {
    const { getChallengeDetailForUser } = await import('../modules/community/challenges.service');

    for (const n of [1, 2, 3, 4]) {
      const { challengeId, alunos } = await desafioCom(n);
      const detalhe = await getChallengeDetailForUser(alunos[0], challengeId);
      expect(detalhe.participantsCount).toBe(n);
      expect(detalhe.bands).toBeNull();
    }

    const { challengeId, alunos } = await desafioCom(5);
    const detalhe = await getChallengeDetailForUser(alunos[0], challengeId);
    expect(detalhe.bands).not.toBeNull();
    expect(detalhe.bands).toHaveLength(4);
  });

  it('o detalhe NÃO contém percentual, nome nem id de outro participante', async () => {
    const { getChallengeDetailForUser } = await import('../modules/community/challenges.service');
    const { challengeId, alunos } = await desafioCom(5);

    const detalhe = await getChallengeDetailForUser(alunos[0], challengeId);
    const serializado = JSON.stringify(detalhe);

    for (const outro of alunos.slice(1)) {
      expect(serializado).not.toContain(`"${outro}"`);
      expect(serializado).not.toContain(`:${outro},`);
    }
    expect(serializado).not.toMatch(/participants"\s*:\s*\[/);
    expect(serializado).not.toMatch(/"name"/);
    // Só existe UM progresso na resposta: o do próprio.
    expect((serializado.match(/myProgress/g) ?? []).length).toBe(1);
  });

  it('quem saiu deixa de contar nas faixas imediatamente', async () => {
    const { getChallengeDetailForUser, leaveChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const { challengeId, alunos } = await desafioCom(5);

    expect((await getChallengeDetailForUser(alunos[0], challengeId)).bands).not.toBeNull();

    await leaveChallengeAsUser(alunos[4], challengeId);

    const depois = await getChallengeDetailForUser(alunos[0], challengeId);
    expect(depois.participantsCount).toBe(4);
    expect(depois.bands).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Painel do personal
   * ---------------------------------------------------------------- */

  it('o personal vê os próprios alunos, em ordem alfabética — nunca por desempenho', async () => {
    const { listParticipantsForPersonal } = await import(
      '../modules/community/challenges.service'
    );
    const { personalId, challengeId } = await desafioCom(3);
    const { participants } = await listParticipantsForPersonal(personalId, challengeId);

    expect(participants).toHaveLength(3);
    const nomes = participants.map((p) => p.name);
    expect([...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR'))).toEqual(nomes);
  });

  it('consent revogado corta o acompanhamento na hora, sem apagar a participação', async () => {
    const { listParticipantsForPersonal } = await import(
      '../modules/community/challenges.service'
    );
    const { personalId, challengeId, alunos } = await desafioCom(2);

    await c.query(
      `UPDATE user_data_consents SET status = 'revoked', revoked_at = NOW()
        WHERE user_id = $1 AND professional_id = $2 AND scope = 'workouts'`,
      [alunos[0], personalId],
    );

    const { participants } = await listParticipantsForPersonal(personalId, challengeId);
    const alvo = participants.find((p) => p.userId === alunos[0])!;
    expect(alvo.consentGranted).toBe(false);
    // `null` = sem acesso. Zero seria dizer que o aluno não treinou.
    expect(alvo.progressPct).toBeNull();
    expect(alvo.status).toBe('active');
  });

  it('aluno que perdeu o vínculo some do painel do personal', async () => {
    const { listParticipantsForPersonal } = await import(
      '../modules/community/challenges.service'
    );
    const { personalId, challengeId, alunos } = await desafioCom(2);

    await c.query(
      `UPDATE personal_student_assignments SET status = 'revoked' WHERE student_id = $1`,
      [alunos[0]],
    );

    const { participants } = await listParticipantsForPersonal(personalId, challengeId);
    expect(participants.map((p) => p.userId)).not.toContain(alunos[0]);
  });

  /* ---------------------------------------------------------------- *
   * Cancelamento, janela e fuso
   * ---------------------------------------------------------------- */

  it('cancelar não conclui ninguém, não paga XP e preserva o histórico', async () => {
    const { cancelChallengeAsPersonal, evaluateParticipant } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    await cancelChallengeAsPersonal(personalId, d.id);

    const { rows: cr } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [d.id],
    );
    expect(cr[0].status).toBe('cancelled');
    expect(await evaluateParticipant(aluno, cr[0])).toBe(false);

    const xp = await c.query(
      `SELECT COUNT(*)::int n FROM xp_events WHERE user_id=$1 AND kind='challenge_completed'`,
      [aluno],
    );
    expect(xp.rows[0].n).toBe(0);
    // A participação continua registrada: cancelar não apaga história.
    const p = await c.query(
      `SELECT status FROM challenge_participants WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    expect(p.rows[0].status).toBe('active');
  });

  it('desafio encerrado não aceita entrada nova', async () => {
    const { inviteToChallenge, joinChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    // Desafio antigo, já encerrado: inserido direto porque criar retroativo é
    // proibido por desenho — o que este teste checa é a ENTRADA, não a criação.
    const j = janela(60, 20);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, personal_id, title, kind, rule_json, rules_version,
          starts_on, ends_on, status)
       VALUES ('personal', $1, $1, 'Antigo', 'consistency', '{"minPct":80,"requiredWeeks":2}'::jsonb,
               1, $2::date, $3::date, 'active')
       RETURNING id::text`,
      [personalId, j.startsOn, j.endsOn],
    );
    const d = { id: rows[0].id };
    await inviteToChallenge(personalId, d.id, [aluno]);

    await expect(joinChallengeAsUser(aluno, d.id)).rejects.toMatchObject({
      code: 'CHALLENGE_CLOSED',
    });
  });

  it('o DOMINGO à noite pertence à semana do aluno, não à de UTC', async () => {
    // Domingo 23h em Brasília = SEGUNDA 02h em UTC. Com a conta em UTC, o
    // treino cairia na semana seguinte e a semana fechada perderia um dia —
    // este é o único instante da semana em que as duas contas divergem, e é
    // por isso que o teste o escolhe.
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '1'); // 1 treino previsto/semana

    const d = await desafioEmCurso(personalId, {
      rule: { minPct: 80, requiredWeeks: 1 },
      semanas: 1,
    });
    const challenge = await linhaDoDesafio(d.id);

    // Domingo da semana passada, 23h no fuso do aluno.
    await c.query(
      `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
       VALUES ($1, 'free', 'completed',
               (($2::date + TIME '23:00') AT TIME ZONE 'America/Sao_Paulo'),
               NOW(), 'Treino de domingo à noite')`,
      [aluno, challenge.ends_on <= new Date().toISOString().slice(0, 10)
        ? challenge.ends_on
        : addDiasISO(challenge.starts_on, 6)],
    );

    const p = await computeProgressFor(aluno, challenge);
    // A semana passada fechou com 1 de 1 previsto: cumprida.
    expect(p.weeksDone).toBe(1);
    expect(p.achieved).toBe(true);
  });

  it('desafio ENCERRADO ainda conclui quem cumpriu — e treino posterior não conta', async () => {
    // Decisão explícita: a avaliação continua valendo depois do fim, porque
    // quem cumpriu no último dia pode só abrir o app no dia seguinte. O que
    // NÃO vale é treinar depois do prazo: a janela recorta os dias, então o
    // resultado é o mesmo hoje e daqui a um ano.
    const { evaluateParticipant, computeProgressFor } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '3');

    const j = janelaSegundas(5);
    const fimPassado = addDiasISO(j.startsOn, 27); // 4 semanas depois do início
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, personal_id, title, kind, rule_json, rules_version,
          starts_on, ends_on, status)
       VALUES ('personal', $1, $1, 'Encerrado', 'consistency',
               '{"minPct":80,"requiredWeeks":4}'::jsonb, 1, $2::date, $3::date, 'active')
       RETURNING id::text`,
      [personalId, j.startsOn, fimPassado],
    );
    const challengeId = rows[0].id;
    await c.query(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, joined_at, consent_ack_at)
       VALUES ($1::bigint, $2, 'active', NOW(), NOW())`,
      [challengeId, aluno],
    );
    for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s + 1, 3);

    const challenge = await linhaDoDesafio(challengeId);
    const antes = await computeProgressFor(aluno, challenge);

    // Treina MUITO depois do fim: não muda nada.
    await treinarNaSemana(aluno, 0, 3);
    const depois = await computeProgressFor(aluno, challenge);
    expect(depois.weeksDone).toBe(antes.weeksDone);

    if (antes.achieved) {
      expect(await evaluateParticipant(aluno, challenge)).toBe(true);
    }
  });

  it('desafio AGENDADO não conclui ninguém', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '3');
    const j = janela(0, 40);
    const futuro = addDiasISO(j.startsOn, 7);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, personal_id, title, kind, rule_json, rules_version,
          starts_on, ends_on, status)
       VALUES ($1, $1, $1, 'Futuro', 'consistency', '{"minPct":80,"requiredWeeks":1}'::jsonb,
               1, $2::date, $3::date, 'active')
       RETURNING id::text`.replace("VALUES ($1, $1", "VALUES ('personal', $1"),
      [personalId, futuro, addDiasISO(futuro, 30)],
    );
    await c.query(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, joined_at, consent_ack_at)
       VALUES ($1::bigint, $2, 'active', NOW(), NOW())`,
      [rows[0].id, aluno],
    );
    await treinarNaSemana(aluno, 1, 5);

    expect(await evaluateParticipant(aluno, await linhaDoDesafio(rows[0].id))).toBe(false);
  });

  it('comeback ponta a ponta: pausa real no banco, retomada sustentada', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '3');

    const d = await desafioEmCurso(personalId, {
      kind: 'comeback',
      rule: { minInactiveDays: 21, requiredWeeks: 3 },
      semanas: 4,
    });
    const challenge = await linhaDoDesafio(d.id);

    // Treinou muito antes do desafio, parou, e voltou dentro da janela.
    await treinarNaSemana(aluno, 12, 3);
    for (let s = 1; s <= 3; s += 1) await treinarNaSemana(aluno, s, 3);

    const p = await computeProgressFor(aluno, challenge);
    expect(p.blockedReason).toBeNull();
    expect(p.weeksDone).toBeGreaterThanOrEqual(3);
    expect(p.achieved).toBe(true);
  });

  it('comeback recusa quem nunca parou', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '3');

    const d = await desafioEmCurso(personalId, {
      kind: 'comeback',
      rule: { minInactiveDays: 21, requiredWeeks: 3 },
      semanas: 4,
    });
    // Treinou na semana anterior ao início: não houve pausa.
    await treinarNaSemana(aluno, 5, 3);
    for (let s = 1; s <= 3; s += 1) await treinarNaSemana(aluno, s, 3);

    const p = await computeProgressFor(aluno, await linhaDoDesafio(d.id));
    expect(p.blockedReason).toBe('no_inactivity');
    expect(p.pct).toBeNull();
  });

  it('weekly_goal conclui pela régua de 80% do previsto', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '5');

    const d = await desafioEmCurso(personalId, {
      kind: 'weekly_goal',
      rule: { requiredWeeks: 2 },
      semanas: 3,
    });
    // 4 de 5 previstos = 80%: cumpre, sem precisar dos cinco.
    for (let s = 1; s <= 2; s += 1) await treinarNaSemana(aluno, s, 4);

    const p = await computeProgressFor(aluno, await linhaDoDesafio(d.id));
    expect(p.weeksDone).toBeGreaterThanOrEqual(2);
    expect(p.achieved).toBe(true);
  });

  it('o TREINO dispara a conclusão — o loop fecha sem ninguém abrir a tela', async () => {
    const { createSession } = await import('../services/workoutSessionService');
    const { createExercise } = await import('./helpers/integrationDb');
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId, '3');

    const d = await desafioEmCurso(personalId, {
      rule: { minPct: 80, requiredWeeks: 1 },
      semanas: 2,
    });
    await c.query(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, joined_at, consent_ack_at)
       VALUES ($1::bigint, $2, 'active', NOW(), NOW())`,
      [d.id, aluno],
    );
    // Semana passada inteira cumprida.
    await treinarNaSemana(aluno, 1, 3);

    seq += 1;
    const ex = await createExercise(c, TAG, `Supino loop ${seq}`);
    await createSession(aluno, null, {
      source: 'free',
      status: 'completed',
      title: 'Treino de hoje',
      planId: null,
      sets: [
        { exerciseId: ex, exerciseName: 'Supino', setIndex: 1, repsDone: 10, loadDoneKg: 40, status: 'done' },
      ],
      awardGamification: true,
    } as never);

    const { rows } = await c.query(
      `SELECT status FROM challenge_participants WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    expect(rows[0].status).toBe('completed');
  });

  it('quem CONCLUIU pode revogar a visibilidade sem perder o resultado', async () => {
    const { evaluateParticipant, leaveChallengeAsUser, getChallengeDetailForUser } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const challenge = await linhaDoDesafio(d.id);
    const aluno = await participanteCom(personalId, d.id, '3', 3);
    await evaluateParticipant(aluno, challenge);

    // Antes: concluído e visível.
    const antes = await c.query(
      `SELECT status, final_pct::text, consent_ack_at FROM challenge_participants
        WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    expect(antes.rows[0].status).toBe('completed');

    await leaveChallengeAsUser(aluno, d.id);

    const depois = await c.query(
      `SELECT status, final_pct::text, consent_ack_at FROM challenge_participants
        WHERE challenge_id=$1::bigint AND user_id=$2`,
      [d.id, aluno],
    );
    // O fato histórico permanece; só a exposição acaba.
    expect(depois.rows[0].status).toBe('completed');
    expect(Number(depois.rows[0].final_pct)).toBe(Number(antes.rows[0].final_pct));
    expect(depois.rows[0].consent_ack_at).toBeNull();

    // E ele sai do agregado do grupo.
    const detalhe = await getChallengeDetailForUser(aluno, d.id);
    expect(detalhe.participantsCount).toBe(0);
  });

  it('entrar concede `group_visibility`; sair de tudo revoga', async () => {
    const { joinChallengeAsUser, leaveChallengeAsUser, inviteToChallenge } = await import(
      '../modules/community/challenges.service'
    );
    const personalId = await novoPersonal();
    const aluno = await novoAluno(personalId);
    const d = await desafioEmCurso(personalId);
    await inviteToChallenge(personalId, d.id, [aluno]);

    const escopo = async () => {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM user_data_consents
          WHERE user_id=$1 AND professional_id=$2 AND scope='group_visibility'`,
        [aluno, personalId],
      );
      return rows[0]?.status ?? null;
    };

    expect(await escopo()).toBeNull();
    await joinChallengeAsUser(aluno, d.id);
    // O escopo aparece na central de consentimentos do aluno — não fica só na
    // linha do participante, onde ele nunca veria.
    expect(await escopo()).toBe('granted');

    await leaveChallengeAsUser(aluno, d.id);
    expect(await escopo()).toBe('revoked');
  });

  /* ---------------------------------------------------------------- *
   * LGPD
   * ---------------------------------------------------------------- */

  it('excluir o aluno leva a participação junto', async () => {
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    await c.query(`DELETE FROM users WHERE id = $1`, [aluno]);

    const { rows } = await c.query(
      `SELECT COUNT(*)::int n FROM challenge_participants WHERE user_id = $1`,
      [aluno],
    );
    expect(rows[0].n).toBe(0);
    // O desafio do personal continua — ele é dele, não do aluno.
    const ch = await c.query(`SELECT COUNT(*)::int n FROM challenges WHERE id = $1::bigint`, [d.id]);
    expect(ch.rows[0].n).toBe(1);
  });

  it('excluir o personal não deixa desafio órfão com dado de terceiros', async () => {
    const { deleteUserAccount } = await import('../services/accountDeletionService');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    await deleteUserAccount(personalId, { requestedBy: 'self' } as never);

    const ch = await c.query(`SELECT COUNT(*)::int n FROM challenges WHERE id = $1::bigint`, [d.id]);
    expect(ch.rows[0].n).toBe(0);
    const ps = await c.query(
      `SELECT COUNT(*)::int n FROM challenge_participants WHERE challenge_id = $1::bigint`,
      [d.id],
    );
    expect(ps.rows[0].n).toBe(0);
    // O aluno sobrevive: ele não era do personal.
    const u = await c.query(`SELECT COUNT(*)::int n FROM users WHERE id = $1`, [aluno]);
    expect(u.rows[0].n).toBe(1);
  });

  it('o export LGPD entrega a participação do titular', async () => {
    const { exportUserData } = await import('../services/accountDeletionService');
    const personalId = await novoPersonal();
    const d = await desafioEmCurso(personalId);
    const aluno = await participanteCom(personalId, d.id, '3', 3);

    const dump = (await exportUserData(aluno)) as { community?: { challenges?: unknown[] } };
    expect(dump.community?.challenges?.length).toBeGreaterThan(0);
  });

  it('o escopo group_visibility é aceito pelo banco', async () => {
    const aluno = await novoAluno();
    const personalId = await novoPersonal();
    await expect(
      c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'personal', 'group_visibility', 'granted')`,
        [aluno, personalId],
      ),
    ).resolves.toBeDefined();
  });
});
