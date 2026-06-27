import pool from '../config/database';
import { auditLog } from '../utils/auditLog';

/**
 * Spec 017 — CRUD de Unidades/Filiais. Tudo escopado por academy_id (tenant).
 * Sem exclusão física: usar status 'inactive' (soft). Uma unidade principal por
 * academia (índice parcial uq_academy_units_primary). A principal deve estar ativa.
 */

export interface AcademyUnit {
  id: number;
  academyId: number;
  name: string;
  address: string | null;
  status: 'active' | 'inactive';
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

function mapUnit(row: any): AcademyUnit {
  return {
    id:        row.id,
    academyId: row.academy_id,
    name:      row.name,
    address:   row.address ?? null,
    status:    row.status,
    isPrimary: Boolean(row.is_primary),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function err(message: string, code: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim();
  if (n.length < 2) throw err('Nome da unidade é obrigatório (mín. 2 caracteres).', 'INVALID_NAME');
  if (n.length > 255) throw err('Nome da unidade muito longo (máx. 255).', 'INVALID_NAME');
  return n;
}

function cleanAddress(address: unknown): string | null {
  if (address == null) return null;
  const a = String(address).trim();
  if (a === '') return null;
  if (a.length > 500) throw err('Endereço muito longo (máx. 500).', 'INVALID_ADDRESS');
  return a;
}

export async function listUnits(academyId: number, includeInactive = false): Promise<AcademyUnit[]> {
  const res = await pool.query(
    `SELECT * FROM academy_units
      WHERE academy_id = $1 ${includeInactive ? '' : "AND status = 'active'"}
      ORDER BY is_primary DESC, name ASC`,
    [academyId]
  );
  return res.rows.map(mapUnit);
}

export async function getUnit(academyId: number, unitId: number): Promise<AcademyUnit> {
  const res = await pool.query(
    `SELECT * FROM academy_units WHERE id = $1 AND academy_id = $2`,
    [unitId, academyId]
  );
  if (res.rows.length === 0) throw err('Unidade não encontrada.', 'UNIT_NOT_FOUND');
  return mapUnit(res.rows[0]);
}

export async function createUnit(
  academyId: number,
  actorUserId: number,
  params: { name: string; address?: string | null }
): Promise<AcademyUnit> {
  const name = cleanName(params.name);
  const address = cleanAddress(params.address);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1ª unidade da academia vira principal automaticamente.
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM academy_units WHERE academy_id = $1`,
      [academyId]
    );
    const isPrimary = Number(countRes.rows[0]?.c ?? 0) === 0;

    const res = await client.query(
      `INSERT INTO academy_units (academy_id, name, address, status, is_primary)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING *`,
      [academyId, name, address, isPrimary]
    );
    await client.query('COMMIT');

    const unit = mapUnit(res.rows[0]);
    await auditLog(pool, {
      academyId, userId: actorUserId, action: 'unit.created',
      entityType: 'unit', entityId: unit.id, meta: { name, isPrimary },
    });
    return unit;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateUnit(
  academyId: number,
  actorUserId: number,
  unitId: number,
  params: { name?: string; address?: string | null }
): Promise<AcademyUnit> {
  await getUnit(academyId, unitId); // garante tenant (404 se de outra academia)

  const updates: string[] = [];
  const vals: unknown[] = [];
  if (params.name !== undefined) { updates.push(`name = $${vals.length + 1}`); vals.push(cleanName(params.name)); }
  if (params.address !== undefined) { updates.push(`address = $${vals.length + 1}`); vals.push(cleanAddress(params.address)); }
  if (updates.length === 0) return getUnit(academyId, unitId);

  updates.push('updated_at = NOW()');
  vals.push(unitId, academyId);
  const res = await pool.query(
    `UPDATE academy_units SET ${updates.join(', ')}
      WHERE id = $${vals.length - 1} AND academy_id = $${vals.length}
      RETURNING *`,
    vals
  );
  await auditLog(pool, {
    academyId, userId: actorUserId, action: 'unit.updated',
    entityType: 'unit', entityId: unitId, meta: params as Record<string, unknown>,
  });
  return mapUnit(res.rows[0]);
}

export async function setUnitStatus(
  academyId: number,
  actorUserId: number,
  unitId: number,
  status: 'active' | 'inactive'
): Promise<AcademyUnit> {
  if (status !== 'active' && status !== 'inactive') {
    throw err("Status inválido (use 'active' ou 'inactive').", 'INVALID_STATUS');
  }
  const unit = await getUnit(academyId, unitId);
  // A principal deve permanecer ativa — força reatribuir antes de inativar.
  if (status === 'inactive' && unit.isPrimary) {
    throw err('Defina outra unidade principal antes de inativar esta.', 'UNIT_IS_PRIMARY');
  }
  if (unit.status === status) return unit;

  const res = await pool.query(
    `UPDATE academy_units SET status = $1, updated_at = NOW()
      WHERE id = $2 AND academy_id = $3 RETURNING *`,
    [status, unitId, academyId]
  );
  await auditLog(pool, {
    academyId, userId: actorUserId, action: 'unit.status_changed',
    entityType: 'unit', entityId: unitId, meta: { status },
  });
  return mapUnit(res.rows[0]);
}

export async function setPrimaryUnit(
  academyId: number,
  actorUserId: number,
  unitId: number
): Promise<void> {
  const unit = await getUnit(academyId, unitId);
  if (unit.status !== 'active') {
    throw err('Só uma unidade ativa pode ser principal.', 'UNIT_INACTIVE');
  }
  if (unit.isPrimary) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Desmarca a principal atual (índice parcial exige unsetar antes de setar).
    await client.query(
      `UPDATE academy_units SET is_primary = false, updated_at = NOW()
        WHERE academy_id = $1 AND is_primary`,
      [academyId]
    );
    await client.query(
      `UPDATE academy_units SET is_primary = true, updated_at = NOW()
        WHERE id = $1 AND academy_id = $2`,
      [unitId, academyId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await auditLog(pool, {
    academyId, userId: actorUserId, action: 'unit.primary_set',
    entityType: 'unit', entityId: unitId,
  });
}

/**
 * Valida que unitId pertence à academia e está ativa. Usado ao vincular aluno.
 * Lança erro tipado → o caller mapeia para 400. unitId null/undefined = sem vínculo (ok).
 */
export async function assertUnitInAcademy(academyId: number, unitId: number | null | undefined): Promise<void> {
  if (unitId == null) return;
  const res = await pool.query(
    `SELECT status FROM academy_units WHERE id = $1 AND academy_id = $2`,
    [unitId, academyId]
  );
  if (res.rows.length === 0) throw err('Unidade não pertence a esta academia.', 'UNIT_NOT_IN_ACADEMY');
  if (res.rows[0].status !== 'active') throw err('Unidade inativa.', 'UNIT_INACTIVE');
}
