/**
 * Financeiro × retenção com banco real (Onda F3).
 *
 * O que só o Postgres prova aqui: a subconsulta de atraso realmente encontra a
 * cobrança na query da carteira (tsc não vê SQL), a redação por consent deixa
 * passar o motivo financeiro e barra o de saúde, quitar a cobrança derruba o
 * dashboard em cache, e a timeline do aluno enxerga o ledger financeiro.
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
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// Redis de mentira, com estado observável: sem ele o dashboard nunca cacheia e
// a invalidação da Onda F3 seria testada contra o nada.
jest.mock('../lib/redisClient', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    getRedisClient: () => ({
      get: async (key: string) => store.get(key) ?? null,
      setex: async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    }),
  };
});

jest.setTimeout(120_000);

const TAG = 'itest-f3';

type Dashboard = typeof import('../services/personalDashboardService');
type Financeiro = typeof import('../services/personalFinanceService');
type Retencao = typeof import('../services/personalRetentionService');

describeWithDb('Financeiro × retenção · risco, alerta e timeline', () => {
  let c: Client;
  let dash: Dashboard;
  let fin: Financeiro;
  let ret: Retencao;
  let hoje: string;
  let redisStore: Map<string, string>;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    dash = await import('../services/personalDashboardService');
    fin = await import('../services/personalFinanceService');
    ret = await import('../services/personalRetentionService');
    hoje = (await import('../utils/appDay')).dayKey();
    redisStore = (await import('../lib/redisClient') as unknown as { __store: Map<string, string> })
      .__store;
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  /**
   * Personal + aluno com 90 dias de vínculo e histórico regular.
   *
   * O histórico existe para tirar o aluno da carência de onboarding E do teto de
   * risco: com engajamento zero o score satura em 100 e o termo financeiro
   * ficaria invisível — o teste passaria sem provar nada.
   */
  async function carteira(): Promise<{ personalId: number; studentId: number }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status, created_at)
       VALUES ($1, $2, 'active', NOW() - INTERVAL '90 days')`,
      [personalId, studentId],
    );

    // 12 treinos em 30 dias, 3 deles nos últimos 7.
    for (const diasAtras of [1, 3, 5, 9, 11, 13, 15, 17, 19, 21, 24, 27]) {
      await c.query(
        `INSERT INTO user_workout_logs (user_id, workout_id, title, completed_at)
         VALUES ($1, $2, 'Treino', NOW() - make_interval(days => $3))`,
        [studentId, `w-${diasAtras}`, diasAtras],
      );
    }

    // Check-in recente com sono ruim: é o motivo de risco que o consent deve
    // barrar, ao contrário do financeiro.
    await c.query(
      `INSERT INTO user_daily_checkins (user_id, date_key, source, slept_well)
       VALUES ($1, CURRENT_DATE - 1, 'wellbeing', false), ($1, CURRENT_DATE - 3, 'wellbeing', true)`,
      [studentId],
    );

    return { personalId, studentId };
  }

  /** Acordo com a cobrança vencida há `dias` — o sinal que a Onda F3 lê. */
  async function acordoVencido(personalId: number, studentId: number, dias: number) {
    await fin.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 25_000,
      period: 'monthly',
      dueDay: 5,
      startsOn: `${hoje.slice(0, 7)}-01`,
    });
    await c.query(
      `UPDATE personal_financial_charges
          SET due_date = $2::date - $3::int
        WHERE personal_id = $1`,
      [personalId, hoje, dias],
    );
  }

  function conceder(personalId: number, studentId: number, scopes: string[]) {
    return c.query(
      `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
       SELECT $2, $1, 'personal', s, 'granted' FROM unnest($3::text[]) AS s
       ON CONFLICT (user_id, professional_id, professional_role, scope)
       DO UPDATE SET status = 'granted', revoked_at = NULL`,
      [personalId, studentId, scopes],
    );
  }

  type Painel = Awaited<ReturnType<Dashboard['getPersonalDashboard']>>;

  function alunoDe(painel: Painel, studentId: number) {
    const aluno = painel.students.find((s) => s.id === String(studentId));
    if (!aluno) throw new Error(`aluno ${studentId} ausente da carteira`);
    return aluno;
  }

  function alertaFinanceiro(painel: Painel) {
    return painel.summary.intelligentAlerts.find((a) => a.type === 'payment_overdue');
  }

  // -------------------------------------------------------------------------
  // Risco e alerta
  // -------------------------------------------------------------------------

  it('atraso vira motivo legível no aluno e alerta agregado no painel', async () => {
    const { personalId, studentId } = await carteira();
    await acordoVencido(personalId, studentId, 12);

    const painel = await dash.getPersonalDashboard(personalId, null);
    const aluno = alunoDe(painel, studentId);

    expect(aluno.riskScore).toEqual(expect.any(Number));
    expect(aluno.riskFactors).toContain('pagamento vencido há 12 dias');

    const alerta = alertaFinanceiro(painel);
    expect(alerta).toBeDefined();
    expect(alerta?.actionHref).toBe('/app/personal/finance');
    expect(`${alerta?.title} ${alerta?.description}`).not.toMatch(/R\$/);
  });

  it('consent revogado esconde o motivo de saúde e mantém o financeiro', async () => {
    const { personalId, studentId } = await carteira();
    await acordoVencido(personalId, studentId, 12);

    // Sem nenhuma linha de consent = nada autorizado.
    const semConsent = await dash.getPersonalDashboard(personalId, null);
    const antes = alunoDe(semConsent, studentId);
    expect(antes.riskFactors).toContain('pagamento vencido há 12 dias');
    expect(antes.riskFactors).not.toContain('sono ruim no último check-in');
    // O score continua completo — quem revoga não some da lista de quem precisa
    // de atenção, só deixa de ter o dado bruto exposto.
    expect(antes.riskScore).toBeGreaterThan(0);

    await conceder(personalId, studentId, ['sleep', 'daily_checkins', 'workouts', 'profile']);
    await dash.invalidatePersonalDashboardCache(personalId, null);

    const comConsent = await dash.getPersonalDashboard(personalId, null);
    const depois = alunoDe(comConsent, studentId);
    expect(depois.riskFactors).toContain('sono ruim no último check-in');
    expect(depois.riskFactors).toContain('pagamento vencido há 12 dias');
  });

  it('registrar o pagamento derruba o cache e o risco cai o que o atraso somava', async () => {
    const { personalId, studentId } = await carteira();
    await acordoVencido(personalId, studentId, 12);

    const comAtraso = await dash.getPersonalDashboard(personalId, null);
    const riscoComAtraso = alunoDe(comAtraso, studentId).riskScore as number;

    const chave = dash.personalDashboardCacheKey(personalId, null);
    expect(redisStore.has(chave)).toBe(true);

    const { rows } = await c.query<{ id: number }>(
      `SELECT id FROM personal_financial_charges WHERE personal_id = $1 AND status = 'open'`,
      [personalId],
    );
    for (const row of rows) {
      await fin.payCharge(personalId, row.id, personalId, {});
    }

    // A invalidação é fire-and-forget: o await do pagamento não a aguarda.
    await new Promise((resolve) => setImmediate(resolve));
    expect(redisStore.has(chave)).toBe(false);

    const quitado = await dash.getPersonalDashboard(personalId, null);
    const aluno = alunoDe(quitado, studentId);
    expect(aluno.riskFactors.some((f) => f.startsWith('pagamento vencido'))).toBe(false);
    expect(aluno.riskScore).toBe(riscoComAtraso - 10);
    expect(alertaFinanceiro(quitado)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------

  it('timeline mostra lembrete enviado e pagamento registrado', async () => {
    const { personalId, studentId } = await carteira();
    await acordoVencido(personalId, studentId, 5);

    await ret.createRelationshipAction(personalId, studentId, null, {
      actionType: 'payment_reminder_sent',
      payloadJson: { channel: 'whatsapp' },
    });

    const { rows } = await c.query<{ id: number }>(
      `SELECT id FROM personal_financial_charges WHERE personal_id = $1 ORDER BY id LIMIT 1`,
      [personalId],
    );
    await fin.payCharge(personalId, rows[0].id, personalId, { paidMethod: 'pix' });

    const timeline = await ret.listRelationshipTimeline(personalId, studentId, null);

    const lembrete = timeline.find((i) => i.meta.actionType === 'payment_reminder_sent');
    expect(lembrete?.title).toBe('Lembrete de cobrança enviado');

    const pagamento = timeline.find((i) => i.kind === 'payment');
    expect(pagamento?.title).toBe('Pagamento registrado');
    expect(pagamento?.meta.paidMethod).toBe('pix');
  });

  it('o pagamento não aparece na timeline de outro personal', async () => {
    const { personalId, studentId } = await carteira();
    await acordoVencido(personalId, studentId, 5);
    const { rows } = await c.query<{ id: number }>(
      `SELECT id FROM personal_financial_charges WHERE personal_id = $1 ORDER BY id LIMIT 1`,
      [personalId],
    );
    await fin.payCharge(personalId, rows[0].id, personalId, {});

    // Sem vínculo de propósito: o aluno já tem personal (o índice único garante
    // um só ativo), e o que se testa aqui é o filtro por `personal_id` na query.
    const intruso = await createUser(c, TAG, `intruso-${seq}`);
    const timeline = await ret.listRelationshipTimeline(intruso, studentId, null);
    expect(timeline.some((i) => i.kind === 'payment')).toBe(false);
  });
});
