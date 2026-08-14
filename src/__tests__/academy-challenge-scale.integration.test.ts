/**
 * Escala do painel institucional (Spec 034, Onda C3).
 *
 * O painel da academia é a primeira superfície da spec que pode ter centenas
 * de participantes. O objetivo aqui não é benchmark de laboratório: é detectar
 * algoritmo O(N) em número de CONSULTAS — o defeito que já apareceu duas vezes
 * neste módulo (242 idas ao banco no painel do personal, 223 no detalhe do
 * aluno) e que, contra um pool de 20 conexões, não é lentidão: é
 * indisponibilidade.
 *
 * A contagem de queries é feita por instrumentação real do `pool.query`, não
 * por inspeção de código.
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
jest.setTimeout(300_000);

const TAG = 'itest-c3scale';
const PARTICIPANTES = 100;

describeWithDb('Painel institucional · 100 participantes', () => {
  let c: Client;
  let academyId: number;
  let challengeId: string;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await limpar();
    await restorePerformanceSchema(c);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
    await montarFixture();
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

  /** 1 academia, 1 desafio, 100 alunos com 4 semanas de histórico. */
  async function montarFixture() {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ($1, 'Escala LTDA', 'Academia da Escala', 'active') RETURNING id`,
      [`${TAG}-ac`],
    );
    academyId = rows[0].id;

    const { ensureAcademyRoles } = await import('../db/academyRoles');
    const papeis = await ensureAcademyRoles(c as never, academyId);

    const gestor = await createUser(c, TAG, 'gestor');
    const hoje = new Date();
    const dow = hoje.getUTCDay() === 0 ? 7 : hoje.getUTCDay();
    const segunda = new Date(hoje.getTime() - (dow - 1) * 86_400_000);
    const startsOn = new Date(segunda.getTime() - 5 * 7 * 86_400_000).toISOString().slice(0, 10);
    const endsOn = new Date(segunda.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);

    const ch = await c.query<{ id: string }>(
      `INSERT INTO challenges
         (scope, created_by_user_id, academy_id, title, kind, rule_json, rules_version,
          starts_on, ends_on, status)
       VALUES ('academy', $1, $2, 'Desafio de escala', 'consistency',
               '{"minPct":80,"requiredWeeks":4}'::jsonb, 1, $3::date, $4::date, 'active')
       RETURNING id::text`,
      [gestor, academyId, startsOn, endsOn],
    );
    challengeId = ch.rows[0].id;

    // Inserções em lote: montar 100 alunos com histórico linha a linha levaria
    // minutos e não é o que o teste mede.
    for (let i = 0; i < PARTICIPANTES; i += 1) {
      const userId = await createUser(c, TAG, `aluno-${i}`);
      await c.query(
        `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active)
         VALUES ($1, $2, $3, 'active', true)`,
        [userId, academyId, papeis.academy_student],
      );
      await c.query(
        `INSERT INTO user_performance_goals
           (user_id, kind, target_value, unit, status, starts_on, metric_version)
         VALUES ($1, 'weekly_frequency', 3, 'sessions', 'active', CURRENT_DATE - 120, 1)`,
        [userId],
      );
      await c.query(
        `INSERT INTO challenge_participants (challenge_id, user_id, status, joined_at, consent_ack_at)
         VALUES ($1::bigint, $2, 'active', NOW(), NOW())`,
        [challengeId, userId],
      );
      // 4 semanas × 3 treinos, numa inserção só por aluno.
      await c.query(
        `INSERT INTO workout_sessions (user_id, source, status, performed_at, started_at, title)
         SELECT $1, 'free', 'completed', NOW() - (d || ' days')::interval,
                NOW() - (d || ' days')::interval, 'Treino escala'
           FROM unnest($2::int[]) AS d`,
        [userId, [7, 5, 3, 14, 12, 10, 21, 19, 17, 28, 26, 24]],
      );
    }
  }

  /** Conta as consultas de uma operação, instrumentando o pool de verdade. */
  async function contarQueries<T>(fn: () => Promise<T>): Promise<{ resultado: T; queries: number }> {
    const pool = (await import('../config/database')).default;
    const original = pool.query.bind(pool);
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      n += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any)(...args);
    };
    try {
      const resultado = await fn();
      return { resultado, queries: n };
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = original;
    }
  }

  it('o painel de 100 participantes NÃO faz uma consulta por pessoa', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');

    const inicio = Date.now();
    const { resultado, queries } = await contarQueries(() =>
      getAcademyChallengePanel(academyId, challengeId),
    );
    const ms = Date.now() - inicio;

    // eslint-disable-next-line no-console
    console.log(`[escala] painel com ${PARTICIPANTES} participantes: ${queries} queries, ${ms}ms`);

    expect(resultado.engagement.active).toBe(PARTICIPANTES);
    expect(resultado.bands).not.toBeNull();

    // O teto é generoso de propósito: o que este teste detecta é O(N), não a
    // diferença entre 8 e 12 consultas. Com um laço por participante seriam
    // mais de 200.
    expect(queries).toBeLessThan(20);
    expect(ms).toBeLessThan(10_000);
  });

  it('a lista de desafios da academia também é O(1) em consultas', async () => {
    const { listChallengesForAcademyPanel } = await import(
      '../modules/community/challenges.service'
    );
    const { resultado, queries } = await contarQueries(() =>
      listChallengesForAcademyPanel(academyId),
    );

    // eslint-disable-next-line no-console
    console.log(`[escala] lista de desafios: ${queries} queries`);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].counts.active).toBe(PARTICIPANTES);
    // Uma para os desafios, uma para os contadores agregados.
    expect(queries).toBeLessThanOrEqual(4);
  });

  it('convidar 100 elegíveis é uma consulta de leitura e uma de escrita', async () => {
    const { inviteToAcademyChallenge } = await import('../modules/community/challenges.service');
    const { queries } = await contarQueries(() =>
      inviteToAcademyChallenge(academyId, challengeId),
    );

    // eslint-disable-next-line no-console
    console.log(`[escala] convite em massa de ${PARTICIPANTES}: ${queries} queries`);
    // Sem laço de validação por aluno: os elegíveis saem de UMA query e o
    // INSERT é em lote (`unnest`).
    expect(queries).toBeLessThanOrEqual(5);
  });

  it('o pool fica limpo depois do painel — nenhuma conexão vazada', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const { poolStats } = await import('../config/database');

    await getAcademyChallengePanel(academyId, challengeId);

    const stats = poolStats();
    expect(stats.waiting).toBe(0);
    expect(stats.total - stats.idle).toBe(0);
  });

  it('três painéis simultâneos não saturam o pool', async () => {
    const { getAcademyChallengePanel } = await import('../modules/community/challenges.service');
    const { poolStats } = await import('../config/database');

    const inicio = Date.now();
    await Promise.all([
      getAcademyChallengePanel(academyId, challengeId),
      getAcademyChallengePanel(academyId, challengeId),
      getAcademyChallengePanel(academyId, challengeId),
    ]);
    const ms = Date.now() - inicio;

    // eslint-disable-next-line no-console
    console.log(`[escala] 3 painéis simultâneos: ${ms}ms`);
    expect(ms).toBeLessThan(15_000);

    const stats = poolStats();
    expect(stats.waiting).toBe(0);
    expect(stats.total - stats.idle).toBe(0);
  });
});
