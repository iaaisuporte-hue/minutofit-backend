import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';
import type { ProfessionalRole } from './consentService';

export type OfferingPeriod = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type OfferingStatus = 'active' | 'archived';

export interface ProfessionalOffering {
  id: string;
  professionalId: number;
  professionalRole: ProfessionalRole;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  period: OfferingPeriod;
  status: OfferingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOfferingInput {
  title: string;
  description?: string | null;
  priceCents: number;
  period: OfferingPeriod;
}

export interface UpdateOfferingInput {
  title?: string;
  description?: string | null;
  priceCents?: number;
  period?: OfferingPeriod;
}

const MAX_ACTIVE_OFFERINGS = 5;

const VALID_PERIODS: OfferingPeriod[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

function fail(status: number, error: string, details?: unknown): never {
  throw Object.assign(new Error(error), { status, details });
}

function validateInput(input: CreateOfferingInput | UpdateOfferingInput): void {
  if ('title' in input && input.title !== undefined) {
    const t = String(input.title).trim();
    if (t.length === 0 || t.length > 120) fail(400, 'validation_failed', { title: ['min 1, max 120'] });
  }
  if ('description' in input && input.description != null) {
    if (String(input.description).length > 400) fail(400, 'validation_failed', { description: ['max 400'] });
  }
  if ('priceCents' in input && input.priceCents !== undefined) {
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      fail(400, 'validation_failed', { priceCents: ['must be integer >= 0'] });
    }
  }
  if ('period' in input && input.period !== undefined && !VALID_PERIODS.includes(input.period)) {
    fail(400, 'validation_failed', { period: [`must be one of ${VALID_PERIODS.join(',')}`] });
  }
}

function mapRow(row: Record<string, unknown>): ProfessionalOffering {
  return {
    id: row.id as string,
    professionalId: row.professional_id as number,
    professionalRole: row.professional_role as ProfessionalRole,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    priceCents: row.price_cents as number,
    currency: row.currency as string,
    period: row.period as OfferingPeriod,
    status: row.status as OfferingStatus,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listOwnOfferings(professionalId: number): Promise<ProfessionalOffering[]> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_service_offerings
     WHERE professional_id = $1
     ORDER BY status ASC, created_at DESC`,
    [professionalId]
  );
  return rows.map(mapRow);
}

export async function listPublicOfferings(professionalId: number): Promise<ProfessionalOffering[]> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_service_offerings
     WHERE professional_id = $1 AND status = 'active'
     ORDER BY price_cents ASC`,
    [professionalId]
  );
  return rows.map(mapRow);
}

export async function getOffering(offeringId: string): Promise<ProfessionalOffering | null> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_service_offerings WHERE id = $1 LIMIT 1`,
    [offeringId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createOffering(opts: {
  professionalId: number;
  professionalRole: ProfessionalRole;
  input: CreateOfferingInput;
  ip?: string;
}): Promise<ProfessionalOffering> {
  validateInput(opts.input);

  const { rows: activeRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM professional_service_offerings
     WHERE professional_id = $1 AND status = 'active'`,
    [opts.professionalId]
  );
  if ((activeRows[0]?.n ?? 0) >= MAX_ACTIVE_OFFERINGS) {
    fail(409, 'max_active_offerings_reached', { limit: MAX_ACTIVE_OFFERINGS });
  }

  const { rows } = await pool.query(
    `INSERT INTO professional_service_offerings
       (professional_id, professional_role, title, description, price_cents, period)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      opts.professionalId,
      opts.professionalRole,
      opts.input.title.trim(),
      opts.input.description ?? null,
      opts.input.priceCents,
      opts.input.period,
    ]
  );
  const offering = mapRow(rows[0]);

  await logDataAccessEvent({
    actorId: opts.professionalId,
    subjectUserId: opts.professionalId,
    eventType: 'offering.created',
    eventPayload: { offeringId: offering.id, priceCents: offering.priceCents, period: offering.period },
    ip: opts.ip,
  });

  return offering;
}

export async function updateOffering(opts: {
  offeringId: string;
  professionalId: number;
  input: UpdateOfferingInput;
  ip?: string;
}): Promise<ProfessionalOffering> {
  validateInput(opts.input);

  const existing = await getOffering(opts.offeringId);
  if (!existing || existing.professionalId !== opts.professionalId) {
    fail(404, 'offering_not_found');
  }
  if (existing.status === 'archived') {
    fail(409, 'offering_archived');
  }

  if (opts.input.priceCents !== undefined && opts.input.priceCents !== existing.priceCents) {
    const { rows: subs } = await pool.query(
      `SELECT 1 FROM professional_subscriptions
       WHERE offering_id = $1 AND status IN ('pending_payment','active','paused')
       LIMIT 1`,
      [opts.offeringId]
    );
    if (subs.length > 0) {
      fail(400, 'cannot_edit_active_price');
    }
  }

  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let i = 1;
  if (opts.input.title !== undefined) {
    sets.push(`title = $${i++}`);
    values.push(opts.input.title.trim());
  }
  if (opts.input.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(opts.input.description);
  }
  if (opts.input.priceCents !== undefined) {
    sets.push(`price_cents = $${i++}`);
    values.push(opts.input.priceCents);
  }
  if (opts.input.period !== undefined) {
    sets.push(`period = $${i++}`);
    values.push(opts.input.period);
  }

  values.push(opts.offeringId, opts.professionalId);
  const { rows } = await pool.query(
    `UPDATE professional_service_offerings
     SET ${sets.join(', ')}
     WHERE id = $${i++} AND professional_id = $${i++}
     RETURNING *`,
    values
  );
  const offering = mapRow(rows[0]);

  await logDataAccessEvent({
    actorId: opts.professionalId,
    subjectUserId: opts.professionalId,
    eventType: 'offering.updated',
    eventPayload: { offeringId: offering.id, changes: opts.input },
    ip: opts.ip,
  });

  return offering;
}

export async function archiveOffering(opts: {
  offeringId: string;
  professionalId: number;
  ip?: string;
}): Promise<ProfessionalOffering> {
  const { rows } = await pool.query(
    `UPDATE professional_service_offerings
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND professional_id = $2 AND status = 'active'
     RETURNING *`,
    [opts.offeringId, opts.professionalId]
  );
  if (rows.length === 0) fail(404, 'offering_not_found_or_already_archived');

  const offering = mapRow(rows[0]);
  await logDataAccessEvent({
    actorId: opts.professionalId,
    subjectUserId: opts.professionalId,
    eventType: 'offering.archived',
    eventPayload: { offeringId: offering.id },
    ip: opts.ip,
  });
  return offering;
}
