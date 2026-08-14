/**
 * Desafios de academia (Spec 034, Onda C3).
 *
 * A invariante central desta onda é o ISOLAMENTO DE TENANT: academia A não
 * lista, edita, cancela, convida nem infere nada da academia B. Os testes
 * abaixo tentam cada uma dessas coisas de verdade.
 *
 * A segunda é a privacidade do agregado: a academia precisa saber se o desafio
 * está funcionando, não quanto o Everton fez.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  hasTestDb,
  finishSuite,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(240_000);

const TAG = 'itest-c3';

describeWithDb('Desafios de academia · o tenant é a fronteira', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await limpar();
    await restorePerformanceSchema(c);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
  });

  afterAll(async () => {
    // `finishSuite` libera o lock no `finally`: limpeza que falha não
    // pode reter o advisory lock e travar as suítes seguintes.
    await finishSuite(c, async () => {
      await limpar();
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  async function limpar() {
    await cleanFixtures(c, TAG);
    await c.query(`DELETE FROM academies WHERE slug LIKE $1`, [`${TAG}-%`]);
  }

  let seq = 0;

  /** Academia com o papel de aluno criado, como o produto real faz. */
  async function novaAcademia(): Promise<{ academyId: number; roleId: number }> {
    seq += 1;
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [`${TAG}-ac-${seq}`, `Academia ${seq} LTDA`, `Academia ${seq}`],
    );
    const academyId = rows[0].id;

    // Papéis pela função CANÔNICA do produto: um INSERT à mão erra o tipo de
    // `permissions` (jsonb) e não passa pelo gatilho de auditoria que a tabela
    // tem — o teste testaria um mundo que não existe.
    const { ensureAcademyRoles } = await import('../db/academyRoles');
    const papeis = await ensureAcademyRoles(c as never, academyId);

    return { academyId, roleId: papeis.academy_student };
  }

  async function alunoDaAcademia(
    ac: { academyId: number; roleId: number },
    weekPreset = '3',
  ): Promise<number> {
    seq += 1;
    const userId = await createUser(c, TAG, `aluno-${seq}`);
    await c.query(
      `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active)
       VALUES ($1, $2, $3, 'active', true)`,
      [userId, ac.academyId, ac.roleId],
    );
    // Frequência prevista: sem ela o progresso é `null` por desenho.
    await c.query(
      `INSERT INTO user_performance_goals
         (user_id, kind, target_value, unit, status, starts_on, metric_version)
       VALUES ($1, 'weekly_frequency', $2, 'sessions', 'active', CURRENT_DATE - 120, 1)`,
      [userId, Number(weekPreset)],
    );
    return userId;
  }

  function janelaSegundas(semanas: number) {
    const hoje = new Date();
    const dow = hoje.getUTCDay() === 0 ? 7 : hoje.getUTCDay();
    const segunda = new Date(hoje.getTime() - (dow - 1) * 86_400_000);
    return {
      startsOn: new Date(segunda.getTime() - semanas * 7 * 86_400_000).toISOString().slice(0, 10),
      endsOn: new Date(segunda.getTime() + 6 * 86_400_000).toISOString().slice(0, 10),
    };
  }

  /** Desafio institucional já em curso (criar retroativo é proibido). */
  async function desafioDaAcademia(
    academyId: number,
    dono: number,
    over: { kind?: string; rule?: Record<string, unknown>; semanas?: number } = {},
  ): Promise<string> {
    const j = janelaSegundas(over.semanas ?? 5);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, academy_id, title, description, kind,
          rule_json, rules_version, starts_on, ends_on, status)
       VALUES ('academy', $1, $2, 'Desafio da casa', 'Compromisso da academia', $3,
               $4::jsonb, 1, $5::date, $6::date, 'active')
       RETURNING id::text`,
      [
        dono,
        academyId,
        over.kind ?? 'consistency',
        JSON.stringify(over.rule ?? { minPct: 80, requiredWeeks: 4 }),
        j.startsOn,
        j.endsOn,
      ],
    );
    return rows[0].id;
  }

  /**
   * `dias` treinos DENTRO da semana ISO que começou `semanasAtras` semanas atrás.
   *
   * Ancorado na SEGUNDA-FEIRA daquela semana, não em "N dias atrás": contando
   * para trás, os mesmos offsets caem em semanas diferentes conforme o dia em
   * que o teste roda — o fixture passava na quinta e falhava na sexta. Um teste
   * que depende do calendário não mede o código, mede o dia.
   */
  async function treinarNaSemana(userId: number, semanasAtras: number, dias: number) {
    const hoje = new Date();
    const dow = hoje.getUTCDay() === 0 ? 7 : hoje.getUTCDay();
    const segundaDesta = new Date(hoje.getTime() - (dow - 1) * 86_400_000);
    const segundaAlvo = new Date(segundaDesta.getTime() - semanasAtras * 7 * 86_400_000);

    for (let d = 0; d < dias; d += 1) {
      const dia = new Date(segundaAlvo.getTime() + d * 86_400_000).toISOString().slice(0, 10);
      await c.query(
        `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
         VALUES ($1, 'free', 'completed',
                 (($2::date + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo'),
                 (($2::date + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo'), $3)`,
        [userId, dia, 'Treino fixture'],
      );
    }
  }

  async function participar(challengeId: string, userId: number) {
    await c.query(
      `INSERT INTO challenge_participants (challenge_id, user_id, status, joined_at, consent_ack_at)
       VALUES ($1::bigint, $2, 'active', NOW(), NOW())`,
      [challengeId, userId],
    );
  }

  /** Linha crua do desafio, como os avaliadores a recebem. */
  async function linhaDoDesafioAcademia(id: string) {
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
   * Criação e ownership
   * ---------------------------------------------------------------- */

  it('a academia cria desafio institucional, com o tenant como dono', async () => {
    const { createAcademyChallenge } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const j = janelaSegundas(0);

    const d = (await createAcademyChallenge(ac.academyId, gestor, {
      title: 'Agosto firme',
      description: 'Desafio da casa',
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      startsOn: j.startsOn,
      endsOn: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10),
    } as never)) as { id: string; scope: string };

    const { rows } = await c.query(
      `SELECT scope, academy_id, personal_id, created_by_user_id, rule_json
         FROM challenges WHERE id = $1::bigint`,
      [d.id],
    );
    expect(rows[0].scope).toBe('academy');
    expect(rows[0].academy_id).toBe(ac.academyId);
    // Institucional NÃO depende de personal.
    expect(rows[0].personal_id).toBeNull();
    expect(rows[0].created_by_user_id).toBe(gestor);
  });

  it('o `academy_id` do CORPO não altera ownership', async () => {
    // O tenant vem do contexto autenticado; o corpo é dado, não autorização.
    const { createAcademyChallenge } = await import('../modules/community/challenges.service');
    const a = await novaAcademia();
    const b = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const j = janelaSegundas(0);

    const d = (await createAcademyChallenge(a.academyId, gestor, {
      title: 'Spoof',
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 1 },
      startsOn: j.startsOn,
      endsOn: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
      // Campos abaixo são ruído: não existem no contrato e não são lidos.
      academyId: b.academyId,
      academy_id: b.academyId,
      scope: 'personal',
    } as never)) as { id: string };

    const { rows } = await c.query(
      `SELECT academy_id, scope FROM challenges WHERE id = $1::bigint`,
      [d.id],
    );
    expect(rows[0].academy_id).toBe(a.academyId);
    expect(rows[0].scope).toBe('academy');
  });

  /* ---------------------------------------------------------------- *
   * Isolamento de tenant
   * ---------------------------------------------------------------- */

  it('academia B não vê, não cancela e não convida no desafio de A', async () => {
    const {
      getAcademyChallengePanel,
      cancelAcademyChallengeAsTenant,
      inviteToAcademyChallenge,
      listChallengesForAcademyPanel,
    } = await import('../modules/community/challenges.service');

    const a = await novaAcademia();
    const b = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(a.academyId, gestor);

    await expect(getAcademyChallengePanel(b.academyId, desafio)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(cancelAcademyChallengeAsTenant(b.academyId, desafio)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(inviteToAcademyChallenge(b.academyId, desafio)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // E o desafio de A não aparece na lista de B.
    const listaB = await listChallengesForAcademyPanel(b.academyId);
    expect(listaB.map((x) => x.id)).not.toContain(desafio);
  });

  it('convite não alcança aluno de OUTRA academia — nem revela que ele existe', async () => {
    const { inviteToAcademyChallenge } = await import('../modules/community/challenges.service');
    const a = await novaAcademia();
    const b = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);

    const meuAluno = await alunoDaAcademia(a);
    const alunoDeB = await alunoDaAcademia(b);
    const desafio = await desafioDaAcademia(a.academyId, gestor);

    const r = await inviteToAcademyChallenge(a.academyId, desafio, [meuAluno, alunoDeB, 999_999]);
    expect(r.invited).toBe(1);
    expect(r.rejected).toBe(2);

    const { rows } = await c.query(
      `SELECT user_id FROM challenge_participants WHERE challenge_id = $1::bigint`,
      [desafio],
    );
    expect(rows.map((x) => x.user_id)).toEqual([meuAluno]);
  });

  it('aluno de outra academia não entra pelo ID manual', async () => {
    const { joinChallengeAsUser, getChallengeDetailForUser } = await import(
      '../modules/community/challenges.service'
    );
    const a = await novaAcademia();
    const b = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const alunoDeB = await alunoDaAcademia(b);
    const desafio = await desafioDaAcademia(a.academyId, gestor);

    // Sem convite não há participação — e sem participação o desafio não
    // existe para ele.
    await expect(joinChallengeAsUser(alunoDeB, desafio)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getChallengeDetailForUser(alunoDeB, desafio)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('aluno desativado na academia deixa de ser elegível', async () => {
    const { inviteToAcademyChallenge } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac);
    await c.query(`UPDATE academy_users SET is_active = false WHERE user_id = $1`, [aluno]);

    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const r = await inviteToAcademyChallenge(ac.academyId, desafio);
    expect(r.invited).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Convite institucional
   * ---------------------------------------------------------------- */

  it('convite em massa resolve os elegíveis NO SERVIDOR', async () => {
    const { inviteToAcademyChallenge } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const alunos = [await alunoDaAcademia(ac), await alunoDaAcademia(ac), await alunoDaAcademia(ac)];
    const desafio = await desafioDaAcademia(ac.academyId, gestor);

    // Sem `studentIds`: a lista nasce no backend.
    const r = await inviteToAcademyChallenge(ac.academyId, desafio);
    expect(r.invited).toBe(3);

    const { rows } = await c.query(
      `SELECT user_id, status FROM challenge_participants WHERE challenge_id = $1::bigint`,
      [desafio],
    );
    expect(rows.map((x) => x.user_id).sort()).toEqual([...alunos].sort());
    // Convite NÃO é adesão, nem no institucional.
    expect(rows.every((x) => x.status === 'invited')).toBe(true);
  });

  it('a adesão continua explícita e registra consentimento', async () => {
    const { inviteToAcademyChallenge, joinChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    await inviteToAcademyChallenge(ac.academyId, desafio);

    await joinChallengeAsUser(aluno, desafio);

    const { rows } = await c.query(
      `SELECT status, consent_ack_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [desafio, aluno],
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].consent_ack_at).not.toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Painel agregado
   * ---------------------------------------------------------------- */

  async function desafioComParticipantes(n: number, diasPorSemana = 3) {
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const alunos: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const aluno = await alunoDaAcademia(ac);
      await participar(desafio, aluno);
      for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, diasPorSemana);
      alunos.push(aluno);
    }
    return { ac, gestor, desafio, alunos };
  }

  it('o painel mostra engajamento e NUNCA nome ou percentual individual', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const { ac, desafio } = await desafioComParticipantes(6);

    const painel = await getAcademyChallengePanel(ac.academyId, desafio);
    const serializado = JSON.stringify(painel);

    expect(painel.engagement.active).toBe(6);
    expect(painel.engagement.completed).not.toBeNull();
    expect(painel.bands).not.toBeNull();
    expect(painel.averageProgressPct).not.toBeNull();

    // Nenhum indivíduo na resposta: sem lista, sem nome, sem id de usuário.
    expect(serializado).not.toMatch(/"userId"/);
    expect(serializado).not.toMatch(/"name"/);
    expect(serializado).not.toMatch(/"participants"\s*:\s*\[/);
  });

  it('abaixo de 5 participantes, TODO agregado inferível some', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');

    for (const n of [1, 2, 3, 4]) {
      const { ac, desafio } = await desafioComParticipantes(n);
      const painel = await getAcademyChallengePanel(ac.academyId, desafio);

      expect(painel.bands).toBeNull();
      // A média também identifica: com dois participantes ela é praticamente
      // o número de cada um.
      expect(painel.averageProgressPct).toBeNull();
      expect(painel.adherenceTrend.duringPct).toBeNull();
      // E as contagens de RESULTADO idem: com um participante, "1 concluiu"
      // diz que AQUELA pessoa cumpriu o critério — e repetindo o desafio com
      // limiares diferentes dá para buscar a aderência exata de alguém.
      expect(painel.engagement.completed).toBeNull();
      expect(painel.engagement.left).toBeNull();
      expect(painel.engagement.completionRate).toBeNull();
      // As contagens de CONVITE ficam: descrevem adesão, não saúde.
      expect(painel.engagement.active).toBe(n);
      expect(painel.engagement.joined).toBe(n);
    }
  });

  it('com 5, os agregados aparecem — o limiar é exatamente esse', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const { ac, desafio } = await desafioComParticipantes(5);
    const painel = await getAcademyChallengePanel(ac.academyId, desafio);

    expect(painel.bands).not.toBeNull();
    expect(painel.averageProgressPct).not.toBeNull();
  });

  it('a turma institucional NÃO relaxa o limiar', async () => {
    // Regra explícita da spec: uma unidade com quatro alunos ativos é tão
    // identificável quanto a turma de um personal com quatro.
    const { MIN_PARTICIPANTS_FOR_BANDS, canPublishAggregate } = await import(
      '../modules/community/challenges.engine'
    );
    expect(MIN_PARTICIPANTS_FOR_BANDS).toBe(5);
    expect(canPublishAggregate(4)).toBe(false);
    expect(canPublishAggregate(5)).toBe(true);
  });

  it('o KPI compara o GRUPO consigo mesmo — antes × durante', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor, { semanas: 4 });

    // Cinco alunos que treinavam pouco antes e muito durante.
    for (let i = 0; i < 5; i += 1) {
      const aluno = await alunoDaAcademia(ac);
      await participar(desafio, aluno);
      for (let s = 5; s <= 8; s += 1) await treinarNaSemana(aluno, s, 1); // antes
      for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3); // durante
    }

    const painel = await getAcademyChallengePanel(ac.academyId, desafio);
    expect(painel.adherenceTrend.beforePct).not.toBeNull();
    expect(painel.adherenceTrend.duringPct).not.toBeNull();
    // Melhorou: é a única pergunta que o KPI institucional precisa responder.
    expect(painel.adherenceTrend.deltaPct!).toBeGreaterThan(0);
  });

  it('desafio de RETOMADA não mostra a turma inteira como "sem atividade"', async () => {
    // O painel calcula progresso em lote; sem a pausa de cada participante o
    // engine devolve `null` para todos, e um desafio de retomada exibiria a
    // academia inteira zerada. Painel que mede errado é pior que painel
    // ausente.
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor, {
      kind: 'comeback',
      rule: { minInactiveDays: 21, requiredWeeks: 3 },
      semanas: 4,
    });

    for (let i = 0; i < 5; i += 1) {
      const aluno = await alunoDaAcademia(ac, '3');
      await participar(desafio, aluno);
      await treinarNaSemana(aluno, 12, 3); // treinou, parou
      for (let s = 1; s <= 3; s += 1) await treinarNaSemana(aluno, s, 3); // voltou
    }

    const painel = await getAcademyChallengePanel(ac.academyId, desafio);
    expect(painel.averageProgressPct).not.toBeNull();
    expect(painel.averageProgressPct!).toBeGreaterThan(0);
    expect(painel.bands!.find((b) => b.band === 'completed')!.count).toBeGreaterThan(0);
  });

  it('quem CONCLUIU entra no painel com o percentual congelado', async () => {
    const { getAcademyChallengePanel, evaluateParticipant } = await import(
      '../modules/community/challenges.service'
    );
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const challenge = await linhaDoDesafioAcademia(desafio);

    for (let i = 0; i < 5; i += 1) {
      const aluno = await alunoDaAcademia(ac, '3');
      await participar(desafio, aluno);
      for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3);
      if (i === 0) await evaluateParticipant(aluno, challenge);
    }

    const painel = await getAcademyChallengePanel(ac.academyId, desafio);
    expect(painel.engagement.completed).toBe(1);
    // O concluído é lido de `final_pct`, não recalculado.
    expect(painel.bands!.find((b) => b.band === 'completed')!.count).toBeGreaterThanOrEqual(1);
  });

  it('aluno desligado da academia para de alimentar o painel', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);

    const alunos: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const aluno = await alunoDaAcademia(ac, '3');
      await participar(desafio, aluno);
      for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3);
      alunos.push(aluno);
    }
    expect((await getAcademyChallengePanel(ac.academyId, desafio)).engagement.active).toBe(6);

    // Desligado da academia: o acesso ao dado dele acaba na hora, não quando o
    // desafio terminar.
    await c.query(`UPDATE academy_users SET is_active = false WHERE user_id = $1`, [alunos[0]]);

    const depois = await getAcademyChallengePanel(ac.academyId, desafio);
    expect(depois.engagement.active).toBe(5);
  });

  it('convite em massa NÃO reconvida quem já saiu', async () => {
    const { inviteToAcademyChallenge, joinChallengeAsUser, leaveChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const aluno = await alunoDaAcademia(ac);

    await inviteToAcademyChallenge(ac.academyId, desafio);
    await joinChallengeAsUser(aluno, desafio);
    await leaveChallengeAsUser(aluno, desafio);

    // Segundo convite em massa: insistir sobre uma recusa explícita é o que o
    // tom do produto proíbe.
    await inviteToAcademyChallenge(ac.academyId, desafio);

    const { rows } = await c.query<{ status: string }>(
      `SELECT status FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [desafio, aluno],
    );
    expect(rows[0].status).toBe('left');
  });

  /* ---------------------------------------------------------------- *
   * Progresso, XP e marcos — herdados, não reescritos
   * ---------------------------------------------------------------- */

  it('progresso continua RELATIVO ao próprio plano no escopo academia', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);

    const alunoA = await alunoDaAcademia(ac, '5'); // plano 5x, faz 4 → 80%
    const alunoB = await alunoDaAcademia(ac, '3'); // plano 3x, faz 3 → 100%
    await participar(desafio, alunoA);
    await participar(desafio, alunoB);
    for (let s = 1; s <= 4; s += 1) {
      await treinarNaSemana(alunoA, s, 4);
      await treinarNaSemana(alunoB, s, 3);
    }

    const { rows } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    const pA = await computeProgressFor(alunoA, rows[0]);
    const pB = await computeProgressFor(alunoB, rows[0]);

    // B treinou MENOS vezes e cumpre mais.
    expect(pB.pct!).toBeGreaterThanOrEqual(pA.pct!);
    expect(pB.achieved).toBe(true);
  });

  it('conclusão institucional paga 50 XP e desbloqueia o MESMO marco', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const aluno = await alunoDaAcademia(ac, '3');
    await participar(desafio, aluno);
    for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3);

    const { rows: cr } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    expect(await evaluateParticipant(aluno, cr[0])).toBe(true);
    // Reprocessar não repete nada.
    for (let i = 0; i < 5; i += 1) await evaluateParticipant(aluno, cr[0]);

    const xp = await c.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::int total
         FROM xp_events WHERE user_id = $1 AND kind = 'challenge_completed'`,
      [aluno],
    );
    expect(xp.rows[0]).toMatchObject({ n: 1, total: 50 });

    // UM marco, não dois: `challenge_completed` não distingue escopo.
    const marcos = await c.query(
      `SELECT COUNT(*)::int n FROM user_milestones
        WHERE user_id = $1 AND code = 'challenge_completed'`,
      [aluno],
    );
    expect(marcos.rows[0].n).toBe(1);
  });

  it('participar de desafio do personal E da academia não duplica sessão nem XP de sessão', async () => {
    const { evaluateParticipant } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac, '3');

    // Desafio institucional + desafio de um personal, mesmo aluno.
    const doInstituto = await desafioDaAcademia(ac.academyId, gestor);
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    await c.query(`UPDATE users SET role = 'personal' WHERE id = $1`, [personalId]);
    const j = janelaSegundas(5);
    const { rows: dp } = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, personal_id, title, kind, rule_json, rules_version,
          starts_on, ends_on, status)
       VALUES ('personal', $1, $1, 'Do personal', 'consistency',
               '{"minPct":80,"requiredWeeks":4}'::jsonb, 1, $2::date, $3::date, 'active')
       RETURNING id::text`,
      [personalId, j.startsOn, j.endsOn],
    );
    await participar(doInstituto, aluno);
    await participar(dp[0].id, aluno);
    for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3);

    const linha = async (id: string) =>
      (
        await c.query(
          `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
                  to_char(ends_on,'YYYY-MM-DD') ends_on, status
             FROM challenges WHERE id = $1::bigint`,
          [id],
        )
      ).rows[0];

    expect(await evaluateParticipant(aluno, await linha(doInstituto))).toBe(true);
    expect(await evaluateParticipant(aluno, await linha(dp[0].id))).toBe(true);

    // As DUAS conclusões acontecem — o desafio é o fato, e cada um tem o seu.
    const concluidos = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenge_participants
        WHERE user_id = $1 AND status = 'completed'`,
      [aluno],
    );
    expect(concluidos.rows[0].n).toBe(2);

    // O XP respeita o teto diário da C0: 50 + 50 não cabem em 60, e
    // `challenge_completed` é tudo-ou-nada. Hoje paga um.
    const hoje = await c.query<{ n: number; total: number }>(
      `SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::int total FROM xp_events
        WHERE user_id = $1 AND kind = 'challenge_completed'`,
      [aluno],
    );
    expect(hoje.rows[0].n).toBe(1);
    expect(hoje.rows[0].total).toBe(50);

    // E o segundo NÃO se perde: liberado o teto, a repescagem paga. Sem isso,
    // 50 XP sumiriam em silêncio sempre que dois desafios terminassem juntos.
    await c.query(`DELETE FROM xp_events WHERE user_id = $1`, [aluno]);
    await evaluateParticipant(aluno, await linha(doInstituto));

    const depois = await c.query<{ event_key: string }>(
      `SELECT event_key FROM xp_events
        WHERE user_id = $1 AND kind = 'challenge_completed' ORDER BY event_key`,
      [aluno],
    );
    expect(new Set(depois.rows.map((r) => r.event_key)).size).toBe(1);

    // E o XP de SESSÃO continua com um crédito por dia, como a C0 fixou.
    const sessoes = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM xp_events
        WHERE user_id = $1 AND kind = 'workout_session'
        GROUP BY awarded_on HAVING COUNT(*) > 1`,
      [aluno],
    );
    expect(sessoes.rows).toHaveLength(0);

    // Um marco só, mesmo com dois desafios concluídos.
    const marcos = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM user_milestones
        WHERE user_id = $1 AND code = 'challenge_completed'`,
      [aluno],
    );
    expect(marcos.rows[0].n).toBe(1);
  });

  it('cancelar não conclui, não paga XP e não concede marco', async () => {
    const { cancelAcademyChallengeAsTenant, evaluateParticipant } = await import(
      '../modules/community/challenges.service'
    );
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const aluno = await alunoDaAcademia(ac, '3');
    await participar(desafio, aluno);
    for (let s = 1; s <= 4; s += 1) await treinarNaSemana(aluno, s, 3);

    await cancelAcademyChallengeAsTenant(ac.academyId, desafio);

    const { rows: cr } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    expect(cr[0].status).toBe('cancelled');
    expect(await evaluateParticipant(aluno, cr[0])).toBe(false);

    const xp = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM xp_events WHERE user_id=$1 AND kind='challenge_completed'`,
      [aluno],
    );
    expect(xp.rows[0].n).toBe(0);
  });

  it('weekly_goal institucional usa a mesma régua de 80%', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac, '5');
    const desafio = await desafioDaAcademia(ac.academyId, gestor, {
      kind: 'weekly_goal',
      rule: { requiredWeeks: 2 },
      semanas: 3,
    });
    await participar(desafio, aluno);
    // 4 de 5 previstos = 80%: cumpre sem precisar dos cinco.
    for (let s = 1; s <= 2; s += 1) await treinarNaSemana(aluno, s, 4);

    const { rows } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    const p = await computeProgressFor(aluno, rows[0]);
    expect(p.weeksDone).toBeGreaterThanOrEqual(2);
    expect(p.achieved).toBe(true);
  });

  it('comeback institucional exige pausa real e retomada sustentada', async () => {
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor, {
      kind: 'comeback',
      rule: { minInactiveDays: 21, requiredWeeks: 3 },
      semanas: 4,
    });

    const quemParou = await alunoDaAcademia(ac, '3');
    const quemNuncaParou = await alunoDaAcademia(ac, '3');
    await participar(desafio, quemParou);
    await participar(desafio, quemNuncaParou);

    await treinarNaSemana(quemParou, 12, 3); // muito antes; depois parou
    await treinarNaSemana(quemNuncaParou, 5, 3); // treinou às vésperas
    for (let s = 1; s <= 3; s += 1) {
      await treinarNaSemana(quemParou, s, 3);
      await treinarNaSemana(quemNuncaParou, s, 3);
    }

    const { rows } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    const pA = await computeProgressFor(quemParou, rows[0]);
    const pB = await computeProgressFor(quemNuncaParou, rows[0]);

    expect(pA.achieved).toBe(true);
    // Quem nunca parou não tem o que retomar.
    expect(pB.blockedReason).toBe('no_inactivity');
  });

  it('sair de desafio institucional revoga a visibilidade na hora', async () => {
    const { inviteToAcademyChallenge, joinChallengeAsUser, leaveChallengeAsUser } = await import(
      '../modules/community/challenges.service'
    );
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    await inviteToAcademyChallenge(ac.academyId, desafio);
    await joinChallengeAsUser(aluno, desafio);

    await leaveChallengeAsUser(aluno, desafio);

    const { rows } = await c.query(
      `SELECT status, left_at, consent_ack_at FROM challenge_participants
        WHERE challenge_id = $1::bigint AND user_id = $2`,
      [desafio, aluno],
    );
    expect(rows[0].status).toBe('left');
    expect(rows[0].consent_ack_at).toBeNull();
    expect(rows[0].left_at).not.toBeNull();
  });

  it('a última semana do desafio respeita o DIA DO ALUNO', async () => {
    // Domingo 23h em Brasília = segunda 02h em UTC. Com a conta em UTC, o
    // treino cairia fora da janela e a semana final perderia um dia.
    const { computeProgressFor } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac, '1');
    const desafio = await desafioDaAcademia(ac.academyId, gestor, {
      rule: { minPct: 80, requiredWeeks: 1 },
      semanas: 1,
    });

    const { rows: cr } = await c.query(
      `SELECT id::text, kind, rule_json, to_char(starts_on,'YYYY-MM-DD') starts_on,
              to_char(ends_on,'YYYY-MM-DD') ends_on, status
         FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    await participar(desafio, aluno);

    // Domingo da semana passada às 23h, no fuso do aluno.
    const domingoPassado = new Date(
      new Date(`${cr[0].starts_on}T12:00:00Z`).getTime() + 6 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    await c.query(
      `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
       VALUES ($1, 'free', 'completed',
               (($2::date + TIME '23:00') AT TIME ZONE 'America/Sao_Paulo'), NOW(), 'Domingo tarde')`,
      [aluno, domingoPassado],
    );

    const p = await computeProgressFor(aluno, cr[0]);
    expect(p.weeksDone).toBe(1);
    expect(p.achieved).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * Fonte única para o aluno
   * ---------------------------------------------------------------- */

  it('o aluno vê os dois escopos na MESMA lista, com a origem visível', async () => {
    const { listMyChallenges } = await import('../modules/community/challenges.service');
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const aluno = await alunoDaAcademia(ac);

    const daAcademia = await desafioDaAcademia(ac.academyId, gestor);
    await participar(daAcademia, aluno);

    const lista = (await listMyChallenges(aluno)) as Array<{
      id: string;
      scope: string;
      invitedByName: string | null;
    }>;
    const inst = lista.find((x) => x.id === daAcademia)!;
    expect(inst.scope).toBe('academy');
    // A origem é o nome da academia — o aluno sabe de onde veio.
    expect(inst.invitedByName).toMatch(/Academia/);
  });

  /* ---------------------------------------------------------------- *
   * LGPD
   * ---------------------------------------------------------------- */

  it('excluir o aluno leva a participação institucional junto', async () => {
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const aluno = await alunoDaAcademia(ac);
    await participar(desafio, aluno);

    await c.query(`DELETE FROM users WHERE id = $1`, [aluno]);

    const { rows } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenge_participants WHERE user_id = $1`,
      [aluno],
    );
    expect(rows[0].n).toBe(0);
    // O desafio da academia continua: ele é do tenant, não do aluno.
    const ch = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    expect(ch.rows[0].n).toBe(1);
  });

  it('academia removida não deixa desafio institucional órfão', async () => {
    const ac = await novaAcademia();
    const gestor = await createUser(c, TAG, `gestor-${(seq += 1)}`);
    const desafio = await desafioDaAcademia(ac.academyId, gestor);
    const aluno = await alunoDaAcademia(ac);
    await participar(desafio, aluno);

    // Precedente do projeto: entidade operacional não sobrevive ao dono.
    const { deleteAcademyChallenges } = await import('../modules/community/challenges.repository');
    await deleteAcademyChallenges(ac.academyId);

    const ch = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenges WHERE id = $1::bigint`,
      [desafio],
    );
    expect(ch.rows[0].n).toBe(0);
    const ps = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenge_participants WHERE challenge_id = $1::bigint`,
      [desafio],
    );
    expect(ps.rows[0].n).toBe(0);
  });
});
