/**
 * S2CORE NUTRI P1 (Spec 040) — suplementação nutricional.
 *
 * Orientação (nutri) e uso (aluno) são entidades separadas e nunca se
 * misturam com o diário alimentar: o uso não tem nutrientes e não toca
 * `user_nutrition_intake_logs` — registrar que tomou não soma macro nem
 * conta como refeição.
 *
 * `parseSupplementInput` é a única validação de forma/limite; os CHECKs da
 * migration 1846 repetem os limites como última barreira. Autorização
 * (vínculo, consent, dono) é das rotas e das cláusulas `patient_id = $x`
 * que TODA query por id carrega aqui.
 */
import pool from '../config/database';
import { dayKey, shiftDayKey } from '../utils/appDay';

export const DOSE_UNITS = ['g', 'mg', 'mcg', 'ml', 'ui', 'capsule', 'tablet', 'scoop', 'drops', 'sachet', 'dose'] as const;
export const FREQUENCIES = ['daily', 'twice_daily', 'three_times_daily', 'weekly', 'as_needed', 'other'] as const;
export const STATUSES = ['active', 'suspended', 'ended'] as const;

export type DoseUnit = (typeof DOSE_UNITS)[number];
export type Frequency = (typeof FREQUENCIES)[number];
export type SupplementStatus = (typeof STATUSES)[number];

const LIMITS = {
  name: 120,
  frequencyDetail: 80,
  timing: 80,
  purpose: 200,
  notes: 1000,
  usageNote: 200,
  clientKey: 64,
  doseMax: 10000,
} as const;

export interface SupplementFields {
  name: string;
  doseAmount: number;
  doseUnit: DoseUnit;
  frequency: Frequency;
  frequencyDetail: string | null;
  timing: string | null;
  purpose: string | null;
  notes: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface Supplement extends SupplementFields {
  id: number;
  status: SupplementStatus;
  statusChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string | null;
}

export class SupplementValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = 'SupplementValidationError';
  }
}
export class SupplementNotFoundError extends Error {}
export class SupplementConflictError extends Error {}

type Body = Record<string, unknown>;

function asBody(input: unknown): Body {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupplementValidationError('body', 'Corpo da requisição inválido');
  }
  return input as Body;
}

function optionalText(body: Body, field: string, max: number, label: string): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new SupplementValidationError(field, `${label} deve ser texto`);
  const trimmed = raw.trim();
  if (trimmed.length > max) throw new SupplementValidationError(field, `${label} com no máximo ${max} caracteres`);
  return trimmed.length > 0 ? trimmed : null;
}

function optionalDate(body: Body, field: string, label: string): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new SupplementValidationError(field, `${label} deve estar no formato AAAA-MM-DD`);
  }
  // Recusa data inexistente ("2026-02-31") em vez de deixar o Postgres
  // estourar 500 ou normalizar para outro dia (lição do Financeiro F4).
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new SupplementValidationError(field, `${label} inválida`);
  }
  return raw;
}

const FIELD_PARSERS: Record<keyof SupplementFields, (b: Body) => unknown> = {
  name: (b) => {
    const v = optionalText(b, 'name', LIMITS.name, 'Nome');
    if (!v) throw new SupplementValidationError('name', 'Informe o nome do suplemento');
    return v;
  },
  doseAmount: (b) => {
    const v = b.doseAmount;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new SupplementValidationError('doseAmount', 'Quantidade deve ser um número');
    }
    if (v <= 0 || v > LIMITS.doseMax) {
      throw new SupplementValidationError('doseAmount', `Quantidade deve ser maior que 0 e no máximo ${LIMITS.doseMax}`);
    }
    return Math.round(v * 100) / 100;
  },
  doseUnit: (b) => {
    if (!(DOSE_UNITS as readonly unknown[]).includes(b.doseUnit)) {
      throw new SupplementValidationError('doseUnit', 'Unidade inválida');
    }
    return b.doseUnit;
  },
  frequency: (b) => {
    if (!(FREQUENCIES as readonly unknown[]).includes(b.frequency)) {
      throw new SupplementValidationError('frequency', 'Frequência inválida');
    }
    return b.frequency;
  },
  frequencyDetail: (b) => optionalText(b, 'frequencyDetail', LIMITS.frequencyDetail, 'Detalhe da frequência'),
  timing: (b) => optionalText(b, 'timing', LIMITS.timing, 'Horário sugerido'),
  purpose: (b) => optionalText(b, 'purpose', LIMITS.purpose, 'Finalidade'),
  notes: (b) => optionalText(b, 'notes', LIMITS.notes, 'Observações'),
  startDate: (b) => optionalDate(b, 'startDate', 'Data de início'),
  endDate: (b) => optionalDate(b, 'endDate', 'Data de término'),
};

function checkDates(fields: Pick<SupplementFields, 'startDate' | 'endDate'>) {
  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) {
    throw new SupplementValidationError('endDate', 'A data de término não pode ser anterior à de início');
  }
}

/** Criação: todos os campos obrigatórios presentes; opcionais ausentes = null. */
export function parseSupplementInput(input: unknown): SupplementFields {
  const body = asBody(input);
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(FIELD_PARSERS) as (keyof SupplementFields)[]) {
    out[key] = FIELD_PARSERS[key](body);
  }
  const fields = out as unknown as SupplementFields;
  checkDates(fields);
  return fields;
}

/** Edição: só valida e devolve o que veio no corpo (+ `status`, se veio). */
export function parseSupplementPatch(input: unknown): { fields: Partial<SupplementFields>; status: SupplementStatus | null } {
  const body = asBody(input);
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(FIELD_PARSERS) as (keyof SupplementFields)[]) {
    if (key in body) fields[key] = FIELD_PARSERS[key](body);
  }
  let status: SupplementStatus | null = null;
  if ('status' in body) {
    if (!(STATUSES as readonly unknown[]).includes(body.status)) {
      throw new SupplementValidationError('status', 'Status inválido');
    }
    status = body.status as SupplementStatus;
  }
  if (Object.keys(fields).length === 0 && status === null) {
    throw new SupplementValidationError('body', 'Nada para atualizar');
  }
  return { fields: fields as Partial<SupplementFields>, status };
}

const COLUMN: Record<keyof SupplementFields, string> = {
  name: 'name',
  doseAmount: 'dose_amount',
  doseUnit: 'dose_unit',
  frequency: 'frequency',
  frequencyDetail: 'frequency_detail',
  timing: 'timing',
  purpose: 'purpose',
  notes: 'notes',
  startDate: 'start_date',
  endDate: 'end_date',
};

const dateOnly = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v as Date;
  // `pg` devolve DATE como Date à meia-noite LOCAL — montar a string pelos
  // campos locais evita voltar um dia em fuso negativo.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

function rowToSupplement(r: any): Supplement {
  return {
    id: r.id,
    name: r.name,
    doseAmount: Number(r.dose_amount),
    doseUnit: r.dose_unit,
    frequency: r.frequency,
    frequencyDetail: r.frequency_detail ?? null,
    timing: r.timing ?? null,
    purpose: r.purpose ?? null,
    notes: r.notes ?? null,
    startDate: dateOnly(r.start_date),
    endDate: dateOnly(r.end_date),
    status: r.status,
    statusChangedAt: iso(r.status_changed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    updatedByName: r.updated_by_name ?? null,
  };
}

/** `extraColumns`: colunas de um LATERAL juntado depois — sem projetá-las aqui, o LATERAL calcula e o resultado some. */
const selectSupplement = (extraColumns = '') => `
  SELECT s.*, u.name AS updated_by_name${extraColumns ? `, ${extraColumns}` : ''}
    FROM nutrition_supplement_prescriptions s
    LEFT JOIN users u ON u.id = s.updated_by`;

/** Ativas primeiro, depois suspensas, depois encerradas; mais recentes antes. */
const ORDER = `ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END, s.updated_at DESC, s.id DESC`;

async function getOwned(patientId: number, supplementId: number): Promise<Supplement> {
  const { rows } = await pool.query(`${selectSupplement()} WHERE s.id = $1 AND s.patient_id = $2`, [supplementId, patientId]);
  if (!rows[0]) throw new SupplementNotFoundError();
  return rowToSupplement(rows[0]);
}

// ── Nutri ────────────────────────────────────────────────────────────────

export interface UsageSummary {
  lastUsedAt: string | null;
  count7d: number;
}

export async function listSupplementsForNutri(patientId: number): Promise<Array<Supplement & { usage: UsageSummary }>> {
  const since = shiftDayKey(dayKey(), -6);
  const { rows } = await pool.query(
    `${selectSupplement('usage.last_used_at, usage.count_7d')}
     LEFT JOIN LATERAL (
       SELECT MAX(l.taken_at) AS last_used_at,
              COUNT(*) FILTER (WHERE l.date_key >= $2::date)::int AS count_7d
         FROM nutrition_supplement_usage_logs l
        WHERE l.prescription_id = s.id AND l.patient_id = s.patient_id AND l.deleted_at IS NULL
     ) usage ON TRUE
     WHERE s.patient_id = $1
     ${ORDER}`,
    [patientId, since]
  );
  return rows.map((r) => ({
    ...rowToSupplement(r),
    usage: { lastUsedAt: iso(r.last_used_at), count7d: Number(r.count_7d ?? 0) },
  }));
}

export async function createSupplement(patientId: number, nutriId: number, fields: SupplementFields): Promise<Supplement> {
  const { rows } = await pool.query(
    `INSERT INTO nutrition_supplement_prescriptions
       (patient_id, created_by, updated_by, name, dose_amount, dose_unit, frequency, frequency_detail,
        timing, purpose, notes, start_date, end_date)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      patientId, nutriId, fields.name, fields.doseAmount, fields.doseUnit, fields.frequency,
      fields.frequencyDetail, fields.timing, fields.purpose, fields.notes, fields.startDate, fields.endDate,
    ]
  );
  return getOwned(patientId, rows[0].id);
}

/**
 * Transições: ativa ↔ suspensa; qualquer → encerrada. Encerrada é terminal
 * (nem edição nem reativação) — reabrir seria reescrever um histórico que o
 * aluno já viu encerrado; o caminho é criar uma orientação nova.
 */
export async function updateSupplement(
  patientId: number,
  supplementId: number,
  nutriId: number,
  patch: { fields: Partial<SupplementFields>; status: SupplementStatus | null }
): Promise<Supplement> {
  const current = await getOwned(patientId, supplementId);
  if (current.status === 'ended') {
    throw new SupplementConflictError('Orientação encerrada não pode ser alterada');
  }
  checkDates({
    startDate: 'startDate' in patch.fields ? patch.fields.startDate ?? null : current.startDate,
    endDate: 'endDate' in patch.fields ? patch.fields.endDate ?? null : current.endDate,
  });

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch.fields) as [keyof SupplementFields, unknown][]) {
    params.push(value);
    sets.push(`${COLUMN[key]} = $${params.length}`);
  }
  if (patch.status && patch.status !== current.status) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`, 'status_changed_at = NOW()');
  }
  params.push(nutriId);
  sets.push(`updated_by = $${params.length}`, 'updated_at = NOW()');
  params.push(supplementId, patientId);
  await pool.query(
    `UPDATE nutrition_supplement_prescriptions SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND patient_id = $${params.length}`,
    params
  );
  return getOwned(patientId, supplementId);
}

// ── Aluno ────────────────────────────────────────────────────────────────

export interface UsageLog {
  id: number;
  supplementId: number;
  supplementName: string;
  dateKey: string;
  takenAt: string;
  note: string | null;
}

function rowToLog(r: any): UsageLog {
  return {
    id: r.id,
    supplementId: r.prescription_id,
    supplementName: r.supplement_name,
    dateKey: dateOnly(r.date_key)!,
    takenAt: iso(r.taken_at)!,
    note: r.note ?? null,
  };
}

const SELECT_LOG = `
  SELECT l.*, s.name AS supplement_name
    FROM nutrition_supplement_usage_logs l
    JOIN nutrition_supplement_prescriptions s ON s.id = l.prescription_id`;

export async function getSupplementsForStudent(userId: number): Promise<{
  supplements: Array<Supplement & { usedTodayCount: number }>;
  recentLogs: UsageLog[];
}> {
  const today = dayKey();
  const [supRes, logRes] = await Promise.all([
    pool.query(
      `${selectSupplement('t.used_today')}
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS used_today
           FROM nutrition_supplement_usage_logs l
          WHERE l.prescription_id = s.id AND l.patient_id = s.patient_id
            AND l.deleted_at IS NULL AND l.date_key = $2::date
       ) t ON TRUE
       WHERE s.patient_id = $1 AND s.status = 'active'
       ${ORDER}`,
      [userId, today]
    ),
    pool.query(
      `${SELECT_LOG}
        WHERE l.patient_id = $1 AND l.deleted_at IS NULL AND l.date_key >= $2::date
        ORDER BY l.taken_at DESC, l.id DESC
        LIMIT 20`,
      [userId, shiftDayKey(today, -13)]
    ),
  ]);
  return {
    supplements: supRes.rows.map((r) => ({ ...rowToSupplement(r), usedTodayCount: Number(r.used_today ?? 0) })),
    recentLogs: logRes.rows.map(rowToLog),
  };
}

export function parseUsageInput(input: unknown): { clientKey: string | null; note: string | null } {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? (input as Body) : {};
  const note = optionalText(body, 'note', LIMITS.usageNote, 'Observação');
  let clientKey: string | null = null;
  if (body.clientKey !== undefined && body.clientKey !== null) {
    if (typeof body.clientKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientKey)) {
      throw new SupplementValidationError('clientKey', 'clientKey inválida');
    }
    clientKey = body.clientKey;
  }
  return { clientKey, note };
}

/**
 * Idempotente por `clientKey`: reenvio (duplo toque, retry de rede) devolve
 * o MESMO registro com `created: false`, nunca uma segunda linha.
 */
export async function logSupplementUsage(
  userId: number,
  supplementId: number,
  input: { clientKey: string | null; note: string | null }
): Promise<{ log: UsageLog; created: boolean }> {
  const supplement = await getOwned(userId, supplementId);

  if (input.clientKey) {
    const existing = await pool.query(`${SELECT_LOG} WHERE l.patient_id = $1 AND l.client_key = $2`, [userId, input.clientKey]);
    if (existing.rows[0]) return { log: rowToLog(existing.rows[0]), created: false };
  }
  if (supplement.status !== 'active') {
    throw new SupplementConflictError('Só é possível registrar uso de orientação ativa');
  }

  const inserted = await pool.query(
    `INSERT INTO nutrition_supplement_usage_logs (prescription_id, patient_id, date_key, note, client_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (patient_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [supplementId, userId, dayKey(), input.note, input.clientKey]
  );
  if (!inserted.rows[0]) {
    // Corrida entre dois envios simultâneos com a mesma chave: o outro venceu.
    const winner = await pool.query(`${SELECT_LOG} WHERE l.patient_id = $1 AND l.client_key = $2`, [userId, input.clientKey]);
    return { log: rowToLog(winner.rows[0]), created: false };
  }
  const { rows } = await pool.query(`${SELECT_LOG} WHERE l.id = $1`, [inserted.rows[0].id]);
  return { log: rowToLog(rows[0]), created: true };
}

/** Desfazer: só o próprio registro e só no dia corrente (o passado não se reescreve). */
export async function undoSupplementUsage(userId: number, logId: number): Promise<'ok' | 'not_found' | 'not_today'> {
  const { rows } = await pool.query(
    `SELECT date_key FROM nutrition_supplement_usage_logs WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
    [logId, userId]
  );
  if (!rows[0]) return 'not_found';
  if (dateOnly(rows[0].date_key) !== dayKey()) return 'not_today';
  await pool.query(`UPDATE nutrition_supplement_usage_logs SET deleted_at = NOW() WHERE id = $1 AND patient_id = $2`, [logId, userId]);
  return 'ok';
}
