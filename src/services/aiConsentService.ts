/**
 * Consentimento do titular para tratamento de dados por IA de terceiros (Spec 039).
 *
 * ## Regras
 *
 * - O consentimento é do TITULAR dos dados. Para dado de aluno, quem consente é o aluno —
 *   o profissional que dispara a funcionalidade não consente por ele nem precisa de um
 *   segundo consentimento em nome próprio.
 * - Fail-closed: qualquer dúvida (coluna ausente, banco fora, id inválido, versão antiga)
 *   significa NÃO ter consentimento, e portanto nada sai para o provedor.
 * - Versionado: subir `CURRENT_AI_POLICY_VERSION` invalida os aceites antigos.
 * - Revogável a qualquer momento, com efeito imediato — o gate é consultado a cada chamada,
 *   antes de qualquer cache.
 * - Independente do banner de cookies/analytics (`corefit_cookie_consent_v1`, no navegador)
 *   e dos consentimentos por profissional (`user_data_consents`): outra finalidade, outro
 *   destinatário, outra tabela.
 *
 * Quem grantou e quando fica em `users` (estado atual) e em `data_access_audit` (histórico).
 */
import pool from '../config/database';
import logger from '../lib/logger';
import { CURRENT_AI_POLICY_VERSION } from '../config/legal';
import { logDataAccessEvent } from './dataAccessAuditService';

/** Finalidades que enviam dado a IA de terceiros. Cada chamada declara a sua. */
export type AiPurpose =
  | 'metabolic_interpretation'
  | 'student_summary'
  | 'performance_insight'
  | 'nutrition_intake'
  | 'workout_generation';

export interface AiConsentState {
  /** Vale agora: concedido, na versão vigente e não revogado depois. */
  granted: boolean;
  grantedAt: string | null;
  version: string | null;
  revokedAt: string | null;
  currentVersion: string;
  /** Houve aceite, mas de uma versão antiga da política. */
  needsReconsent: boolean;
}

interface ConsentRow {
  ai_processing_consent_at: Date | string | null;
  ai_processing_consent_version: string | null;
  ai_processing_revoked_at: Date | string | null;
}

const toMs = (v: Date | string | null): number | null => {
  if (v == null) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const toIso = (v: Date | string | null): string | null => {
  const ms = toMs(v);
  return ms == null ? null : new Date(ms).toISOString();
};

/** Regra pura do estado — separada da consulta para ser testada sem banco. */
export function evaluateConsent(row: ConsentRow | undefined): AiConsentState {
  const grantedMs = toMs(row?.ai_processing_consent_at ?? null);
  const revokedMs = toMs(row?.ai_processing_revoked_at ?? null);
  const version = row?.ai_processing_consent_version ?? null;

  const revokedAfterGrant = revokedMs != null && grantedMs != null && revokedMs >= grantedMs;
  const sameVersion = version === CURRENT_AI_POLICY_VERSION;
  const hadConsent = grantedMs != null && !revokedAfterGrant;

  return {
    granted: hadConsent && sameVersion,
    grantedAt: toIso(row?.ai_processing_consent_at ?? null),
    version,
    revokedAt: toIso(row?.ai_processing_revoked_at ?? null),
    currentVersion: CURRENT_AI_POLICY_VERSION,
    needsReconsent: hadConsent && !sameVersion,
  };
}

const SELECT_STATE = `SELECT ai_processing_consent_at, ai_processing_consent_version, ai_processing_revoked_at
                        FROM users WHERE id = $1 LIMIT 1`;

/** Estado completo, para a tela de privacidade. Propaga erro de banco (a rota responde 5xx). */
export async function getAiConsentState(userId: number): Promise<AiConsentState> {
  const r = await pool.query<ConsentRow>(SELECT_STATE, [userId]);
  return evaluateConsent(r.rows[0]);
}

/**
 * Existe consentimento válido do titular? NUNCA lança: erro vira `false`.
 * É o único jeito aceitável de consultar o gate — um `try/catch` que assuma "true" no
 * erro quebraria a promessa de que falha ao ler o consentimento não envia dado.
 */
export async function hasValidAiConsent(subjectUserId: number): Promise<boolean> {
  if (!Number.isInteger(subjectUserId) || subjectUserId <= 0) return false;
  try {
    return (await getAiConsentState(subjectUserId)).granted;
  } catch (err) {
    logger.error({ err, subjectUserId }, '[ai-consent] falha ao ler o consentimento — bloqueando por segurança');
    return false;
  }
}

/** Lançada quando uma chamada de IA seria feita sem consentimento do titular. */
export class AiConsentRequiredError extends Error {
  readonly code = 'AI_CONSENT_REQUIRED' as const;

  constructor(
    readonly subjectUserId: number,
    /** `self` quando o titular é quem dispara; `student` quando um profissional dispara sobre o aluno. */
    readonly subject: 'self' | 'student',
  ) {
    super(
      subject === 'self'
        ? 'Para usar este recurso de IA, autorize o tratamento dos seus dados por IA em Privacidade.'
        : 'O aluno ainda não autorizou o uso de IA com os dados dele.',
    );
    this.name = 'AiConsentRequiredError';
  }
}

export async function assertAiConsent(subjectUserId: number, actorUserId?: number): Promise<void> {
  if (await hasValidAiConsent(subjectUserId)) return;
  throw new AiConsentRequiredError(
    subjectUserId,
    actorUserId == null || actorUserId === subjectUserId ? 'self' : 'student',
  );
}

/**
 * Concede (ou renova) o consentimento na versão vigente. Persistência com falha lança: nada
 * é considerado concedido. Um novo aceite limpa a revogação anterior — o histórico de
 * conceder/revogar fica em `data_access_audit`, e assim "revogado" nunca depende de comparar
 * dois carimbos que podem cair no mesmo milissegundo.
 */
export async function grantAiConsent(userId: number, ip?: string): Promise<AiConsentState> {
  const r = await pool.query<ConsentRow>(
    `UPDATE users
        SET ai_processing_consent_at = NOW(),
            ai_processing_consent_version = $2,
            ai_processing_revoked_at = NULL
      WHERE id = $1
  RETURNING ai_processing_consent_at, ai_processing_consent_version, ai_processing_revoked_at`,
    [userId, CURRENT_AI_POLICY_VERSION],
  );
  if (r.rows.length === 0) throw Object.assign(new Error('user_not_found'), { code: 'NOT_FOUND' });

  void logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'ai.consent.granted',
    eventPayload: { version: CURRENT_AI_POLICY_VERSION },
    ip,
  });
  return evaluateConsent(r.rows[0]);
}

/**
 * Revoga. Idempotente: revogar sem consentimento ativo não é erro. O efeito é imediato
 * porque todo gate lê o estado a cada chamada.
 */
export async function revokeAiConsent(userId: number, ip?: string): Promise<AiConsentState> {
  const r = await pool.query<ConsentRow>(
    `UPDATE users
        SET ai_processing_revoked_at = NOW()
      WHERE id = $1 AND ai_processing_consent_at IS NOT NULL
  RETURNING ai_processing_consent_at, ai_processing_consent_version, ai_processing_revoked_at`,
    [userId],
  );

  if (r.rows.length === 0) return getAiConsentState(userId);

  void logDataAccessEvent({
    actorId: userId,
    subjectUserId: userId,
    eventType: 'ai.consent.revoked',
    eventPayload: {},
    ip,
  });
  return evaluateConsent(r.rows[0]);
}

/**
 * Trilha de que dado do titular saiu para o provedor. Só metadados: a finalidade e quem
 * disparou — NUNCA o conteúdo do prompt nem a resposta.
 */
export function auditAiProcessing(subjectUserId: number, actorUserId: number | undefined, purpose: AiPurpose): void {
  void logDataAccessEvent({
    actorId: actorUserId ?? subjectUserId,
    subjectUserId,
    eventType: 'ai.processing',
    eventPayload: { purpose },
  });
}
