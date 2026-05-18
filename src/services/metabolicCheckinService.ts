import type { PoolClient } from 'pg';
import pool from '../config/database';

export type MetabolicCheckinSource = 'onboarding' | 'self_report' | 'professional' | 'imported';

export interface MetabolicCheckinInput {
  recordedAt?: string | Date | null;
  weightKg?: unknown;
  waistCm?: unknown;
  bodyFatPct?: unknown;
  systolicMmhg?: unknown;
  diastolicMmhg?: unknown;
  fastingGlucoseMgdl?: unknown;
  notes?: unknown;
  source?: unknown;
}

export interface MetabolicCheckinRecord {
  id: string;
  userId: number;
  academyId: number | null;
  recordedAt: string;
  weightKg: number | null;
  waistCm: number | null;
  bodyFatPct: number | null;
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  fastingGlucoseMgdl: number | null;
  notes: string | null;
  source: MetabolicCheckinSource;
  createdAt: string;
}

const SOURCES = new Set<MetabolicCheckinSource>(['onboarding', 'self_report', 'professional', 'imported']);

function parseDecimal(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} fora do intervalo esperado.`);
  }
  return parsed;
}

function parseInteger(value: unknown, label: string, min: number, max: number): number | null {
  const parsed = parseDecimal(value, label, min, max);
  return parsed == null ? null : Math.round(parsed);
}

function normalizeSource(value: unknown): MetabolicCheckinSource {
  const source = typeof value === 'string' ? value : 'self_report';
  if (!SOURCES.has(source as MetabolicCheckinSource)) {
    throw new Error('Fonte de atualização inválida.');
  }
  return source as MetabolicCheckinSource;
}

function normalizeRecordedAt(value: string | Date | null | undefined): Date {
  if (!value) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Data da atualização inválida.');
  }
  return date;
}

interface MetabolicCheckinRow {
  id: string;
  user_id: number | string;
  academy_id: number | string | null;
  recorded_at: Date | string;
  weight_kg: string | number | null;
  waist_cm: string | number | null;
  body_fat_pct: string | number | null;
  systolic_mmhg: string | number | null;
  diastolic_mmhg: string | number | null;
  fasting_glucose_mgdl: string | number | null;
  notes: string | null;
  source: MetabolicCheckinSource;
  created_at: Date | string;
}

function mapRow(row: MetabolicCheckinRow): MetabolicCheckinRecord {
  return {
    id: row.id,
    userId: Number(row.user_id),
    academyId: row.academy_id == null ? null : Number(row.academy_id),
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    waistCm: row.waist_cm == null ? null : Number(row.waist_cm),
    bodyFatPct: row.body_fat_pct == null ? null : Number(row.body_fat_pct),
    systolicMmhg: row.systolic_mmhg == null ? null : Number(row.systolic_mmhg),
    diastolicMmhg: row.diastolic_mmhg == null ? null : Number(row.diastolic_mmhg),
    fastingGlucoseMgdl: row.fasting_glucose_mgdl == null ? null : Number(row.fasting_glucose_mgdl),
    notes: row.notes ?? null,
    source: row.source,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export function normalizeMetabolicCheckinInput(input: MetabolicCheckinInput) {
  const normalized = {
    recordedAt: normalizeRecordedAt(input.recordedAt),
    weightKg: parseDecimal(input.weightKg, 'Peso', 20, 500),
    waistCm: parseDecimal(input.waistCm, 'Cintura', 40, 250),
    bodyFatPct: parseDecimal(input.bodyFatPct, 'Percentual', 1, 80),
    systolicMmhg: parseInteger(input.systolicMmhg, 'Pressão sistólica', 60, 260),
    diastolicMmhg: parseInteger(input.diastolicMmhg, 'Pressão diastólica', 30, 180),
    fastingGlucoseMgdl: parseInteger(input.fastingGlucoseMgdl, 'Glicemia', 40, 500),
    notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 500) : null,
    source: normalizeSource(input.source),
  };

  const hasMetric =
    normalized.weightKg != null ||
    normalized.waistCm != null ||
    normalized.bodyFatPct != null ||
    normalized.systolicMmhg != null ||
    normalized.diastolicMmhg != null ||
    normalized.fastingGlucoseMgdl != null;

  if (!hasMetric) {
    throw new Error('Informe pelo menos uma atualização para salvar.');
  }

  return normalized;
}

export async function createMetabolicCheckin(
  userId: number,
  academyId: number | null,
  input: MetabolicCheckinInput,
  client: PoolClient | typeof pool = pool
): Promise<MetabolicCheckinRecord> {
  const data = normalizeMetabolicCheckinInput(input);
  const result = await client.query(
    `INSERT INTO user_metabolic_checkins
       (user_id, academy_id, recorded_at, weight_kg, waist_cm, body_fat_pct,
        systolic_mmhg, diastolic_mmhg, fasting_glucose_mgdl, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      userId,
      academyId,
      data.recordedAt,
      data.weightKg,
      data.waistCm,
      data.bodyFatPct,
      data.systolicMmhg,
      data.diastolicMmhg,
      data.fastingGlucoseMgdl,
      data.notes,
      data.source,
    ]
  );
  return mapRow(result.rows[0] as MetabolicCheckinRow);
}

export async function listMetabolicCheckins(userId: number, limit = 50): Promise<MetabolicCheckinRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  const result = await pool.query(
    `SELECT *
     FROM user_metabolic_checkins
     WHERE user_id = $1
     ORDER BY recorded_at DESC, created_at DESC
     LIMIT $2`,
    [userId, safeLimit]
  );
  return (result.rows as MetabolicCheckinRow[]).map(mapRow);
}
