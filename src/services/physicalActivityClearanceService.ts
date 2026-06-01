import pool from '../config/database';

export type ClearanceReason =
  | 'ok'
  | 'never_signed'
  | 'expired'
  | 'incomplete_health_flags'
  | 'not_applicable';

export interface PhysicalActivityClearance {
  valid: boolean;
  signedAt: string | null;
  expiresAt: string | null;
  reason: ClearanceReason;
}

const cache = new Map<number, { expiresAt: number; value: PhysicalActivityClearance }>();
const CACHE_TTL_MS = 60_000;

export function invalidateClearanceCache(userId: number): void {
  cache.delete(userId);
}

export function deriveClearance(row: {
  role: string;
  parq_signed_at?: Date | string | null;
  parq_expires_at?: Date | string | null;
  parq_signature_data?: string | null;
  sem_historico_hipertensao?: boolean | null;
  sem_historico_cardiaco?: boolean | null;
  sem_restricao_medica_exercicio?: boolean | null;
  apto_para_atividade_fisica?: boolean | null;
  aceita_responsabilidade_informacoes?: boolean | null;
}): PhysicalActivityClearance {
  if (row.role !== 'user') {
    return { valid: true, signedAt: null, expiresAt: null, reason: 'not_applicable' };
  }

  const healthComplete =
    row.sem_historico_hipertensao === true &&
    row.sem_historico_cardiaco === true &&
    row.sem_restricao_medica_exercicio === true &&
    row.apto_para_atividade_fisica === true &&
    row.aceita_responsabilidade_informacoes === true;

  if (!healthComplete) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'incomplete_health_flags' };
  }

  if (!row.parq_signed_at || !row.parq_signature_data) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'never_signed' };
  }

  const signedAt = new Date(row.parq_signed_at).toISOString();
  const expiresAt = row.parq_expires_at ? new Date(row.parq_expires_at).toISOString() : null;

  if (!expiresAt || new Date(expiresAt) <= new Date()) {
    return { valid: false, signedAt, expiresAt, reason: 'expired' };
  }

  return { valid: true, signedAt, expiresAt, reason: 'ok' };
}

export async function getClearanceForUser(userId: number): Promise<PhysicalActivityClearance> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  const { rows } = await pool.query(
    `SELECT
       role,
       parq_signed_at,
       parq_expires_at,
       parq_signature_data,
       sem_historico_hipertensao,
       sem_historico_cardiaco,
       sem_restricao_medica_exercicio,
       apto_para_atividade_fisica,
       aceita_responsabilidade_informacoes
     FROM users WHERE id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'never_signed' };
  }

  const value = deriveClearance(rows[0]);
  cache.set(userId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
