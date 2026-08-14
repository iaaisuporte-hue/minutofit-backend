/**
 * Prontidão do dia com banco real (Spec 033, Onda P6).
 *
 * Os unitários já cobrem as regras do Lens como função pura. O que só existe
 * aqui é o CIRCUITO: `check-in → prontidão → adaptação`. Ele atravessa três
 * tabelas (`user_daily_checkins`, `workout_session_metrics`,
 * `user_readiness_snapshot`) e duas consultas SQL que nenhum mock exercita —
 * inclusive a que alimenta o `load.spike`, o fator que a P3 criou e deixou sem
 * nenhuma fonte de dados até esta onda.
 *
 * Como rodar:
 *   TEST_DATABASE_URL=postgresql://... npx jest performance-p6.integration
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createUser,
  describeWithDb,
  hasTestDb,
  finishSuite,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(90_000);

const TAG = 'itest-p6';

/** Sinais de um dia sem nada de errado. Ponto de partida de todos os casos. */
interface CheckinSignals {
  feeling: 'energized' | 'neutral' | 'tired';
  sleptWell: boolean;
  inPain: boolean;
  stressed: boolean;
  hydrationOk: boolean;
  nutritionLevel: 'poor' | 'ok' | 'good';
  mentalLoadLevel: 'low' | 'medium' | 'high';
}

const NEUTRO: CheckinSignals = {
  feeling: 'neutral',
  sleptWell: true,
  inPain: false,
  stressed: false,
  hydrationOk: true,
  nutritionLevel: 'ok',
  mentalLoadLevel: 'low',
};

describeWithDb('Performance P6 · Prontidão com banco real', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    // Mesma precondição das demais suítes do módulo: schema na versão corrente,
    // sem depender da ordem em que o Jest resolveu rodar os arquivos.
    await restorePerformanceSchema(c);
    await cleanFixtures(c, TAG);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
  });

  afterAll(async () => {
    // `finishSuite` libera o lock no `finally`: limpeza que falha não
    // pode reter o advisory lock e travar as suítes seguintes.
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  /**
   * Grava o check-in de HOJE.
   *
   * `date_key = CURRENT_DATE` porque é exatamente assim que a consulta do
   * readiness procura a linha — comparar por data, e não por timestamp, é o que
   * faz o check-in das 23h ainda valer para o treino da mesma noite.
   */
  async function checkinToday(userId: number, over: Partial<CheckinSignals> = {}): Promise<void> {
    const s = { ...NEUTRO, ...over };
    await c.query(
      `INSERT INTO user_daily_checkins
         (user_id, academy_id, date_key, source, xp_awarded,
          feeling, slept_well, in_pain, stressed, hydration_ok,
          nutrition_level, mental_load_level)
       VALUES ($1, NULL, CURRENT_DATE, 'wellbeing', 0, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        s.feeling,
        s.sleptWell,
        s.inPain,
        s.stressed,
        s.hydrationOk,
        s.nutritionLevel,
        s.mentalLoadLevel,
      ],
    );
  }

  /**
   * Sessão executada com carga registrada.
   *
   * `effort_load` e `effort_load_method` andam em par — há CHECK no banco
   * exigindo que os dois sejam nulos ou os dois preenchidos. É o satélite
   * `workout_session_metrics`, e não a sessão crua, que alimenta o ritmo de
   * carga: `loadScoreAggregates` só olha para as métricas.
   */
  async function sessionWithLoad(userId: number, daysAgo: number, effortLoad: number): Promise<void> {
    const { rows } = await c.query(
      `INSERT INTO workout_sessions
         (user_id, source, status, prescribed_snapshot, started_at, ended_at, performed_at)
       VALUES ($1, 'free', 'completed', '[]'::jsonb,
               NOW() - ($2 || ' days')::interval,
               NOW() - ($2 || ' days')::interval,
               NOW() - ($2 || ' days')::interval)
       RETURNING id, performed_at`,
      [userId, daysAgo],
    );
    await c.query(
      `INSERT INTO workout_session_metrics
         (session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg,
          effort_load, effort_load_method, formula_version)
       VALUES ($1, $2, $3, 4, 40, 1000, $4, 'srpe_sets', 1)`,
      [rows[0].id, userId, rows[0].performed_at, effortLoad],
    );
  }

  async function snapshotRows(userId: number): Promise<{ level: string; factors: unknown }[]> {
    const { rows } = await c.query(
      `SELECT level, factors FROM user_readiness_snapshot
        WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
      [userId],
    );
    return rows;
  }

  /**
   * Espera o snapshot do dia aparecer.
   *
   * O upsert é deliberadamente fire-and-forget no serviço: a prontidão volta ao
   * aluno sem esperar a gravação, porque o Lens é recomputado a cada leitura e o
   * snapshot serve ao histórico, não ao cálculo. Consequência para o teste: ler
   * a tabela logo depois do `await` é uma corrida. Espera-se pela linha em vez
   * de fingir que a escrita é síncrona.
   */
  async function waitForSnapshot(userId: number): Promise<{ level: string; factors: unknown }[]> {
    for (let tentativa = 0; tentativa < 40; tentativa += 1) {
      const rows = await snapshotRows(userId);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return snapshotRows(userId);
  }

  // ── Sem check-in não há prontidão ─────────────────────────────────────────

  it('sem check-in de hoje não há prontidão — e é isso que serve o treino original', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'sem-checkin');

    // `null` não é falha: é a recusa de afirmar sobre o corpo de alguém que não
    // relatou nada. `/training/today` lê esse null e entrega a ficha como o
    // personal prescreveu, sem adaptação.
    expect(await getReadinessLensToday(userId)).toBeNull();

    // E nada é gravado: o dia sem relato não vira linha de histórico.
    expect(await snapshotRows(userId)).toHaveLength(0);
  });

  // ── O check-in acende a prontidão ─────────────────────────────────────────

  it('o check-in do dia cria a prontidão, com nível e fatores', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'com-checkin');
    await checkinToday(userId);

    const lens = await getReadinessLensToday(userId);
    expect(lens).not.toBeNull();
    expect(['green', 'yellow', 'red']).toContain(lens!.level);
    expect(lens!.factors.length).toBeGreaterThan(0);
    expect(lens!.headline).toBeTruthy();

    // Conta nova, nenhum sinal ruim: verde. O score metabólico ausente vale 50,
    // que é a faixa neutra — ausência de dado não vira alerta.
    expect(lens!.level).toBe('green');
    expect(lens!.factors.map((f) => f.id)).toEqual(['state.nominal']);
  });

  it('dor relatada leva a vermelho', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'dor');
    await checkinToday(userId, { inPain: true });

    const lens = await getReadinessLensToday(userId);
    expect(lens!.level).toBe('red');
    expect(lens!.factors.find((f) => f.id === 'pain.reported')?.severity).toBe('block');
  });

  it('cansaço somado a noite mal dormida chega ao vermelho pelo banco', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'fadiga');
    await checkinToday(userId, { feeling: 'tired', sleptWell: false });

    const lens = await getReadinessLensToday(userId);
    expect(lens!.level).toBe('red');
    expect(lens!.factors.map((f) => f.id)).toContain('fatigue.compound');
  });

  // ── Memória do dia ────────────────────────────────────────────────────────

  it('o snapshot do dia é gravado uma vez só, mesmo com leituras repetidas', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'snapshot');
    await checkinToday(userId, { inPain: true });

    const lens = await getReadinessLensToday(userId);
    const gravado = await waitForSnapshot(userId);
    expect(gravado).toHaveLength(1);
    expect(gravado[0].level).toBe(lens!.level);

    // Segunda leitura do mesmo dia: o UNIQUE (user_id, snapshot_date) faz o
    // upsert reescrever a MESMA linha. Duas linhas para o mesmo dia significariam
    // dois históricos de prontidão para a mesma data.
    const denovo = await getReadinessLensToday(userId);
    expect(denovo!.level).toBe(lens!.level);
    const depois = await waitForSnapshot(userId);
    expect(depois).toHaveLength(1);
    expect(depois[0].level).toBe(lens!.level);
  });

  it('invalidar a prontidão apaga a linha do dia', async () => {
    const { getReadinessLensToday, invalidateReadinessSnapshot } =
      await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'invalidar');
    await checkinToday(userId);

    await getReadinessLensToday(userId);
    expect(await waitForSnapshot(userId)).toHaveLength(1);

    // É o que o app chama quando o aluno REFAZ o check-in: o estado antigo tem
    // de sair, senão a tela mostraria a prontidão de antes do novo relato.
    await invalidateReadinessSnapshot(userId);
    expect(await snapshotRows(userId)).toHaveLength(0);
  });

  // ── O ritmo de carga chegando ao readiness ────────────────────────────────

  it('carga bem acima do padrão acende load.spike — o circuito que a P3 deixou aberto', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'pico-carga');
    // O exercício não participa do cálculo do ritmo (que lê só as métricas da
    // sessão), mas mantém a fixture parecida com um histórico real de treino.
    await createExercise(c, TAG, 'Agachamento pico');
    await checkinToday(userId);

    // Média diária de 7 dias contra a de 28: quatro sessões pesadas na semana
    // (480) contra o padrão do mês (480 + 200 = 680) dá 4 × 480 ÷ 680 ≈ 2,82 —
    // acima do limiar de 1,6. As nove sessões com carga também passam do mínimo
    // de amostra (LOAD_RATIO_MIN_SESSIONS = 8).
    for (const dia of [1, 2, 3, 4]) await sessionWithLoad(userId, dia, 120);
    for (const dia of [10, 14, 18, 22, 26]) await sessionWithLoad(userId, dia, 40);

    const lens = await getReadinessLensToday(userId);
    expect(lens!.factors.map((f) => f.id)).toContain('load.spike');
    // Amarelo, nunca vermelho: treinar muito não é dor nem exaustão relatada.
    expect(lens!.level).toBe('yellow');
    expect(lens!.factors.find((f) => f.id === 'load.spike')?.severity).toBe('caution');

    // O nível que o aluno viu é o que ficou no histórico.
    const gravado = await waitForSnapshot(userId);
    expect(gravado[0].level).toBe('yellow');
  });

  it('sem amostra suficiente, nenhum pico é afirmado', async () => {
    const { getReadinessLensToday } = await import('../modules/readiness/readiness.service');

    const userId = await createUser(c, TAG, 'pouca-carga');
    await checkinToday(userId);

    // Três sessões, todas na última semana: a razão pura daria 4,0 e gritaria
    // "pico". Sem padrão estabelecido nos 28 dias, porém, não há contra o que
    // comparar — o mínimo de amostra existe justamente para não transformar a
    // primeira semana de treino de alguém num alerta.
    for (const dia of [1, 3, 5]) await sessionWithLoad(userId, dia, 150);

    const lens = await getReadinessLensToday(userId);
    expect(lens!.factors.map((f) => f.id)).not.toContain('load.spike');
    expect(lens!.level).toBe('green');
  });
});
