import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';

export type ConsentScope =
  | 'profile'
  | 'workouts'
  | 'daily_checkins'
  | 'metabolic'
  | 'sleep'
  | 'body_metrics'
  | 'body_photos'
  | 'nutrition'
  | 'clinical_nutrition' // Spec 019 — perfil clínico-nutricional (alergias, condições, medicamentos)
  | 'parq_anamnese'
  | 'activity_logs'
  | 'chat_history'
  | 'sports'; // Fight Intelligence — Onda B: coach/nutri view

export type ProfessionalRole = 'personal' | 'nutri';

/** Consent do aluno alimenta a redação do dashboard do personal (Spec 012).
 *  Ao conceder/revogar, invalida o cache do dashboard para a mudança valer na
 *  hora (sem esperar o TTL). Import dinâmico evita ciclo com o dashboard service.
 *  Non-blocking. */
async function invalidatePersonalDashboardOnConsentChange(
  userId: number,
  professionalRole: ProfessionalRole
): Promise<void> {
  if (professionalRole !== 'personal') return;
  try {
    const { invalidatePersonalDashboardForStudent } = await import('./personalDashboardService');
    await invalidatePersonalDashboardForStudent(userId);
  } catch { /* non-blocking */ }
}

export const DEFAULT_SCOPES_PERSONAL: ConsentScope[] = ['profile', 'workouts', 'daily_checkins'];
export const DEFAULT_SCOPES_NUTRI: ConsentScope[] = ['profile', 'daily_checkins', 'nutrition', 'clinical_nutrition'];

/**
 * Escopos concedidos quando o aluno entra por convite direto do profissional
 * (vínculo iniciado pelo próprio aluno ao usar o link de convite). Espelham
 * o backfill da migration 1790600000000 para que um aluno convidado direto se
 * comporte igual a um vínculo legado — sem lacunas de `consent_required` nas
 * abas de fichas, metabolismo, sono etc. O aluno pode revogar granularmente
 * depois em "Minha equipe".
 */
export const DIRECT_INVITE_SCOPES_PERSONAL: ConsentScope[] = [
  'profile', 'workouts', 'daily_checkins', 'metabolic', 'sleep',
  'body_metrics', 'parq_anamnese', 'activity_logs', 'chat_history',
];
// Sem chat_history: nutri não tem chat bidirecional (só "Voz" unidirecional),
// então o escopo seria concedido mas inútil/irrevogável na UI. Espelhado no
// frontend (features/team/types.ts).
export const DIRECT_INVITE_SCOPES_NUTRI: ConsentScope[] = [
  'profile', 'nutrition', 'clinical_nutrition', 'daily_checkins', 'metabolic',
  'body_metrics', 'parq_anamnese',
];

export interface ConsentEntry {
  id: string;
  scope: ConsentScope;
  status: 'granted' | 'revoked' | 'expired';
  grantedAt: string;
  revokedAt: string | null;
}

export async function grantConsents(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scopes: ConsentScope[],
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> }
): Promise<void> {
  for (const scope of scopes) {
    await client.query(
      `INSERT INTO user_data_consents
         (user_id, professional_id, professional_role, scope, status, granted_at)
       VALUES ($1, $2, $3, $4, 'granted', NOW())
       ON CONFLICT (user_id, professional_id, professional_role, scope)
       DO UPDATE SET status = 'granted', granted_at = NOW(), revoked_at = NULL`,
      [userId, professionalId, professionalRole, scope]
    );
    await logDataAccessEvent(
      {
        actorId: userId,
        subjectUserId: userId,
        eventType: 'consent.granted',
        eventPayload: { professionalId, professionalRole, scope },
      },
      client as never
    );
  }
  await invalidatePersonalDashboardOnConsentChange(userId, professionalRole);
}

export async function revokeConsent(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scope: ConsentScope,
  ip?: string
): Promise<void> {
  await pool.query(
    `UPDATE user_data_consents
     SET status = 'revoked', revoked_at = NOW()
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND scope = $4 AND status = 'granted'`,
    [userId, professionalId, professionalRole, scope]
  );
  await logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'consent.revoked',
    eventPayload: { professionalId, professionalRole, scope },
    ip,
  });
  await invalidatePersonalDashboardOnConsentChange(userId, professionalRole);
}

export async function revokeAllConsents(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  actorId: number,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ scope: string }> }> },
  ip?: string
): Promise<void> {
  const { rows } = await client.query(
    `UPDATE user_data_consents
     SET status = 'revoked', revoked_at = NOW()
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND status = 'granted'
     RETURNING scope`,
    [userId, professionalId, professionalRole]
  );
  for (const row of rows) {
    await logDataAccessEvent(
      {
        actorId,
        subjectUserId: userId,
        eventType: 'consent.revoked',
        eventPayload: { professionalId, professionalRole, scope: row.scope, bulk: true },
        ip,
      },
      client as never
    );
  }
  await invalidatePersonalDashboardOnConsentChange(userId, professionalRole);
}

export async function hasActiveConsent(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole,
  scope: ConsentScope
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_data_consents
     WHERE user_id = $1 AND professional_id = $2
       AND professional_role = $3 AND scope = $4 AND status = 'granted'
     LIMIT 1`,
    [userId, professionalId, professionalRole, scope]
  );
  return rows.length > 0;
}

/** Conjunto de escopos ATIVOS (granted) de um par profissional↔aluno.
 *  Usado para filtrar payloads por consent granular (Spec 012). */
export async function listActiveConsentScopes(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole
): Promise<Set<ConsentScope>> {
  const { rows } = await pool.query(
    `SELECT scope FROM user_data_consents
      WHERE user_id = $1 AND professional_id = $2 AND professional_role = $3 AND status = 'granted'`,
    [userId, professionalId, professionalRole]
  );
  return new Set(rows.map((r) => r.scope as ConsentScope));
}

/** Mapa aluno→escopos-ativos de TODA a carteira de um profissional, em uma query.
 *  Usado para redigir por consent o dashboard agregado do personal (Spec 012
 *  estendida à carteira), sem N+1. Alunos sem nenhum consent granted não
 *  aparecem no mapa (o chamador trata ausência como "nenhum escopo"). */
export async function listActiveConsentScopesForProfessional(
  professionalId: number,
  professionalRole: ProfessionalRole
): Promise<Map<number, Set<ConsentScope>>> {
  const { rows } = await pool.query(
    `SELECT user_id, scope FROM user_data_consents
      WHERE professional_id = $1 AND professional_role = $2 AND status = 'granted'`,
    [professionalId, professionalRole]
  );
  const map = new Map<number, Set<ConsentScope>>();
  for (const r of rows) {
    const uid = Number(r.user_id);
    let set = map.get(uid);
    if (!set) {
      set = new Set<ConsentScope>();
      map.set(uid, set);
    }
    set.add(r.scope as ConsentScope);
  }
  return map;
}

export async function listConsentsForUser(
  userId: number,
  professionalId: number,
  professionalRole: ProfessionalRole
): Promise<ConsentEntry[]> {
  const { rows } = await pool.query(
    `SELECT id, scope, status, granted_at, revoked_at
     FROM user_data_consents
     WHERE user_id = $1 AND professional_id = $2 AND professional_role = $3
     ORDER BY scope`,
    [userId, professionalId, professionalRole]
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    status: r.status,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
  }));
}
