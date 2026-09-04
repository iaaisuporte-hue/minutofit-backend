/**
 * P0.1 — a condição do dia respondida pelo aluno tem de sobreviver ao aparelho.
 *
 * O check-in de bem-estar vivia só em `localStorage`: qualquer contexto sem
 * aquele storage (outro aparelho, reinstalação, dados do app limpos, aba
 * anônima) reabria a mesma pergunta no mesmo dia. A resposta passa a vir do
 * servidor, e é isto que estes testes travam — com banco real, porque o que
 * está em jogo é o que ficou GRAVADO, não o que a tela lembrou.
 *
 * O ponto sutil: `todayCheckedIn` já existia, mas é fonte-agnóstico — fica
 * `true` só por ter treinado. Usá-lo daria a resposta errada nos dois sentidos.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(120_000);

const TAG = 'itest-dailycond';

describeWithDb('Condição do dia · o servidor é a fonte da verdade', () => {
  let c: Client;
  let resumo: typeof import('../services/gamificationService').getGamificationSummary;
  let diaDoAluno: typeof import('../utils/appDay').dayKey;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    resumo = (await import('../services/gamificationService')).getGamificationSummary;
    diaDoAluno = (await import('../utils/appDay')).dayKey;
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;
  async function novoAluno(): Promise<number> {
    seq += 1;
    return createUser(c, TAG, `aluno-${seq}`);
  }

  async function gravarCheckin(
    userId: number,
    campos: Record<string, unknown>,
    dia = diaDoAluno(),
  ): Promise<void> {
    const cols = ['user_id', 'date_key', ...Object.keys(campos)];
    const vals = [userId, dia, ...Object.values(campos)];
    await c.query(
      `INSERT INTO user_daily_checkins (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
  }

  it('devolve a condição respondida hoje, com os detalhes', async () => {
    const aluno = await novoAluno();
    await gravarCheckin(aluno, {
      source: 'wellbeing',
      feeling: 'tired',
      slept_well: false,
      in_pain: true,
      stressed: false,
    });

    const r = await resumo(aluno);
    expect(r.todayCondition).toEqual({
      date: diaDoAluno(),
      feeling: 'tired',
      details: { sleptWell: false, inPain: true, stressed: false },
    });
  });

  it('traduz `neutral` do banco para `normal`, que é o vocabulário do app', async () => {
    const aluno = await novoAluno();
    await gravarCheckin(aluno, { source: 'wellbeing', feeling: 'neutral' });
    expect((await resumo(aluno)).todayCondition).toMatchObject({ feeling: 'normal' });
  });

  it('treinar NÃO conta como ter respondido como você está', async () => {
    // Este é o defeito que `todayCheckedIn` teria introduzido: a linha do dia
    // existe (o treino a criou), mas ninguém respondeu o questionário.
    const aluno = await novoAluno();
    await gravarCheckin(aluno, { source: 'workout' });

    const r = await resumo(aluno);
    expect(r.todayCheckedIn).toBe(true);
    expect(r.todayCondition).toBeNull();
  });

  it('a resposta de ontem não responde por hoje', async () => {
    const aluno = await novoAluno();
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    await gravarCheckin(aluno, { source: 'wellbeing', feeling: 'energized' }, diaDoAluno(ontem));
    expect((await resumo(aluno)).todayCondition).toBeNull();
  });

  it('quem nunca respondeu recebe null, não um padrão inventado', async () => {
    expect((await resumo(await novoAluno())).todayCondition).toBeNull();
  });

  it('sinais opcionais não respondidos não voltam como `false`', async () => {
    const aluno = await novoAluno();
    await gravarCheckin(aluno, { source: 'wellbeing', feeling: 'energized' });
    const cond = (await resumo(aluno)).todayCondition as { details: Record<string, unknown> };
    expect('hydrationOk' in cond.details).toBe(false);
    expect('nutritionLevel' in cond.details).toBe(false);
    expect('mentalLoadLevel' in cond.details).toBe(false);
  });

  it('sinais opcionais respondidos viajam com o valor gravado', async () => {
    const aluno = await novoAluno();
    await gravarCheckin(aluno, {
      source: 'wellbeing',
      feeling: 'neutral',
      hydration_ok: false,
      nutrition_level: 'poor',
      mental_load_level: 'high',
    });
    const cond = (await resumo(aluno)).todayCondition as { details: Record<string, unknown> };
    expect(cond.details).toMatchObject({
      hydrationOk: false,
      nutritionLevel: 'poor',
      mentalLoadLevel: 'high',
    });
  });
});
