/**
 * Gestão financeira da carteira do personal (Onda F1).
 *
 * A plataforma NÃO processa pagamento: o personal recebe fora (PIX, dinheiro,
 * MP próprio) e aqui registra o acordo e o status. Nada neste arquivo fala com
 * gateway, e o domínio congelado `personal_billing_*` (assinatura MP) não é
 * tocado — são semânticas diferentes de cobrança e continuam separadas.
 *
 * Três invariantes valem para tudo abaixo:
 *
 * 1. **`personal_id` sai sempre do token**, nunca do corpo ou do path, e entra
 *    em TODA cláusula WHERE. Um personal jamais lê ou altera linha de outro.
 * 2. **Vínculo ativo é pré-requisito** para criar acordo (`personal_student_
 *    assignments … status='active'`). O billing congelado não fazia essa
 *    checagem (MON-02) e só não virou vazamento porque a flag estava off.
 * 3. **O ledger não se apaga.** Estorno é evento novo (`payment_reverted`) com
 *    a cobrança voltando a `open`; nenhuma linha é removida.
 */
import type { QueryResult, QueryResultRow } from 'pg';

import pool from '../config/database';
import { invalidatePersonalDashboardForStudent } from './personalDashboardService';
import { dayKey } from '../utils/appDay';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export const FINANCE_PERIODS = [
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
  'package',
  'single',
] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];

export const PAYMENT_METHODS = ['pix', 'cash', 'card', 'transfer', 'mp', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PlanStatus = 'active' | 'paused' | 'ended';
export type ChargeStatus = 'open' | 'paid' | 'partial' | 'waived' | 'canceled';

/** O que a UI mostra: o armazenado, com `open`/`partial` resolvidos pela data. */
export type DerivedChargeStatus = 'paid' | 'partial' | 'overdue' | 'upcoming' | 'waived' | 'canceled';

export type FinancePlan = {
  id: number;
  studentId: number;
  priceCents: number;
  period: FinancePeriod;
  dueDay: number | null;
  packageSessions: number | null;
  autoRenew: boolean;
  paymentMethod: PaymentMethod | null;
  status: PlanStatus;
  startsOn: string;
  endsOn: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceCharge = {
  id: number;
  planId: number;
  studentId: number;
  competence: string;
  dueDate: string;
  amountCents: number;
  paidCents: number;
  status: ChargeStatus;
  derivedStatus: DerivedChargeStatus;
  daysOverdue: number;
  paidAt: string | null;
  paidMethod: PaymentMethod | null;
  origin: 'manual' | 'mp';
  notes: string | null;
  recordedBy: number | null;
};

export type FinanceEvent = {
  id: number;
  chargeId: number | null;
  planId: number | null;
  eventType: string;
  actorId: number;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PlanInput = {
  priceCents: number;
  period: FinancePeriod;
  dueDay?: number | null;
  packageSessions?: number | null;
  autoRenew?: boolean;
  paymentMethod?: PaymentMethod | null;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
};

export type StudentFinanceRow = {
  studentId: number;
  studentName: string | null;
  studentEmail: string | null;
  studentPhone: string | null;
  plan: FinancePlan | null;
  currentCharge: FinanceCharge | null;
};

/** Executor: o pool ou um client dentro de transação. */
type Executor = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
};

function fail(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Calendário de competências
// ---------------------------------------------------------------------------

/**
 * Quantos meses um ciclo dura. `package` e `single` não têm ciclo: geram uma
 * cobrança só, na competência de início.
 */
const PERIOD_STEP_MONTHS: Record<FinancePeriod, number | null> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  package: null,
  single: null,
};

/** Teto de iterações da geração — 20 anos de mensalidades. */
const MAX_OCCURRENCES = 240;

const yearMonth = (isoDate: string): string => isoDate.slice(0, 7);

function addMonths(ym: string, months: number): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7)) - 1 + months;
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}`;
}

function lastDayOfMonth(ym: string): number {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
}

/**
 * Vencimento da competência.
 *
 * `due_day` é limitado a 28 no banco justamente para não depender do tamanho do
 * mês, mas acordos antigos podem herdar o dia de `starts_on` — daí o clamp: dia
 * 30 em fevereiro vira o último dia do mês, nunca março.
 */
function dueDateFor(ym: string, dueDay: number): string {
  const day = Math.min(Math.max(dueDay, 1), lastDayOfMonth(ym));
  return `${ym}-${String(day).padStart(2, '0')}`;
}

type Occurrence = { competence: string; dueDate: string };

/** As competências que um acordo deve ter entre `starts_on` e o horizonte. */
export function occurrencesFor(
  plan: { period: FinancePeriod; dueDay: number | null; startsOn: string; endsOn: string | null; autoRenew: boolean },
  today: string,
): Occurrence[] {
  const step = PERIOD_STEP_MONTHS[plan.period];
  const startYm = yearMonth(plan.startsOn);
  const endYm = plan.endsOn ? yearMonth(plan.endsOn) : null;
  const baseDay = plan.dueDay ?? Number(plan.startsOn.slice(8, 10));

  // Uma competência à frente alimenta "a vencer"/renovações sem cron. Com
  // `auto_renew=false` o acordo não passa do ciclo corrente — é o que faz o
  // plano aparecer em "próximas renovações" quando a última cobrança vence.
  const horizonYm = step === null ? startYm : addMonths(yearMonth(today), plan.autoRenew ? 1 : 0);

  const out: Occurrence[] = [];
  let cursor = startYm;
  for (let i = 0; i < MAX_OCCURRENCES && cursor <= horizonYm; i += 1) {
    if (endYm && cursor > endYm) break;
    let due = dueDateFor(cursor, baseDay);
    // Vencimento anterior ao início do acordo não faz sentido: a primeira
    // cobrança vence, no mínimo, no dia em que o acordo começa.
    if (due < plan.startsOn) due = plan.startsOn;
    out.push({ competence: `${cursor}-01`, dueDate: due });
    if (step === null) break;
    cursor = addMonths(cursor, step);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapeamento de linhas
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = `
  id, student_id, price_cents, period, due_day, package_sessions, auto_renew,
  payment_method, status, to_char(starts_on,'YYYY-MM-DD') AS starts_on,
  to_char(ends_on,'YYYY-MM-DD') AS ends_on, notes, created_at, updated_at`;

const CHARGE_COLUMNS = `
  id, plan_id, student_id, to_char(competence,'YYYY-MM-DD') AS competence,
  to_char(due_date,'YYYY-MM-DD') AS due_date, amount_cents, paid_cents, status,
  paid_at, paid_method, origin, notes, recorded_by`;

function mapPlan(row: any): FinancePlan {
  return {
    id: row.id,
    studentId: row.student_id,
    priceCents: row.price_cents,
    period: row.period,
    dueDay: row.due_day,
    packageSessions: row.package_sessions,
    autoRenew: row.auto_renew,
    paymentMethod: row.payment_method,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Dias entre duas chaves 'YYYY-MM-DD' (positivo quando `to` é posterior). */
function dayDiff(from: string, to: string): number {
  const ms = (key: string): number => Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

function mapCharge(row: any, today: string): FinanceCharge {
  const open = row.status === 'open' || row.status === 'partial';
  const late = open && row.due_date < today;
  return {
    id: row.id,
    planId: row.plan_id,
    studentId: row.student_id,
    competence: row.competence,
    dueDate: row.due_date,
    amountCents: row.amount_cents,
    paidCents: row.paid_cents,
    status: row.status,
    derivedStatus: late ? 'overdue' : open ? 'upcoming' : row.status,
    daysOverdue: late ? dayDiff(row.due_date, today) : 0,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    paidMethod: row.paid_method,
    origin: row.origin,
    notes: row.notes,
    recordedBy: row.recorded_by,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Derruba o dashboard em cache do(s) personal(is) do aluno.
 *
 * Desde a Onda F3 o atraso de pagamento entra no `riskScore`, então uma
 * cobrança quitada precisa tirar o aluno da lista de risco na mesma hora — e
 * não daqui a até 60s, com o personal olhando para um alerta que ele acabou de
 * resolver. Fire-and-forget: a invalidação não pode derrubar o registro.
 */
function refreshDashboard(studentId: number): void {
  void invalidatePersonalDashboardForStudent(studentId).catch(() => undefined);
}

async function recordEvent(
  db: Executor,
  input: {
    personalId: number;
    actorId: number;
    eventType: string;
    chargeId?: number | null;
    planId?: number | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO personal_financial_events
       (personal_id, charge_id, plan_id, event_type, actor_id, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.personalId,
      input.chargeId ?? null,
      input.planId ?? null,
      input.eventType,
      input.actorId,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

// ---------------------------------------------------------------------------
// Geração preguiçosa de cobranças
// ---------------------------------------------------------------------------

/**
 * Cria as cobranças que faltam para os acordos ativos do personal.
 *
 * Chamada nas leituras do módulo — não há job agendado. A idempotência é do
 * banco (`UNIQUE (plan_id, competence)` + `ON CONFLICT DO NOTHING`), então duas
 * requisições concorrentes do mesmo personal não duplicam nada.
 *
 * O `actor_id` do evento `charge_created` é o próprio personal: a geração é
 * consequência de um acordo que ele criou, e o ledger não admite ator nulo.
 */
export async function ensureCharges(personalId: number, db: Executor = pool): Promise<number> {
  const today = dayKey();

  const { rows: plans } = await db.query<any>(
    `SELECT id, period, due_day, auto_renew, price_cents,
            to_char(starts_on,'YYYY-MM-DD') AS starts_on,
            to_char(ends_on,'YYYY-MM-DD')   AS ends_on,
            student_id
       FROM personal_financial_plans
      WHERE personal_id = $1 AND status = 'active'`,
    [personalId],
  );
  if (plans.length === 0) return 0;

  const planIds: number[] = [];
  const studentIds: number[] = [];
  const competences: string[] = [];
  const dueDates: string[] = [];
  const amounts: number[] = [];

  for (const plan of plans) {
    const occurrences = occurrencesFor(
      {
        period: plan.period,
        dueDay: plan.due_day,
        startsOn: plan.starts_on,
        endsOn: plan.ends_on,
        autoRenew: plan.auto_renew,
      },
      today,
    );
    for (const occ of occurrences) {
      planIds.push(plan.id);
      studentIds.push(plan.student_id);
      competences.push(occ.competence);
      dueDates.push(occ.dueDate);
      amounts.push(plan.price_cents);
    }
  }
  if (planIds.length === 0) return 0;

  const { rows: created } = await db.query<any>(
    `INSERT INTO personal_financial_charges
       (plan_id, personal_id, student_id, competence, due_date, amount_cents)
     SELECT t.plan_id, $1, t.student_id, t.competence, t.due_date, t.amount_cents
       FROM unnest($2::int[], $3::int[], $4::date[], $5::date[], $6::int[])
              AS t(plan_id, student_id, competence, due_date, amount_cents)
     ON CONFLICT (plan_id, competence) DO NOTHING
     RETURNING id, plan_id, to_char(competence,'YYYY-MM-DD') AS competence,
               to_char(due_date,'YYYY-MM-DD') AS due_date, amount_cents`,
    [personalId, planIds, studentIds, competences, dueDates, amounts],
  );

  if (created.length > 0) {
    await db.query(
      `INSERT INTO personal_financial_events
         (personal_id, charge_id, plan_id, event_type, actor_id, payload_json)
       SELECT $1, c.id, c.plan_id, 'charge_created', $1,
              jsonb_build_object(
                'competence',  to_char(c.competence,'YYYY-MM-DD'),
                'dueDate',     to_char(c.due_date,'YYYY-MM-DD'),
                'amountCents', c.amount_cents
              )
         FROM personal_financial_charges c
        WHERE c.id = ANY($2::int[])`,
      [personalId, created.map((r) => r.id)],
    );
  }

  return created.length;
}

// ---------------------------------------------------------------------------
// Acordos
// ---------------------------------------------------------------------------

async function assertAssigned(db: Executor, personalId: number, studentId: number): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM personal_student_assignments
      WHERE personal_id = $1 AND student_id = $2 AND status = 'active'`,
    [personalId, studentId],
  );
  if (rows.length === 0) throw fail('ASSIGNMENT_REQUIRED', 403);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Preço máximo aceito (R$ 1.000.000,00) — o teto real é o `int4` do banco. */
const MAX_PRICE_CENTS = 100_000_000;

/**
 * Data de calendário real, não só no formato.
 *
 * `Date.parse('2026-02-31')` devolve um número em vez de `NaN`, então a checagem
 * de formato deixava a data chegar ao `::date` do Postgres, que a recusa com
 * `22008` — 500 na cara do personal por um dia digitado errado. A ida e volta
 * pelo `Date.UTC` reprova 31/02 sem depender do parser de string.
 */
function isRealDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Janela aceita para o início do acordo: 24 meses atrás, 12 à frente.
 *
 * Não é preciosismo de validação: a geração preguiçosa cria uma cobrança por
 * competência entre `starts_on` e o mês seguinte ao corrente. Um ano digitado
 * errado (2016 no lugar de 2026) enche a ficha do aluno de dezenas de cobranças
 * vencidas — e cada uma delas pesa no motor de risco desde a Onda F3.
 */
const MAX_BACKDATE_MONTHS = 24;
const MAX_FUTURE_MONTHS = 12;

/** Texto livre: recusa o que não é string em vez de descartar em silêncio. */
function cleanNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail('invalid_notes', 400);
  return value.slice(0, 2000) || null;
}

/**
 * `checkStartWindow`: só vale para data que o cliente acabou de mandar. Na
 * edição, o acordo inteiro é revalidado com o `starts_on` que já está gravado —
 * e um acordo de três anos atrás não pode ficar impossível de editar por causa
 * de uma janela pensada para pegar erro de digitação.
 */
function normalizePlanInput(
  input: PlanInput,
  { checkStartWindow = true }: { checkStartWindow?: boolean } = {},
): Required<Omit<PlanInput, 'startsOn'>> & { startsOn: string } {
  const { priceCents, period } = input;

  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > MAX_PRICE_CENTS) {
    throw fail('invalid_price_cents', 400);
  }
  if (!(FINANCE_PERIODS as readonly string[]).includes(period)) {
    throw fail('invalid_period', 400);
  }

  const recurring = PERIOD_STEP_MONTHS[period] !== null;
  const dueDay = input.dueDay ?? null;
  if (recurring) {
    if (dueDay === null || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
      throw fail('invalid_due_day', 400);
    }
  } else if (dueDay !== null) {
    // O CHECK do banco aceitaria, mas guardar dia de vencimento num acordo de
    // cobrança única sugeriria uma recorrência que não existe.
    throw fail('due_day_not_allowed_for_period', 400);
  }

  const packageSessions = input.packageSessions ?? null;
  if (packageSessions !== null) {
    if (period !== 'package') throw fail('package_sessions_not_allowed_for_period', 400);
    if (!Number.isInteger(packageSessions) || packageSessions < 1 || packageSessions > 1000) {
      throw fail('invalid_package_sessions', 400);
    }
  }

  const paymentMethod = input.paymentMethod ?? null;
  if (paymentMethod !== null && !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    throw fail('invalid_payment_method', 400);
  }

  // Sem coerção: `autoRenew: 'nao'` é string, e string chegava ao `boolean` do
  // Postgres como erro de sintaxe (500). Ausente segue valendo "renova".
  const autoRenew = input.autoRenew ?? true;
  if (typeof autoRenew !== 'boolean') throw fail('invalid_auto_renew', 400);

  const today = dayKey();
  const startsOn = input.startsOn ?? today;
  if (typeof startsOn !== 'string' || !isRealDate(startsOn)) throw fail('invalid_starts_on', 400);
  const startYm = yearMonth(startsOn);
  if (
    checkStartWindow &&
    (startYm < addMonths(yearMonth(today), -MAX_BACKDATE_MONTHS) ||
      startYm > addMonths(yearMonth(today), MAX_FUTURE_MONTHS))
  ) {
    throw fail('starts_on_out_of_range', 400);
  }

  const endsOn = input.endsOn ?? null;
  if (endsOn !== null) {
    if (typeof endsOn !== 'string' || !isRealDate(endsOn)) throw fail('invalid_ends_on', 400);
    if (endsOn < startsOn) throw fail('ends_on_before_starts_on', 400);
  }

  return {
    priceCents,
    period,
    dueDay,
    packageSessions,
    autoRenew,
    paymentMethod,
    startsOn,
    endsOn,
    notes: cleanNotes(input.notes),
  };
}

/**
 * Cria o acordo do aluno, encerrando o anterior.
 *
 * Substituir em vez de editar mantém o histórico: a cobrança já emitida
 * continua apontando para o acordo sob o qual nasceu, com o preço da época.
 * O `UNIQUE` parcial `(personal_id, student_id) WHERE status='active'` garante
 * que só um vale por vez — daí o encerramento acontecer na MESMA transação.
 */
export async function createOrReplacePlan(
  personalId: number,
  studentId: number,
  actorId: number,
  input: PlanInput,
): Promise<FinancePlan> {
  const data = normalizePlanInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertAssigned(client, personalId, studentId);

    const { rows: previous } = await client.query<{ id: number }>(
      `UPDATE personal_financial_plans
          SET status = 'ended', ends_on = COALESCE(ends_on, CURRENT_DATE), updated_at = NOW()
        WHERE personal_id = $1 AND student_id = $2 AND status = 'active'
        RETURNING id`,
      [personalId, studentId],
    );
    for (const row of previous) {
      await recordEvent(client, {
        personalId,
        actorId,
        eventType: 'plan_ended',
        planId: row.id,
        payload: { reason: 'replaced_by_new_plan' },
      });
    }

    const { rows } = await client.query<any>(
      `INSERT INTO personal_financial_plans
         (personal_id, student_id, price_cents, period, due_day, package_sessions,
          auto_renew, payment_method, starts_on, ends_on, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11)
       RETURNING ${PLAN_COLUMNS}`,
      [
        personalId,
        studentId,
        data.priceCents,
        data.period,
        data.dueDay,
        data.packageSessions,
        data.autoRenew,
        data.paymentMethod,
        data.startsOn,
        data.endsOn,
        data.notes,
      ],
    );
    const plan = mapPlan(rows[0]);

    await recordEvent(client, {
      personalId,
      actorId,
      eventType: 'plan_created',
      planId: plan.id,
      payload: {
        studentId,
        priceCents: plan.priceCents,
        period: plan.period,
        dueDay: plan.dueDay,
      },
    });

    // Dentro da transação: o acordo nasce já com a cobrança do ciclo corrente,
    // e não existe janela em que a tela mostre "sem cobrança".
    await ensureCharges(personalId, client);

    await client.query('COMMIT');
    return plan;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Id do acordo vigente do aluno (ativo ou pausado).
 *
 * As rotas de edição recebem `studentId`, não `planId`: o acordo em vigor é um
 * só, e resolvê-lo aqui — já com `personal_id` no WHERE — remove a chance de
 * alguém editar acordo alheio informando um id.
 */
export async function getEditablePlanId(personalId: number, studentId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM personal_financial_plans
      WHERE personal_id = $1 AND student_id = $2 AND status <> 'ended'
      ORDER BY (status = 'active') DESC, created_at DESC
      LIMIT 1`,
    [personalId, studentId],
  );
  if (!rows[0]) throw fail('plan_not_found', 404);
  return rows[0].id;
}

/** Campos editáveis do acordo. `status` aceita apenas `active`/`paused`. */
export type UpdatePlanInput = Partial<PlanInput> & { status?: 'active' | 'paused' };

export async function updatePlan(
  personalId: number,
  planId: number,
  actorId: number,
  input: UpdatePlanInput,
): Promise<FinancePlan> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: current } = await client.query<any>(
      `SELECT ${PLAN_COLUMNS} FROM personal_financial_plans
        WHERE id = $1 AND personal_id = $2 FOR UPDATE`,
      [planId, personalId],
    );
    if (!current[0]) throw fail('plan_not_found', 404);
    const before = mapPlan(current[0]);
    if (before.status === 'ended') throw fail('plan_already_ended', 409);

    // Revalida o acordo INTEIRO, com os campos novos por cima dos antigos: um
    // PATCH que troque só o período precisa ser checado contra o `due_day` que
    // já estava lá.
    const merged = normalizePlanInput(
      {
        priceCents: input.priceCents ?? before.priceCents,
        period: input.period ?? before.period,
        dueDay: input.dueDay !== undefined ? input.dueDay : before.dueDay,
        packageSessions:
          input.packageSessions !== undefined ? input.packageSessions : before.packageSessions,
        autoRenew: input.autoRenew ?? before.autoRenew,
        paymentMethod: input.paymentMethod !== undefined ? input.paymentMethod : before.paymentMethod,
        startsOn: input.startsOn ?? before.startsOn,
        endsOn: input.endsOn !== undefined ? input.endsOn : before.endsOn,
        notes: input.notes !== undefined ? input.notes : before.notes,
      },
      { checkStartWindow: input.startsOn !== undefined && input.startsOn !== null },
    );

    const status = input.status ?? before.status;
    if (status !== 'active' && status !== 'paused') throw fail('invalid_status', 400);

    const { rows } = await client.query<any>(
      `UPDATE personal_financial_plans
          SET price_cents = $3, period = $4, due_day = $5, package_sessions = $6,
              auto_renew = $7, payment_method = $8, starts_on = $9::date,
              ends_on = $10::date, notes = $11, status = $12, updated_at = NOW()
        WHERE id = $1 AND personal_id = $2
        RETURNING ${PLAN_COLUMNS}`,
      [
        planId,
        personalId,
        merged.priceCents,
        merged.period,
        merged.dueDay,
        merged.packageSessions,
        merged.autoRenew,
        merged.paymentMethod,
        merged.startsOn,
        merged.endsOn,
        merged.notes,
        status,
      ],
    );
    const plan = mapPlan(rows[0]);

    await recordEvent(client, {
      personalId,
      actorId,
      eventType: status === 'paused' && before.status !== 'paused' ? 'plan_paused' : 'plan_updated',
      planId,
      payload: { before, after: plan },
    });

    await client.query('COMMIT');
    return plan;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function endPlan(
  personalId: number,
  planId: number,
  actorId: number,
): Promise<FinancePlan> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<any>(
      `UPDATE personal_financial_plans
          SET status = 'ended', ends_on = COALESCE(ends_on, CURRENT_DATE), updated_at = NOW()
        WHERE id = $1 AND personal_id = $2 AND status <> 'ended'
        RETURNING ${PLAN_COLUMNS}`,
      [planId, personalId],
    );
    if (!rows[0]) throw fail('plan_not_found', 404);

    await recordEvent(client, { personalId, actorId, eventType: 'plan_ended', planId });
    await client.query('COMMIT');
    return mapPlan(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

export type StudentsFinanceFilter = {
  status?: 'all' | 'overdue' | 'upcoming' | 'paid' | 'no_plan';
  q?: string;
};

/**
 * A carteira do personal sob a lente financeira.
 *
 * A base são os ALUNOS vinculados, não os acordos: quem ainda não tem acordo
 * precisa aparecer (é justamente a lista de "sem acordo"), e partir dos acordos
 * esconderia esse caso.
 */
export async function listStudentsFinance(
  personalId: number,
  filter: StudentsFinanceFilter = {},
): Promise<StudentFinanceRow[]> {
  await ensureCharges(personalId);
  const today = dayKey();
  const q = typeof filter.q === 'string' && filter.q.trim() ? `%${filter.q.trim()}%` : null;

  const { rows } = await pool.query<any>(
    `SELECT u.id AS student_id, u.name AS student_name, u.email AS student_email,
            u.phone AS student_phone,
            p.id AS p_id, p.student_id AS p_student_id, p.price_cents AS p_price_cents,
            p.period AS p_period, p.due_day AS p_due_day,
            p.package_sessions AS p_package_sessions, p.auto_renew AS p_auto_renew,
            p.payment_method AS p_payment_method, p.status AS p_status,
            to_char(p.starts_on,'YYYY-MM-DD') AS p_starts_on,
            to_char(p.ends_on,'YYYY-MM-DD')   AS p_ends_on,
            p.notes AS p_notes, p.created_at AS p_created_at, p.updated_at AS p_updated_at,
            c.id AS c_id, c.plan_id AS c_plan_id, c.student_id AS c_student_id,
            to_char(c.competence,'YYYY-MM-DD') AS c_competence,
            to_char(c.due_date,'YYYY-MM-DD')   AS c_due_date,
            c.amount_cents AS c_amount_cents, c.paid_cents AS c_paid_cents,
            c.status AS c_status, c.paid_at AS c_paid_at, c.paid_method AS c_paid_method,
            c.origin AS c_origin, c.notes AS c_notes, c.recorded_by AS c_recorded_by
       FROM personal_student_assignments psa
       JOIN users u ON u.id = psa.student_id
       LEFT JOIN personal_financial_plans p
              ON p.personal_id = psa.personal_id
             AND p.student_id  = psa.student_id
             AND p.status      = 'active'
       LEFT JOIN LATERAL (
            SELECT * FROM personal_financial_charges ch
             WHERE ch.plan_id = p.id
             ORDER BY (ch.status IN ('open','partial')) DESC,
                      CASE WHEN ch.status IN ('open','partial') THEN ch.due_date END ASC,
                      ch.due_date DESC
             LIMIT 1
       ) c ON TRUE
      WHERE psa.personal_id = $1
        AND psa.status = 'active'
        AND ($2::text IS NULL OR u.name ILIKE $2 OR u.email ILIKE $2)
      ORDER BY u.name NULLS LAST, u.id`,
    [personalId, q],
  );

  const list = rows.map<StudentFinanceRow>((row) => ({
    studentId: row.student_id,
    studentName: row.student_name,
    studentEmail: row.student_email,
    studentPhone: row.student_phone,
    plan: row.p_id
      ? mapPlan({
          id: row.p_id,
          student_id: row.p_student_id,
          price_cents: row.p_price_cents,
          period: row.p_period,
          due_day: row.p_due_day,
          package_sessions: row.p_package_sessions,
          auto_renew: row.p_auto_renew,
          payment_method: row.p_payment_method,
          status: row.p_status,
          starts_on: row.p_starts_on,
          ends_on: row.p_ends_on,
          notes: row.p_notes,
          created_at: row.p_created_at,
          updated_at: row.p_updated_at,
        })
      : null,
    currentCharge: row.c_id
      ? mapCharge(
          {
            id: row.c_id,
            plan_id: row.c_plan_id,
            student_id: row.c_student_id,
            competence: row.c_competence,
            due_date: row.c_due_date,
            amount_cents: row.c_amount_cents,
            paid_cents: row.c_paid_cents,
            status: row.c_status,
            paid_at: row.c_paid_at,
            paid_method: row.c_paid_method,
            origin: row.c_origin,
            notes: row.c_notes,
            recorded_by: row.c_recorded_by,
          },
          today,
        )
      : null,
  }));

  const status = filter.status ?? 'all';
  if (status === 'all') return list;
  if (status === 'no_plan') return list.filter((row) => row.plan === null);
  return list.filter((row) => row.currentCharge?.derivedStatus === status);
}

export async function getStudentFinance(
  personalId: number,
  studentId: number,
): Promise<{ plan: FinancePlan | null; charges: FinanceCharge[]; events: FinanceEvent[] }> {
  await ensureCharges(personalId);
  const today = dayKey();

  // O acordo ativo, ou o último encerrado — o aluno sem acordo vigente ainda
  // tem histórico a mostrar.
  const { rows: planRows } = await pool.query<any>(
    `SELECT ${PLAN_COLUMNS} FROM personal_financial_plans
      WHERE personal_id = $1 AND student_id = $2
      ORDER BY (status = 'active') DESC, created_at DESC
      LIMIT 1`,
    [personalId, studentId],
  );
  const plan = planRows[0] ? mapPlan(planRows[0]) : null;

  const { rows: chargeRows } = await pool.query<any>(
    `SELECT ${CHARGE_COLUMNS} FROM personal_financial_charges
      WHERE personal_id = $1 AND student_id = $2
        AND competence >= (date_trunc('month', $3::date) - INTERVAL '11 months')
      ORDER BY competence DESC`,
    [personalId, studentId, today],
  );

  const { rows: eventRows } = await pool.query<any>(
    `SELECT e.id, e.charge_id, e.plan_id, e.event_type, e.actor_id, e.payload_json, e.created_at
       FROM personal_financial_events e
       LEFT JOIN personal_financial_charges c ON c.id = e.charge_id
       LEFT JOIN personal_financial_plans   p ON p.id = e.plan_id
      WHERE e.personal_id = $1
        AND (c.student_id = $2 OR p.student_id = $2)
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 100`,
    [personalId, studentId],
  );

  return {
    plan,
    charges: chargeRows.map((row) => mapCharge(row, today)),
    events: eventRows.map((row) => ({
      id: row.id,
      chargeId: row.charge_id,
      planId: row.plan_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      payload: row.payload_json ?? {},
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export type FinanceKpis = {
  month: string;
  expectedCents: number;
  receivedCents: number;
  pendingCents: number;
  overdueCents: number;
  overdueStudents: number;
  upcomingRenewals: number;
  mrrCents: number;
};

/**
 * Quem cobra ação agora.
 *
 * Hoje só existe o motivo `payment_overdue`, derivado da própria cobrança. O
 * cruzamento com o motor de risco (frequência caindo, sem check-in) é da Onda
 * F3 — o campo já existe no contrato para a tela não precisar mudar depois.
 */
export type FinanceAttentionItem = {
  kind: 'payment_overdue';
  studentId: number;
  studentName: string | null;
  chargeId: number;
  dueDate: string;
  daysOverdue: number;
  amountCents: number;
};

/** Acordo que termina em breve — o que o personal precisa renegociar. */
export type FinanceRenewalItem = {
  studentId: number;
  studentName: string | null;
  dueDate: string;
  amountCents: number;
  period: FinancePeriod;
  autoRenew: boolean;
};

export type FinanceOverview = {
  kpis: FinanceKpis;
  attention: FinanceAttentionItem[];
  renewals: FinanceRenewalItem[];
};

/** Janela de "termina em breve", em dias. Vale para o KPI e para a lista. */
const RENEWAL_WINDOW_DAYS = 14;

/** Quantas pendências o cabeçalho mostra antes de mandar o personal para a lista. */
const ATTENTION_LIMIT = 5;

/**
 * KPIs do mês corrente.
 *
 * "Previsto" e "recebido" olham a **competência**, não a data do pagamento: o
 * personal compara o que aquele mês deveria render com o que rendeu, e um
 * pagamento atrasado de julho feito em agosto pertence a julho nessa leitura.
 * Isento e cancelado saem do previsto — não são dinheiro esperado.
 */
export async function getOverview(personalId: number): Promise<FinanceOverview> {
  await ensureCharges(personalId);
  const today = dayKey();
  const month = today.slice(0, 7);

  const { rows } = await pool.query<any>(
    `WITH mes AS (
       SELECT * FROM personal_financial_charges
        WHERE personal_id = $1
          AND date_trunc('month', competence) = date_trunc('month', $2::date)
     ),
     abertas AS (
       SELECT * FROM personal_financial_charges
        WHERE personal_id = $1 AND status IN ('open','partial')
     )
     SELECT
       (SELECT COALESCE(SUM(amount_cents),0) FROM mes
         WHERE status NOT IN ('canceled','waived'))                        AS expected_cents,
       (SELECT COALESCE(SUM(paid_cents),0) FROM mes)                       AS received_cents,
       (SELECT COALESCE(SUM(amount_cents - paid_cents),0) FROM abertas
         WHERE due_date >= $2::date)                                       AS pending_cents,
       (SELECT COALESCE(SUM(amount_cents - paid_cents),0) FROM abertas
         WHERE due_date < $2::date)                                        AS overdue_cents,
       (SELECT COUNT(DISTINCT student_id) FROM abertas
         WHERE due_date < $2::date)                                        AS overdue_students,
       (SELECT COALESCE(SUM(
                 CASE period
                   WHEN 'monthly'    THEN price_cents
                   WHEN 'quarterly'  THEN price_cents / 3
                   WHEN 'semiannual' THEN price_cents / 6
                   WHEN 'annual'     THEN price_cents / 12
                   ELSE 0
                 END), 0)
          FROM personal_financial_plans
         WHERE personal_id = $1 AND status = 'active')                     AS mrr_cents`,
    [personalId, today],
  );

  // Uma linha por aluno: quem tem três meses em aberto é UMA pendência, não
  // três. A escolhida é a mais antiga — a que mede o tamanho do atraso.
  const { rows: attentionRows } = await pool.query<any>(
    `WITH mais_antiga AS (
       SELECT DISTINCT ON (c.student_id)
              c.id, c.student_id, c.due_date, (c.amount_cents - c.paid_cents) AS open_cents
         FROM personal_financial_charges c
        WHERE c.personal_id = $1 AND c.status IN ('open','partial') AND c.due_date < $2::date
        ORDER BY c.student_id, c.due_date
     )
     SELECT m.id, m.student_id, u.name AS student_name, m.open_cents,
            to_char(m.due_date,'YYYY-MM-DD') AS due_date,
            ($2::date - m.due_date)          AS days_overdue
       FROM mais_antiga m
       JOIN users u ON u.id = m.student_id
      ORDER BY m.due_date
      LIMIT $3`,
    [personalId, today, ATTENTION_LIMIT],
  );

  // O fim do acordo é o vencimento da ÚLTIMA cobrança gerada — que só para de
  // avançar quando `auto_renew` é falso ou o período não se repete. Um acordo
  // com data de término anterior a isso termina antes, daí o `LEAST`.
  const { rows: renewalRows } = await pool.query<any>(
    `SELECT p.student_id, u.name AS student_name, p.price_cents, p.period, p.auto_renew,
            to_char(LEAST(MAX(c.due_date), COALESCE(p.ends_on, MAX(c.due_date))),
                    'YYYY-MM-DD') AS due_date
       FROM personal_financial_plans p
       JOIN users u ON u.id = p.student_id
       JOIN personal_financial_charges c ON c.plan_id = p.id
      WHERE p.personal_id = $1
        AND p.status = 'active'
        AND (p.auto_renew = false OR p.period IN ('package','single'))
      GROUP BY p.id, p.student_id, u.name, p.price_cents, p.period, p.auto_renew, p.ends_on
     HAVING LEAST(MAX(c.due_date), COALESCE(p.ends_on, MAX(c.due_date)))
              BETWEEN $2::date AND $2::date + $3::int
      ORDER BY LEAST(MAX(c.due_date), COALESCE(p.ends_on, MAX(c.due_date)))`,
    [personalId, today, RENEWAL_WINDOW_DAYS],
  );

  const renewals = renewalRows.map<FinanceRenewalItem>((r) => ({
    studentId: r.student_id,
    studentName: r.student_name,
    dueDate: r.due_date,
    amountCents: Number(r.price_cents),
    period: r.period,
    autoRenew: r.auto_renew,
  }));

  const row = rows[0];
  return {
    kpis: {
      month,
      expectedCents: Number(row.expected_cents),
      receivedCents: Number(row.received_cents),
      pendingCents: Number(row.pending_cents),
      overdueCents: Number(row.overdue_cents),
      overdueStudents: Number(row.overdue_students),
      // O número sai da MESMA consulta da lista: um KPI que dissesse "3" com a
      // seção de renovações vazia leria como bug da tela.
      upcomingRenewals: renewals.length,
      mrrCents: Number(row.mrr_cents),
    },
    attention: attentionRows.map<FinanceAttentionItem>((r) => ({
      kind: 'payment_overdue',
      studentId: r.student_id,
      studentName: r.student_name,
      chargeId: r.id,
      dueDate: r.due_date,
      daysOverdue: Number(r.days_overdue),
      amountCents: Number(r.open_cents),
    })),
    renewals,
  };
}

export type HistoryPoint = { month: string; expectedCents: number; receivedCents: number };

/** Série previsto × recebido por competência, do mês mais antigo ao corrente. */
export async function getHistory(personalId: number, months = 6): Promise<HistoryPoint[]> {
  await ensureCharges(personalId);
  const today = dayKey();
  const span = Math.min(Math.max(Math.trunc(months) || 6, 1), 24);

  const { rows } = await pool.query<any>(
    `SELECT to_char(m.mes,'YYYY-MM') AS month,
            COALESCE(SUM(c.amount_cents) FILTER (WHERE c.status NOT IN ('canceled','waived')), 0) AS expected_cents,
            COALESCE(SUM(c.paid_cents), 0) AS received_cents
       FROM generate_series(
              date_trunc('month', $2::date) - make_interval(months => $3::int - 1),
              date_trunc('month', $2::date),
              INTERVAL '1 month'
            ) AS m(mes)
       LEFT JOIN personal_financial_charges c
              ON c.personal_id = $1
             AND date_trunc('month', c.competence) = m.mes
      GROUP BY m.mes
      ORDER BY m.mes`,
    [personalId, today, span],
  );

  return rows.map((row) => ({
    month: row.month,
    expectedCents: Number(row.expected_cents),
    receivedCents: Number(row.received_cents),
  }));
}

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------

/**
 * Carrega a cobrança do personal com a linha travada.
 *
 * O `FOR UPDATE` existe porque o registro de pagamento SOMA sobre `paid_cents`:
 * dois toques simultâneos em "marcar como pago" sem trava gravariam o dobro.
 */
async function lockCharge(db: Executor, personalId: number, chargeId: number): Promise<any> {
  const { rows } = await db.query<any>(
    `SELECT ${CHARGE_COLUMNS} FROM personal_financial_charges
      WHERE id = $1 AND personal_id = $2 FOR UPDATE`,
    [chargeId, personalId],
  );
  if (!rows[0]) throw fail('charge_not_found', 404);
  return rows[0];
}

export type PayChargeInput = {
  paidCents?: number | null;
  paidAt?: string | null;
  paidMethod?: PaymentMethod | null;
  notes?: string | null;
};

export async function payCharge(
  personalId: number,
  chargeId: number,
  actorId: number,
  input: PayChargeInput = {},
): Promise<FinanceCharge> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockCharge(client, personalId, chargeId);
    if (current.status !== 'open' && current.status !== 'partial') {
      throw fail('charge_not_payable', 409);
    }

    const remaining = current.amount_cents - current.paid_cents;
    const amount = input.paidCents ?? remaining;
    // Zero só é aceito quando não há o que pagar (acordo isento): fora disso
    // seria um "pagamento" que não move nada e polui o ledger.
    if (!Number.isInteger(amount) || amount < 0 || (amount === 0 && remaining > 0)) {
      throw fail('invalid_paid_cents', 400);
    }
    if (amount > remaining) throw fail('paid_cents_exceeds_remaining', 400);

    const paidMethod = input.paidMethod ?? null;
    if (paidMethod !== null && !(PAYMENT_METHODS as readonly string[]).includes(paidMethod)) {
      throw fail('invalid_payment_method', 400);
    }
    // `Date.parse` aceita número por coerção ('12345' vira uma data válida), e
    // o registro sairia com data que ninguém pediu: o tipo entra na checagem.
    if (input.paidAt != null && (typeof input.paidAt !== 'string' || Number.isNaN(Date.parse(input.paidAt)))) {
      throw fail('invalid_paid_at', 400);
    }

    const totalPaid = current.paid_cents + amount;
    // Acordo isento (`price_cents = 0`) fecha como pago no primeiro registro —
    // sem isso ficaria eternamente `partial` de zero reais.
    const status: ChargeStatus = totalPaid >= current.amount_cents ? 'paid' : 'partial';
    const notes = cleanNotes(input.notes);

    const { rows } = await client.query<any>(
      `UPDATE personal_financial_charges
          SET paid_cents = $3, status = $4, paid_at = COALESCE($5::timestamptz, NOW()),
              paid_method = COALESCE($6, paid_method),
              notes = COALESCE($7, notes),
              recorded_by = $8, updated_at = NOW()
        WHERE id = $1 AND personal_id = $2
        RETURNING ${CHARGE_COLUMNS}`,
      [chargeId, personalId, totalPaid, status, input.paidAt ?? null, paidMethod, notes, actorId],
    );

    await recordEvent(client, {
      personalId,
      actorId,
      eventType: 'payment_recorded',
      chargeId,
      planId: current.plan_id,
      payload: {
        amountCents: amount,
        totalPaidCents: totalPaid,
        chargeAmountCents: current.amount_cents,
        paidMethod,
        status,
      },
    });

    await client.query('COMMIT');
    refreshDashboard(current.student_id);
    return mapCharge(rows[0], dayKey());
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Desfaz o pagamento: a cobrança volta a `open` e o valor recebido zera.
 *
 * A linha NÃO é apagada e o evento anterior permanece — o estorno é um evento a
 * mais na trilha, que é o que torna o ledger auditável.
 */
export async function revertPayment(
  personalId: number,
  chargeId: number,
  actorId: number,
): Promise<FinanceCharge> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockCharge(client, personalId, chargeId);
    if (current.status !== 'paid' && current.status !== 'partial') {
      throw fail('charge_not_reversible', 409);
    }

    const { rows } = await client.query<any>(
      `UPDATE personal_financial_charges
          SET status = 'open', paid_cents = 0, paid_at = NULL, paid_method = NULL,
              recorded_by = NULL, updated_at = NOW()
        WHERE id = $1 AND personal_id = $2
        RETURNING ${CHARGE_COLUMNS}`,
      [chargeId, personalId],
    );

    await recordEvent(client, {
      personalId,
      actorId,
      eventType: 'payment_reverted',
      chargeId,
      planId: current.plan_id,
      payload: {
        previousStatus: current.status,
        revertedCents: current.paid_cents,
        previousPaidAt: current.paid_at ? new Date(current.paid_at).toISOString() : null,
      },
    });

    await client.query('COMMIT');
    // O estorno devolve a cobrança a `open` — pode reacender o sinal de atraso.
    refreshDashboard(current.student_id);
    return mapCharge(rows[0], dayKey());
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** `waived` (isento) e `canceled` são terminais: só saem de `open`/`partial`. */
async function closeCharge(
  personalId: number,
  chargeId: number,
  actorId: number,
  target: 'waived' | 'canceled',
  notes?: string | null,
): Promise<FinanceCharge> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockCharge(client, personalId, chargeId);
    if (current.status !== 'open' && current.status !== 'partial') {
      throw fail('charge_not_open', 409);
    }

    const clean = cleanNotes(notes);
    const { rows } = await client.query<any>(
      `UPDATE personal_financial_charges
          SET status = $3, notes = COALESCE($4, notes), updated_at = NOW()
        WHERE id = $1 AND personal_id = $2
        RETURNING ${CHARGE_COLUMNS}`,
      [chargeId, personalId, target, clean],
    );

    await recordEvent(client, {
      personalId,
      actorId,
      eventType: target === 'waived' ? 'charge_waived' : 'charge_canceled',
      chargeId,
      planId: current.plan_id,
      payload: { previousStatus: current.status, notes: clean },
    });

    await client.query('COMMIT');
    // Isentar/cancelar tira a cobrança de `open`: o atraso deixa de pesar no risco.
    refreshDashboard(current.student_id);
    return mapCharge(rows[0], dayKey());
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function waiveCharge(
  personalId: number,
  chargeId: number,
  actorId: number,
  notes?: string | null,
): Promise<FinanceCharge> {
  return closeCharge(personalId, chargeId, actorId, 'waived', notes);
}

export function cancelCharge(
  personalId: number,
  chargeId: number,
  actorId: number,
): Promise<FinanceCharge> {
  return closeCharge(personalId, chargeId, actorId, 'canceled');
}
