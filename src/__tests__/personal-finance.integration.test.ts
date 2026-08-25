/**
 * Financeiro do personal com banco real (Onda F1).
 *
 * O que só o Postgres prova aqui: o `UNIQUE (plan_id, competence)` sustenta a
 * geração preguiçosa sob repetição, o `UNIQUE` parcial deixa um único acordo
 * ativo por par, o ledger sobrevive ao estorno, e a carteira de um personal não
 * aparece — nem se deixa alterar — para outro.
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

jest.setTimeout(120_000);

const TAG = 'itest-f1';

type Servico = typeof import('../services/personalFinanceService');

describeWithDb('Financeiro do personal · acordo, cobrança e isolamento', () => {
  let c: Client;
  let svc: Servico;
  let hoje: string;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    await restorePerformanceSchema(c);
    svc = await import('../services/personalFinanceService');
    hoje = (await import('../utils/appDay')).dayKey();
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  let seq = 0;

  /** Personal + aluno com vínculo ativo — o pré-requisito de todo acordo. */
  async function dupla(): Promise<{ personalId: number; studentId: number }> {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, studentId],
    );
    return { personalId, studentId };
  }

  /** 'YYYY-MM-DD' do primeiro dia do mês, `n` meses a partir de hoje. */
  function competencia(n: number): string {
    const ano = Number(hoje.slice(0, 4));
    const mes = Number(hoje.slice(5, 7)) - 1 + n;
    const d = new Date(Date.UTC(ano, mes, 1));
    return d.toISOString().slice(0, 10);
  }

  async function cobrancas(personalId: number) {
    const { rows } = await c.query<{ competence: string; status: string; due_date: string }>(
      `SELECT to_char(competence,'YYYY-MM-DD') AS competence, status,
              to_char(due_date,'YYYY-MM-DD') AS due_date
         FROM personal_financial_charges
        WHERE personal_id = $1
        ORDER BY competence`,
      [personalId],
    );
    return rows;
  }

  async function eventos(personalId: number, tipo?: string) {
    const { rows } = await c.query<{ event_type: string; charge_id: number | null }>(
      `SELECT event_type, charge_id FROM personal_financial_events
        WHERE personal_id = $1 AND ($2::text IS NULL OR event_type = $2)
        ORDER BY id`,
      [personalId, tipo ?? null],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Vínculo
  // -------------------------------------------------------------------------

  it('acordo sem vínculo ativo é recusado (o defeito MON-02 do billing congelado)', async () => {
    const personalId = await createUser(c, TAG, 'personal-solto');
    const estranho = await createUser(c, TAG, 'aluno-de-ninguem');

    await expect(
      svc.createOrReplacePlan(personalId, estranho, personalId, {
        priceCents: 25_000,
        period: 'monthly',
        dueDay: 5,
      }),
    ).rejects.toMatchObject({ message: 'ASSIGNMENT_REQUIRED', status: 403 });

    const { rows } = await c.query(
      `SELECT 1 FROM personal_financial_plans WHERE personal_id = $1`,
      [personalId],
    );
    expect(rows).toHaveLength(0);
  });

  it('vínculo revogado deixa de autorizar acordo novo', async () => {
    const { personalId, studentId } = await dupla();
    await c.query(
      `UPDATE personal_student_assignments SET status = 'revoked'
        WHERE personal_id = $1 AND student_id = $2`,
      [personalId, studentId],
    );

    await expect(
      svc.createOrReplacePlan(personalId, studentId, personalId, {
        priceCents: 20_000,
        period: 'monthly',
        dueDay: 10,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // -------------------------------------------------------------------------
  // Geração de cobranças
  // -------------------------------------------------------------------------

  it('acordo criado nasce com a cobrança do mês corrente e a do mês seguinte', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 30_000,
      period: 'monthly',
      dueDay: 10,
    });

    const lista = await cobrancas(personalId);
    expect(lista.map((r) => r.competence)).toEqual([competencia(0), competencia(1)]);
    expect(lista.every((r) => r.status === 'open')).toBe(true);
    expect(lista[1].due_date.slice(8, 10)).toBe('10');
    // A primeira cobrança nunca vence antes do início do acordo: com o acordo
    // começando hoje e vencimento no dia 10, ela vence hoje — não retroage.
    expect(lista[0].due_date >= hoje).toBe(true);

    // Toda cobrança criada deixa rastro no ledger.
    expect(await eventos(personalId, 'charge_created')).toHaveLength(2);
  });

  it('ensureCharges repetido não duplica competência', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 18_000,
      period: 'monthly',
      dueDay: 5,
      startsOn: competencia(-2),
    });

    const antes = await cobrancas(personalId);
    expect(antes).toHaveLength(4); // 2 meses atrás, mês passado, mês corrente, mês seguinte

    const criadas = await svc.ensureCharges(personalId);
    await svc.ensureCharges(personalId);

    expect(criadas).toBe(0);
    expect(await cobrancas(personalId)).toHaveLength(4);
    expect(await eventos(personalId, 'charge_created')).toHaveLength(4);
  });

  it('duas gerações simultâneas continuam produzindo uma cobrança por competência', async () => {
    const { personalId, studentId } = await dupla();
    await c.query(
      `INSERT INTO personal_financial_plans
         (personal_id, student_id, price_cents, period, due_day, starts_on)
       VALUES ($1, $2, 15000, 'monthly', 8, $3::date)`,
      [personalId, studentId, competencia(0)],
    );

    await Promise.all([svc.ensureCharges(personalId), svc.ensureCharges(personalId)]);

    expect(await cobrancas(personalId)).toHaveLength(2);
  });

  it('acordo sem renovação automática não passa do ciclo corrente', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 40_000,
      period: 'monthly',
      dueDay: 12,
      autoRenew: false,
    });

    expect((await cobrancas(personalId)).map((r) => r.competence)).toEqual([competencia(0)]);
  });

  it('pacote gera uma única cobrança, mesmo em leituras posteriores', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 60_000,
      period: 'package',
      packageSessions: 10,
      startsOn: competencia(-1),
    });

    await svc.ensureCharges(personalId);
    expect(await cobrancas(personalId)).toHaveLength(1);
  });

  it('acordo novo encerra o anterior — um ativo por aluno', async () => {
    const { personalId, studentId } = await dupla();
    const primeiro = await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 20_000,
      period: 'monthly',
      dueDay: 5,
    });
    const segundo = await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 25_000,
      period: 'monthly',
      dueDay: 5,
    });

    const { rows } = await c.query<{ id: number; status: string }>(
      `SELECT id, status FROM personal_financial_plans WHERE personal_id = $1 ORDER BY id`,
      [personalId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === primeiro.id)!.status).toBe('ended');
    expect(rows.find((r) => r.id === segundo.id)!.status).toBe('active');

    // As cobranças do acordo antigo sobrevivem: foram emitidas sob aquele preço.
    const { rows: antigas } = await c.query(
      `SELECT amount_cents FROM personal_financial_charges WHERE plan_id = $1`,
      [primeiro.id],
    );
    expect(antigas.length).toBeGreaterThan(0);
    expect(antigas[0].amount_cents).toBe(20_000);
  });

  // -------------------------------------------------------------------------
  // Pagamento
  // -------------------------------------------------------------------------

  async function acordoComCobranca(precoCents = 30_000) {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: precoCents,
      period: 'monthly',
      dueDay: 10,
    });
    const detalhe = await svc.getStudentFinance(personalId, studentId);
    const corrente = detalhe.charges.find((ch) => ch.competence === competencia(0))!;
    return { personalId, studentId, chargeId: corrente.id };
  }

  it('pagamento cheio fecha a cobrança como paga', async () => {
    const { personalId, chargeId } = await acordoComCobranca();

    const charge = await svc.payCharge(personalId, chargeId, personalId, { paidMethod: 'pix' });

    expect(charge.status).toBe('paid');
    expect(charge.paidCents).toBe(30_000);
    expect(charge.paidMethod).toBe('pix');
    expect(charge.paidAt).not.toBeNull();
    expect((await eventos(personalId, 'payment_recorded'))).toHaveLength(1);
  });

  it('pagamento menor que o valor deixa a cobrança parcial e acumula no segundo registro', async () => {
    const { personalId, chargeId } = await acordoComCobranca();

    const parcial = await svc.payCharge(personalId, chargeId, personalId, {
      paidCents: 10_000,
      paidMethod: 'cash',
    });
    expect(parcial.status).toBe('partial');
    expect(parcial.paidCents).toBe(10_000);

    const quitada = await svc.payCharge(personalId, chargeId, personalId, {});
    expect(quitada.status).toBe('paid');
    expect(quitada.paidCents).toBe(30_000);
  });

  it('pagamento acima do restante é recusado', async () => {
    const { personalId, chargeId } = await acordoComCobranca();
    await expect(
      svc.payCharge(personalId, chargeId, personalId, { paidCents: 30_001 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('estorno devolve a cobrança para em aberto sem apagar linha nem histórico', async () => {
    const { personalId, chargeId } = await acordoComCobranca();
    await svc.payCharge(personalId, chargeId, personalId, { paidMethod: 'pix' });

    const revertida = await svc.revertPayment(personalId, chargeId, personalId);

    expect(revertida.status).toBe('open');
    expect(revertida.paidCents).toBe(0);
    expect(revertida.paidAt).toBeNull();

    const { rows } = await c.query(
      `SELECT 1 FROM personal_financial_charges WHERE id = $1`,
      [chargeId],
    );
    expect(rows).toHaveLength(1);

    // O evento do pagamento permanece; o estorno é um evento A MAIS.
    const trilha = (await eventos(personalId)).map((e) => e.event_type);
    expect(trilha).toContain('payment_recorded');
    expect(trilha).toContain('payment_reverted');

    // E a cobrança volta a ser pagável.
    const repaga = await svc.payCharge(personalId, chargeId, personalId, {});
    expect(repaga.status).toBe('paid');
  });

  it('isenta e cancela são terminais', async () => {
    const isento = await acordoComCobranca();
    await svc.waiveCharge(isento.personalId, isento.chargeId, isento.personalId, 'cortesia');
    await expect(
      svc.payCharge(isento.personalId, isento.chargeId, isento.personalId, {}),
    ).rejects.toMatchObject({ status: 409 });

    const cancelado = await acordoComCobranca();
    await svc.cancelCharge(cancelado.personalId, cancelado.chargeId, cancelado.personalId);
    await expect(
      svc.waiveCharge(cancelado.personalId, cancelado.chargeId, cancelado.personalId),
    ).rejects.toMatchObject({ status: 409 });
  });

  // -------------------------------------------------------------------------
  // Vencido × a vencer (derivado da data, sem cron)
  // -------------------------------------------------------------------------

  it('vencido e a vencer saem da comparação com o dia corrente', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 20_000,
      period: 'monthly',
      dueDay: 5,
      startsOn: competencia(-2),
    });

    const { charges } = await svc.getStudentFinance(personalId, studentId);
    const antiga = charges.find((ch) => ch.competence === competencia(-2))!;
    const futura = charges.find((ch) => ch.competence === competencia(1))!;

    expect(antiga.derivedStatus).toBe('overdue');
    expect(antiga.daysOverdue).toBeGreaterThan(30);
    expect(futura.derivedStatus).toBe('upcoming');
    expect(futura.daysOverdue).toBe(0);

    // Nenhum status derivado foi gravado: o banco continua dizendo 'open'.
    const armazenados = (await cobrancas(personalId)).map((r) => r.status);
    expect(new Set(armazenados)).toEqual(new Set(['open']));

    const vencidos = await svc.listStudentsFinance(personalId, { status: 'overdue' });
    expect(vencidos.map((r) => r.studentId)).toEqual([studentId]);
    // A cobrança corrente da lista é a mais antiga em aberto — a que cobra ação.
    expect(vencidos[0].currentCharge!.competence).toBe(competencia(-2));

    expect(await svc.listStudentsFinance(personalId, { status: 'paid' })).toHaveLength(0);
  });

  it('aluno sem acordo aparece na carteira e no filtro "sem acordo"', async () => {
    const { personalId, studentId } = await dupla();

    const todos = await svc.listStudentsFinance(personalId);
    expect(todos.map((r) => r.studentId)).toEqual([studentId]);
    expect(todos[0].plan).toBeNull();
    expect(todos[0].currentCharge).toBeNull();

    expect(await svc.listStudentsFinance(personalId, { status: 'no_plan' })).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // KPIs
  // -------------------------------------------------------------------------

  it('KPIs do mês somam previsto, recebido e vencido a partir das cobranças', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 30_000,
      period: 'monthly',
      dueDay: 5,
      startsOn: competencia(-1),
    });

    const antes = await svc.getOverview(personalId);
    expect(antes.kpis.month).toBe(hoje.slice(0, 7));
    expect(antes.kpis.expectedCents).toBe(30_000); // só a competência do mês
    expect(antes.kpis.receivedCents).toBe(0);
    expect(antes.kpis.mrrCents).toBe(30_000);
    expect(antes.kpis.overdueStudents).toBe(1); // a competência do mês passado

    const { charges } = await svc.getStudentFinance(personalId, studentId);
    for (const competencia_ of [competencia(-1), competencia(0)]) {
      const alvo = charges.find((ch) => ch.competence === competencia_)!;
      await svc.payCharge(personalId, alvo.id, personalId, { paidMethod: 'pix' });
    }

    const depois = await svc.getOverview(personalId);
    expect(depois.kpis.overdueStudents).toBe(0);
    expect(depois.kpis.overdueCents).toBe(0);
    // Recebido é por COMPETÊNCIA: o pagamento do mês passado ficou no mês
    // passado, e só a competência corrente entra aqui.
    expect(depois.kpis.receivedCents).toBe(30_000);
    expect(depois.kpis.expectedCents).toBe(30_000);

    const historico = await svc.getHistory(personalId, 3);
    expect(historico).toHaveLength(3);
    expect(historico[historico.length - 1].month).toBe(hoje.slice(0, 7));
    expect(historico.find((p) => p.month === competencia(-1).slice(0, 7))).toMatchObject({
      expectedCents: 30_000,
      receivedCents: 30_000,
    });
  });

  it('a visão geral separa o que cobra ação do que renova em breve', async () => {
    const { personalId, studentId } = await dupla();
    seq += 1;
    const aRenovar = await createUser(c, TAG, `aluno-renova-${seq}`);
    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status)
       VALUES ($1, $2, 'active')`,
      [personalId, aRenovar],
    );

    // Um acordo com competências antigas em aberto…
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 22_000,
      period: 'monthly',
      dueDay: 5,
      startsOn: competencia(-2),
    });
    // …e um pacote que se esgota na cobrança única de hoje.
    await svc.createOrReplacePlan(personalId, aRenovar, personalId, {
      priceCents: 60_000,
      period: 'package',
      packageSessions: 8,
    });

    const { kpis, attention, renewals } = await svc.getOverview(personalId);

    // Três meses em aberto do mesmo aluno são UMA pendência, medida pela mais
    // antiga — não três linhas repetindo o mesmo nome.
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      kind: 'payment_overdue',
      studentId,
      amountCents: 22_000,
    });
    expect(attention[0].daysOverdue).toBeGreaterThan(30);

    // O mensal com renovação automática não é renovação: ele não termina.
    expect(renewals).toEqual([
      {
        studentId: aRenovar,
        studentName: expect.any(String),
        dueDate: hoje,
        amountCents: 60_000,
        period: 'package',
        autoRenew: true,
      },
    ]);
    expect(kpis.upcomingRenewals).toBe(renewals.length);
  });

  // -------------------------------------------------------------------------
  // Isolamento (P0)
  // -------------------------------------------------------------------------

  it('personal B não vê nem altera acordo e cobrança do personal A', async () => {
    const a = await dupla();
    const b = await dupla();
    await svc.createOrReplacePlan(a.personalId, a.studentId, a.personalId, {
      priceCents: 35_000,
      period: 'monthly',
      dueDay: 7,
    });
    const detalheA = await svc.getStudentFinance(a.personalId, a.studentId);
    const chargeA = detalheA.charges[0].id;
    const planoA = detalheA.plan!.id;

    // Leitura: a carteira de B não contém o aluno de A, e pedir o aluno de A
    // pelo id devolve vazio — nunca o dado do outro.
    const carteiraB = await svc.listStudentsFinance(b.personalId);
    expect(carteiraB.map((r) => r.studentId)).toEqual([b.studentId]);

    const espiado = await svc.getStudentFinance(b.personalId, a.studentId);
    expect(espiado.plan).toBeNull();
    expect(espiado.charges).toHaveLength(0);
    expect(espiado.events).toHaveLength(0);

    // Escrita: toda operação por id responde 404 para quem não é dono.
    await expect(svc.payCharge(b.personalId, chargeA, b.personalId, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.revertPayment(b.personalId, chargeA, b.personalId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.waiveCharge(b.personalId, chargeA, b.personalId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.cancelCharge(b.personalId, chargeA, b.personalId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      svc.updatePlan(b.personalId, planoA, b.personalId, { priceCents: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(svc.endPlan(b.personalId, planoA, b.personalId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      svc.getEditablePlanId(b.personalId, a.studentId),
    ).rejects.toMatchObject({ status: 404 });

    // Nada mudou do lado de A.
    const depois = await svc.getStudentFinance(a.personalId, a.studentId);
    expect(depois.plan!.priceCents).toBe(35_000);
    expect(depois.plan!.status).toBe('active');
    expect(depois.charges.find((ch) => ch.id === chargeA)!.status).toBe('open');

    // E os KPIs de B seguem zerados apesar do dinheiro de A existir no banco.
    expect((await svc.getOverview(b.personalId)).kpis.expectedCents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edição do acordo
  // -------------------------------------------------------------------------

  it('edição valida o acordo inteiro e registra o evento correspondente', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 20_000,
      period: 'monthly',
      dueDay: 5,
    });
    const planId = await svc.getEditablePlanId(personalId, studentId);

    const pausado = await svc.updatePlan(personalId, planId, personalId, { status: 'paused' });
    expect(pausado.status).toBe('paused');
    expect((await eventos(personalId, 'plan_paused'))).toHaveLength(1);

    // Trocar para pacote sem limpar o dia de vencimento é incoerente — e o
    // serviço recusa em vez de gravar um acordo que se contradiz.
    await expect(
      svc.updatePlan(personalId, planId, personalId, { period: 'package' }),
    ).rejects.toMatchObject({ status: 400 });

    const encerrado = await svc.endPlan(personalId, planId, personalId);
    expect(encerrado.status).toBe('ended');
    await expect(
      svc.updatePlan(personalId, planId, personalId, { priceCents: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('acordo pausado para de gerar cobrança nova', async () => {
    const { personalId, studentId } = await dupla();
    await svc.createOrReplacePlan(personalId, studentId, personalId, {
      priceCents: 20_000,
      period: 'monthly',
      dueDay: 5,
    });
    const planId = await svc.getEditablePlanId(personalId, studentId);
    await c.query(`DELETE FROM personal_financial_charges WHERE plan_id = $1`, [planId]);

    await svc.updatePlan(personalId, planId, personalId, { status: 'paused' });
    await svc.ensureCharges(personalId);

    expect(await cobrancas(personalId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Contrato HTTP
  // -------------------------------------------------------------------------

  describe('rotas /api/personal/finance', () => {
    let app: import('express').Express;
    let token: (userId: number, role?: string, products?: string[]) => string;

    beforeAll(async () => {
      const express = (await import('express')).default;
      const rotas = (await import('../routes/personalFinance')).default;
      const { generateAccessToken } = await import('../utils/jwt');

      app = express();
      app.use(express.json());
      app.use('/api/personal', rotas);

      token = (userId, role = 'personal', products = ['personal']) =>
        generateAccessToken({
          id: userId,
          email: `${userId}@test.local`,
          role: role as 'personal',
          profileCompleted: true,
          products,
        });
    });

    it('exige token, produto e papel de personal', async () => {
      const request = (await import('supertest')).default;
      const { personalId } = await dupla();

      expect((await request(app).get('/api/personal/finance/overview')).status).toBe(401);

      const semProduto = await request(app)
        .get('/api/personal/finance/overview')
        .set('Authorization', `Bearer ${token(personalId, 'personal', [])}`);
      expect(semProduto.status).toBe(403);
      expect(semProduto.body.code).toBe('PRODUCT_NOT_GRANTED');

      const aluno = await request(app)
        .get('/api/personal/finance/overview')
        .set('Authorization', `Bearer ${token(personalId, 'user', ['personal'])}`);
      expect(aluno.status).toBe(403);
    });

    it('id fora da faixa do int4 para em 400, sem tocar o banco', async () => {
      const request = (await import('supertest')).default;
      const { personalId } = await dupla();
      const auth = `Bearer ${token(personalId)}`;

      const res = await request(app)
        .get('/api/personal/finance/students/9007199254740991')
        .set('Authorization', auth);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_studentId');

      const charge = await request(app)
        .post('/api/personal/finance/charges/-1/pay')
        .set('Authorization', auth)
        .send({});
      expect(charge.status).toBe(400);
    });

    it('ciclo completo pelo HTTP: acordo, pagamento, estorno e encerramento', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      const auth = `Bearer ${token(personalId)}`;

      const criado = await request(app)
        .post(`/api/personal/finance/students/${studentId}/plan`)
        .set('Authorization', auth)
        .send({ priceCents: 28_000, period: 'monthly', dueDay: 9, paymentMethod: 'pix' });
      expect(criado.status).toBe(201);
      expect(criado.body.data.priceCents).toBe(28_000);

      const invalido = await request(app)
        .post(`/api/personal/finance/students/${studentId}/plan`)
        .set('Authorization', auth)
        .send({ priceCents: 28_000, period: 'monthly' });
      expect(invalido.status).toBe(400);
      expect(invalido.body.error).toBe('invalid_due_day');

      const detalhe = await request(app)
        .get(`/api/personal/finance/students/${studentId}`)
        .set('Authorization', auth);
      expect(detalhe.status).toBe(200);
      const chargeId = detalhe.body.data.charges.find(
        (ch: any) => ch.competence === competencia(0),
      ).id;

      const pago = await request(app)
        .post(`/api/personal/finance/charges/${chargeId}/pay`)
        .set('Authorization', auth)
        .send({ paidMethod: 'pix' });
      expect(pago.status).toBe(200);
      expect(pago.body.data.status).toBe('paid');

      const overview = await request(app)
        .get('/api/personal/finance/overview')
        .set('Authorization', auth);
      expect(overview.body.data.kpis.receivedCents).toBe(28_000);
      // O contrato completo — a tela lê os três campos, mesmo vazios.
      expect(overview.body.data).toMatchObject({ attention: [], renewals: [] });

      const estorno = await request(app)
        .post(`/api/personal/finance/charges/${chargeId}/revert`)
        .set('Authorization', auth);
      expect(estorno.body.data.status).toBe('open');

      const patch = await request(app)
        .patch(`/api/personal/finance/students/${studentId}/plan`)
        .set('Authorization', auth)
        .send({ priceCents: 31_000 });
      expect(patch.body.data.priceCents).toBe(31_000);

      const fim = await request(app)
        .post(`/api/personal/finance/students/${studentId}/plan/end`)
        .set('Authorization', auth);
      expect(fim.body.data.status).toBe('ended');

      const filtro = await request(app)
        .get('/api/personal/finance/students?status=inventado')
        .set('Authorization', auth);
      expect(filtro.status).toBe(400);
    });

    // Onda F4: payload malformado é erro do cliente, não do servidor. O que
    // estava fora do tipo ou fora do calendário chegava ao Postgres e voltava
    // como 500 sem nome de campo; o que era coagido na borda (`autoRenew`,
    // `notes`) era gravado diferente do que o cliente mandou, em silêncio.
    it('payload malformado responde 400 nomeando o campo, nunca 500', async () => {
      const request = (await import('supertest')).default;
      const { personalId, studentId } = await dupla();
      const auth = `Bearer ${token(personalId)}`;

      const base = { priceCents: 10_000, period: 'monthly', dueDay: 5 };
      const recusas: Array<[Record<string, unknown>, string]> = [
        [{ ...base, autoRenew: 'nao' }, 'invalid_auto_renew'],
        [{ ...base, notes: { a: 1 } }, 'invalid_notes'],
        [{ ...base, startsOn: '2026-02-31' }, 'invalid_starts_on'],
        [{ ...base, startsOn: '2016-01-10' }, 'starts_on_out_of_range'],
      ];
      for (const [body, erro] of recusas) {
        const res = await request(app)
          .post(`/api/personal/finance/students/${studentId}/plan`)
          .set('Authorization', auth)
          .send(body);
        expect([res.status, res.body.error]).toEqual([400, erro]);
      }
      expect(await cobrancas(personalId)).toHaveLength(0);

      await request(app)
        .post(`/api/personal/finance/students/${studentId}/plan`)
        .set('Authorization', auth)
        .send(base);

      for (const [body, erro] of [
        [{ autoRenew: 1 }, 'invalid_auto_renew'],
        [{ notes: 42 }, 'invalid_notes'],
      ] as Array<[Record<string, unknown>, string]>) {
        const res = await request(app)
          .patch(`/api/personal/finance/students/${studentId}/plan`)
          .set('Authorization', auth)
          .send(body);
        expect([res.status, res.body.error]).toEqual([400, erro]);
      }

      const { charges } = await svc.getStudentFinance(personalId, studentId);
      for (const [body, erro] of [
        [{ paidAt: 12_345 }, 'invalid_paid_at'],
        [{ paidMethod: 7 }, 'invalid_payment_method'],
        [{ notes: [] }, 'invalid_notes'],
      ] as Array<[Record<string, unknown>, string]>) {
        const res = await request(app)
          .post(`/api/personal/finance/charges/${charges[0].id}/pay`)
          .set('Authorization', auth)
          .send(body);
        expect([res.status, res.body.error]).toEqual([400, erro]);
      }
    });

    it('acordo antigo continua editável — a janela de início só vale para data nova', async () => {
      const { personalId, studentId } = await dupla();
      const plano = await svc.createOrReplacePlan(personalId, studentId, personalId, {
        priceCents: 20_000,
        period: 'monthly',
        dueDay: 5,
      });
      // Simula o acordo que envelheceu no banco: revalidar o `starts_on` já
      // gravado não pode transformar edição de preço em 400.
      await c.query(`UPDATE personal_financial_plans SET starts_on = '2019-03-01' WHERE id = $1`, [
        plano.id,
      ]);

      const atualizado = await svc.updatePlan(personalId, plano.id, personalId, {
        priceCents: 24_000,
      });
      expect(atualizado.priceCents).toBe(24_000);
      expect(atualizado.startsOn).toBe('2019-03-01');

      await expect(
        svc.updatePlan(personalId, plano.id, personalId, { startsOn: '2019-03-01' }),
      ).rejects.toThrow('starts_on_out_of_range');
    });

    it('personal B recebe 404 ao tentar pagar cobrança do personal A pelo HTTP', async () => {
      const request = (await import('supertest')).default;
      const a = await dupla();
      const b = await dupla();
      await svc.createOrReplacePlan(a.personalId, a.studentId, a.personalId, {
        priceCents: 22_000,
        period: 'monthly',
        dueDay: 6,
      });
      const { charges } = await svc.getStudentFinance(a.personalId, a.studentId);

      const res = await request(app)
        .post(`/api/personal/finance/charges/${charges[0].id}/pay`)
        .set('Authorization', `Bearer ${token(b.personalId)}`)
        .send({});
      expect(res.status).toBe(404);

      const lista = await request(app)
        .get('/api/personal/finance/students')
        .set('Authorization', `Bearer ${token(b.personalId)}`);
      expect(lista.body.data.map((r: any) => r.studentId)).toEqual([b.studentId]);
    });
  });
});
