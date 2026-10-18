/**
 * Exclusão e Exportação de Conta (Spec 025). Núcleo compartilhado pela rota
 * self-service do aluno (`DELETE /user/account`) e pelo admin-delete — evita
 * divergência da limpeza de storage (fix f57e539) e da anonimização financeira.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import logger from '../lib/logger';
import * as Sentry from '@sentry/node';
import { getStorage, isStorageConfigured } from '../lib/storage';
import { recordStorageOrphan } from './storageOrphanService';
import { logDataAccessEvent } from './dataAccessAuditService';
import {
  AccountDeletionBlockedError,
  assertDeletionAllowed,
  attemptPendingCancellations,
  countCancelled,
  enqueueCancellations,
  findOpenRequest,
  getRequest,
  listDueRequests,
  listOwnedRecurrences,
  markStalledByBlock,
  openRequest,
  recordFailedRound,
  resolvedPreapprovals,
  type DeletionRequest,
  type GatewayCancel,
} from './accountDeletionBilling';

export type DeletionActor = 'self' | 'admin';

function emailHash(email: string | null): string {
  return crypto.createHash('sha256').update((email ?? '').toLowerCase().trim()).digest('hex');
}

/**
 * Anonimiza registros financeiros ANTES do DELETE do usuário: desvincula user_id
 * (PII) e marca. Como o user_id vira NULL, o ON DELETE CASCADE não toca essas
 * linhas — valores/datas/status/gateway_id ficam para fisco/chargeback.
 */
async function anonymizeFinancials(client: PoolClient, userId: number, hash: string): Promise<void> {
  for (const table of ['payments', 'user_subscriptions']) {
    await client.query(
      `UPDATE ${table}
          SET user_id = NULL, anonymized_at = NOW(), anonymized_user_hash = $2
        WHERE user_id = $1`,
      [userId, hash],
    );
  }
}

export type DeleteStatus = 'completed' | 'pending_cancellation' | 'stalled';

export interface DeleteResult {
  /**
   * `completed`: conta excluída. `pending_cancellation`: há cobrança recorrente do titular que o
   * gateway ainda não confirmou cancelada — a conta é MANTIDA e o cron retenta por até 24h.
   * `stalled`: esgotou o prazo; conta mantida, evidência operacional gerada, reconciliação manual.
   */
  status: DeleteStatus;
  storageObjectsDeleted: number;
  /** Recorrências efetivamente canceladas por este encerramento. */
  subscriptionsCancelled: number;
  /** Recorrências do titular ainda sem confirmação do gateway. */
  subscriptionsPending: number;
  requestId?: number;
}

type DeleteOpts = { requestedBy: DeletionActor; reason?: string };

type Finalized = { done: false } | { done: true; photoKeys: string[]; cancelled: number };

/**
 * Transação que efetivamente exclui: anonimiza financeiro, enumera as fotos, apaga o usuário
 * (CASCADE no resto) e grava o tombstone.
 *
 * Trava a linha do usuário (`FOR UPDATE`) e RELÊ as regras dentro da transação: qualquer
 * assinatura criada depois da enumeração do orquestrador fica bloqueada pela FK até o COMMIT,
 * e uma recorrência que apareça sem estar resolvida aborta a exclusão (`done: false`) em vez de
 * ser apagada pelo CASCADE junto com o id que permitiria cancelá-la.
 */
async function finalizeDeletion(
  userId: number,
  hash: string,
  opts: DeleteOpts,
  requestId: number | null,
): Promise<Finalized> {
  const client = await pool.connect();
  let photoKeys: string[] = [];
  let cancelled = 0;
  try {
    await client.query('BEGIN');

    const locked = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (locked.rows.length === 0) {
      const err = new Error('user_not_found');
      (err as any).code = 'NOT_FOUND';
      throw err;
    }

    // Trava as academias em que o titular é responsável ANTES de reavaliar a regra do sucessor: sem
    // isto, dois donos que se excluem ao mesmo tempo veem um ao outro como sucessor e a academia
    // fica órfã. Em ordem de id para não gerar deadlock entre as duas transações.
    await client.query(
      `SELECT a.id FROM academies a
        WHERE a.status <> 'cancelled'
          AND ( a.owner_user_id = $1
                OR EXISTS (SELECT 1 FROM academy_users au JOIN academy_roles ar ON ar.id = au.role_id
                            WHERE au.academy_id = a.id AND au.user_id = $1
                              AND au.status = 'active' AND ar.slug = 'academy_owner') )
        ORDER BY a.id FOR UPDATE OF a`,
      [userId],
    );
    await assertDeletionAllowed(userId, client);

    const recorrencias = await listOwnedRecurrences(userId, client);
    const resolvidas = requestId != null ? await resolvedPreapprovals(requestId, client) : new Set<string>();
    if (recorrencias.some((r) => !resolvidas.has(r.preapprovalId))) {
      await client.query('ROLLBACK');
      return { done: false };
    }

    await anonymizeFinancials(client, userId, hash);

    // Tabelas sem CASCADE que referenciam o usuário — limpar explicitamente.
    await client.query(`DELETE FROM personal_direct_invites WHERE accepted_user_id = $1`, [userId]);

    // Biblioteca de protocolos do personal (QA final 02/ago/2026).
    // `owner_personal_id` é ON DELETE SET NULL, mas o CHECK
    // `workout_protocols_scope_academy_chk` exige que todo protocolo de
    // `scope='personal'` TENHA dono — então o SET NULL estourava a constraint e
    // a exclusão do PERSONAL voltava 500 (o defeito não aparecia no aluno, que
    // não tem biblioteca). Protocolo pessoal sem dono não tem leitor nem
    // significado: some junto. Os de `scope='academy'` ficam com a academia e
    // apenas perdem o vínculo de autoria (o SET NULL da FK dá conta).
    await client.query(
      `DELETE FROM workout_protocols WHERE owner_personal_id = $1 AND scope = 'personal'`,
      [userId],
    );

    // Desafios criados pelo personal (Spec 034, C2). `personal_id` é ON DELETE
    // SET NULL, e um desafio sem dono é entidade social órfã carregando dado
    // pessoal de terceiros — o precedente da migration 1826 é claro: entidade
    // operacional não sobrevive ao dono. Os participantes vão por CASCADE, e o
    // XP já pago fica: ele é do titular de cada participante, não do desafio.
    await client.query(`DELETE FROM challenges WHERE personal_id = $1`, [userId]);

    // Biblioteca de exercícios personalizados do personal (Sprint P1, D6).
    // `owner_personal_id` é ON DELETE SET NULL — mas SOZINHO isso repetiria o
    // bug do protocolo pessoal (linha acima, QA 02/ago): a linha viraria
    // GLOBAL-visível para todo mundo, vazando nome/mídia/instruções privadas
    // do personal excluído para o catálogo S2CORE inteiro. Arquivar ANTES do
    // SET NULL disparar tira a linha de toda busca (dono ou não — `status`
    // filtra igual para as duas), preservando resolução direta por id (ficha
    // já salva, histórico, PR) exatamente como qualquer outro exercício
    // arquivado — D10 já garante que isso não quebra.
    await client.query(
      `UPDATE exercises SET status = 'archived', updated_at = NOW()
        WHERE owner_personal_id = $1 AND status = 'active'`,
      [userId],
    );

    // Alimentos customizados do nutri (SPEC 038, P3A). Mesmo desenho e MESMA
    // lição do bug de 02/ago acima: `owner_nutri_id` é ON DELETE SET NULL
    // (migration 1840000000000), e sozinho isso vazaria nome/marca/notas de
    // um alimento privado como "sem dono" — que a busca de custom food trata
    // como inexistente hoje, mas arquivar ANTES garante que a linha nunca
    // fica em estado ambíguo, igual `exercises`.
    await client.query(
      `UPDATE nutrition_custom_foods SET status = 'archived', updated_at = NOW()
        WHERE owner_nutri_id = $1 AND status = 'active'`,
      [userId],
    );

    // Fotos de progresso (LGPD art. 11): CASCADE apaga as LINHAS, não os binários.
    const photoRes = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM progress_photos WHERE user_id = $1`,
      [userId],
    );
    photoKeys = photoRes.rows.map((r) => r.storage_key);

    if (requestId != null) cancelled = await countCancelled(requestId, client);

    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query(
      `INSERT INTO account_deletions (user_id, email_hash, requested_by, reason, storage_objects_deleted, subscriptions_cancelled)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, hash, opts.requestedBy, opts.reason ?? null, photoKeys.length, cancelled],
    );

    if (requestId != null) {
      await client.query(
        `UPDATE account_deletion_requests
            SET status = 'completed', completed_at = NOW(), next_retry_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [requestId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { done: true, photoKeys, cancelled };
}

/**
 * Pós-COMMIT: purga best-effort dos objetos no storage. Falhas viram órfãos registrados
 * (Spec 023) para o job de varredura reconciliar — nunca silencioso.
 */
async function purgeStorage(photoKeys: string[], requestedBy: DeletionActor, userId: number): Promise<number> {
  const orphanReason = requestedBy === 'admin' ? 'admin_user_delete' : 'student_delete';
  let deleted = 0;
  if (photoKeys.length === 0) return 0;
  if (!isStorageConfigured()) {
    await Promise.all(photoKeys.map((key) => recordStorageOrphan(key, 'storage_not_configured', { userId })));
    return 0;
  }
  const storage = getStorage();
  for (const key of photoKeys) {
    try {
      await storage.deleteObject(key);
      deleted += 1;
    } catch (delErr: any) {
      await recordStorageOrphan(key, orphanReason, { userId }, delErr?.message);
    }
  }
  return deleted;
}

/** Evidência operacional de um pedido que esgotou as tentativas: alto e claro, nunca silencioso. */
async function reportStalled(request: DeletionRequest, lastError: string | null, subscriptionsPending: number): Promise<void> {
  logger.error(
    { requestId: request.id, userId: request.userId, attempts: request.attempts + 1, lastError, subscriptionsPending },
    '[account-deletion] STALLED — recorrência do titular sem confirmação de cancelamento; reconciliação manual necessária',
  );
  Sentry.captureMessage('account_deletion_stalled', {
    level: 'error',
    tags: { account_deletion_request: String(request.id) },
    extra: { lastError, subscriptionsPending },
  });
  await logDataAccessEvent({
    actorId: request.userId,
    subjectUserId: request.userId,
    eventType: 'account.deletion_stalled',
    eventPayload: { requestId: request.id, lastError, subscriptionsPending },
  });
}

async function pendingCount(requestId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM account_deletion_cancellations WHERE request_id = $1 AND status = 'pending'`,
    [requestId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Faz o pedido avançar o quanto der: confere as regras, cancela no gateway o que é do titular e,
 * só quando tudo estiver em estado terminal, exclui. Idempotente — a requisição do usuário, o
 * cron e a reconciliação do admin chamam o mesmo caminho.
 */
async function advanceDeletion(
  userId: number,
  hash: string,
  opts: DeleteOpts,
  gateway: GatewayCancel | undefined,
  known: DeletionRequest | null,
): Promise<DeleteResult> {
  let request = known ?? (await findOpenRequest(userId));

  // Pedido do usuário repetido (duplo clique, "tentar de novo") ANTES da próxima janela de retentativa:
  // devolve o estado sem chamar o gateway nem gastar tentativa — senão cinco cliques esgotariam em
  // minutos o prazo que é de 24h. O cron (`known`) e o admin passam direto.
  if (!known && request?.status === 'pending_cancellation' && request.nextRetryAt && new Date(request.nextRetryAt).getTime() > Date.now()) {
    return {
      status: 'pending_cancellation',
      storageObjectsDeleted: 0,
      subscriptionsCancelled: await countCancelled(request.id),
      subscriptionsPending: await pendingCount(request.id),
      requestId: request.id,
    };
  }

  for (let round = 0; round < 3; round += 1) {
    await assertDeletionAllowed(userId);
    const recorrencias = await listOwnedRecurrences(userId);

    // Caminho comum: nada a cancelar e nenhum pedido aberto → exclusão direta, como sempre foi.
    if (recorrencias.length === 0 && !request) {
      const f = await finalizeDeletion(userId, hash, opts, null);
      if (f.done) {
        return {
          status: 'completed',
          storageObjectsDeleted: await purgeStorage(f.photoKeys, opts.requestedBy, userId),
          subscriptionsCancelled: 0,
          subscriptionsPending: 0,
        };
      }
      continue; // uma recorrência apareceu entre a leitura e a trava
    }

    request ??= await openRequest(userId, hash, opts.requestedBy, opts.reason);
    await enqueueCancellations(request.id, recorrencias);
    const { pending, lastError } = await attemptPendingCancellations(request.id, gateway);

    if (pending > 0) {
      const round_ = await recordFailedRound(request, lastError);
      if (round_.becameStalled) await reportStalled(request, lastError, pending);
      else logger.warn({ requestId: request.id, pending, attempts: round_.attempts, lastError }, '[account-deletion] cancelamento pendente — será retentado');
      return {
        status: round_.status === 'stalled' ? 'stalled' : 'pending_cancellation',
        storageObjectsDeleted: 0,
        subscriptionsCancelled: await countCancelled(request.id),
        subscriptionsPending: pending,
        requestId: request.id,
      };
    }

    const f = await finalizeDeletion(userId, hash, opts, request.id);
    if (f.done) {
      return {
        status: 'completed',
        storageObjectsDeleted: await purgeStorage(f.photoKeys, opts.requestedBy, userId),
        subscriptionsCancelled: f.cancelled,
        subscriptionsPending: 0,
        requestId: request.id,
      };
    }
    // recorrência nova sem resolução: a próxima rodada a enfileira e cancela
  }

  return {
    status: 'pending_cancellation',
    storageObjectsDeleted: 0,
    subscriptionsCancelled: request ? await countCancelled(request.id) : 0,
    subscriptionsPending: request ? await pendingCount(request.id) : 0,
    requestId: request?.id,
  };
}

/**
 * Exclui a conta do usuário (self-service, admin-delete e cron compartilham este núcleo).
 *
 * Antes de apagar qualquer coisa: (1) as travas — dono de academia e contratos de terceiros —,
 * (2) o cancelamento, no Mercado Pago, das recorrências que são do PRÓPRIO titular. Se o gateway
 * não confirmar, a conta é mantida e o pedido fica reconciliável (ver `accountDeletionBilling`).
 * Lança `AccountDeletionBlockedError` (409) quando uma trava impede.
 */
export async function deleteUserAccount(
  userId: number,
  opts: DeleteOpts,
  deps: { gateway?: GatewayCancel } = {},
): Promise<DeleteResult> {
  const userRes = await pool.query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (userRes.rows.length === 0) {
    const err = new Error('user_not_found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  return advanceDeletion(userId, emailHash(userRes.rows[0].email), opts, deps.gateway, null);
}

// ---------------------------------------------------------------------------
// Retentativa (cron de 6 em 6 horas) e reconciliação manual
// ---------------------------------------------------------------------------

export interface PendingDeletionsReport {
  due: number;
  completed: number;
  stillPending: number;
  stalled: number;
  blocked: number;
}

async function advanceKnownRequest(request: DeletionRequest, gateway?: GatewayCancel): Promise<DeleteResult | 'blocked' | 'gone'> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [request.userId]);
  if (exists.rows.length === 0) {
    // O usuário já não existe (excluído por outro caminho): o pedido não tem mais o que fazer.
    await pool.query(
      `UPDATE account_deletion_requests SET status = 'completed', completed_at = NOW(), next_retry_at = NULL, updated_at = NOW() WHERE id = $1`,
      [request.id],
    );
    return 'gone';
  }
  try {
    return await advanceDeletion(
      request.userId,
      request.emailHash,
      { requestedBy: request.requestedBy, reason: request.reason ?? undefined },
      gateway,
      request,
    );
  } catch (err) {
    if (err instanceof AccountDeletionBlockedError) {
      // O cenário mudou desde o pedido (virou dono, ganhou contrato…): para de tentar sozinho.
      await markStalledByBlock(request.id, err.code);
      logger.error({ requestId: request.id, userId: request.userId, code: err.code }, '[account-deletion] pedido bloqueado por regra — reconciliação manual');
      return 'blocked';
    }
    throw err;
  }
}

/** Tarefa do `runCronJobs six-hourly`. Idempotente; uma falha isolada não impede as demais. */
export async function processPendingAccountDeletions(gateway?: GatewayCancel): Promise<PendingDeletionsReport> {
  const due = await listDueRequests();
  const report: PendingDeletionsReport = { due: due.length, completed: 0, stillPending: 0, stalled: 0, blocked: 0 };

  for (const request of due) {
    try {
      const r = await advanceKnownRequest(request, gateway);
      if (r === 'blocked') report.blocked += 1;
      else if (r === 'gone' || r.status === 'completed') report.completed += 1;
      else if (r.status === 'stalled') report.stalled += 1;
      else report.stillPending += 1;
    } catch (err) {
      logger.error({ err, requestId: request.id }, '[account-deletion] retentativa falhou');
      report.stillPending += 1;
    }
  }
  return report;
}

export interface DeletionRequestSummary {
  id: number;
  userId: number;
  requestedBy: string;
  status: string;
  attempts: number;
  lastError: string | null;
  deadlineAt: string;
  createdAt: string;
  cancellations: Array<{ source: string; preapprovalId: string; status: string; attempts: number; lastError: string | null }>;
}

/** Visão operacional dos pedidos em aberto (ou de um status). Só ids e estados — sem PII. */
export async function listDeletionRequests(status?: string, limit = 100): Promise<DeletionRequestSummary[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.requested_by, r.status, r.attempts, r.last_error, r.deadline_at, r.created_at,
            COALESCE(json_agg(json_build_object(
              'source', c.source_table, 'preapprovalId', c.mp_preapproval_id,
              'status', c.status, 'attempts', c.attempts, 'lastError', c.last_error) ORDER BY c.id)
              FILTER (WHERE c.id IS NOT NULL), '[]') AS cancellations
       FROM account_deletion_requests r
       LEFT JOIN account_deletion_cancellations c ON c.request_id = r.id
      WHERE ($1::text IS NULL AND r.status IN ('pending_cancellation','stalled')) OR r.status = $1
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [status ?? null, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    userId: r.user_id,
    requestedBy: r.requested_by,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    deadlineAt: new Date(r.deadline_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    cancellations: r.cancellations,
  }));
}

/** Reconciliação manual: reexecuta o pedido (inclusive `stalled`) pelo mesmo caminho do cron. */
export async function retryDeletionRequest(requestId: number, gateway?: GatewayCancel): Promise<DeleteResult | 'blocked' | 'gone' | 'not_found'> {
  const request = await getRequest(requestId);
  if (!request) return 'not_found';
  if (request.status === 'completed') return 'gone';
  return advanceKnownRequest(request, gateway);
}

// ===========================================================================
// Exportação (SAR / LGPD art. 18) — read-only, agregada, escopada por user_id.
// Cada seção é best-effort: uma consulta que falhe não derruba o export inteiro.
// ===========================================================================

async function section<T = any>(label: string, sql: string, params: any[]): Promise<T[]> {
  try {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  } catch (err: any) {
    logger.warn({ err: err?.message, section: label }, '[account-export] seção falhou (ignorada)');
    return [];
  }
}

export async function exportUserData(userId: number): Promise<Record<string, unknown>> {
  const [profile] = await section('profile',
    `SELECT id, name, email, role, phone, fitness_goal, experience_level, height_cm, weight_kg, created_at
       FROM users WHERE id = $1`, [userId]);

  const [workoutSessions, dailyCheckins, metabolicCheckins, nutritionPlans, adherence, mealCheckins, consents, messages, photos, sport, sessionMetrics, prEvents, perfGoals, perfSnapshots, xpEvents, milestones, challengeParticipations] =
    await Promise.all([
      section('workout_sessions', `SELECT * FROM workout_sessions WHERE user_id = $1 ORDER BY id`, [userId]),
      section('daily_checkins', `SELECT * FROM user_daily_checkins WHERE user_id = $1 ORDER BY id`, [userId]),
      section('metabolic_checkins', `SELECT * FROM user_metabolic_checkins WHERE user_id = $1 ORDER BY id`, [userId]),
      section('nutrition_plans', `SELECT * FROM nutrition_plans WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('nutrition_adherence', `SELECT * FROM nutrition_adherence_checkins WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('meal_checkins', `SELECT * FROM nutrition_meal_checkins WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('consents', `SELECT scope, professional_id, professional_role, status, granted_at, revoked_at FROM user_data_consents WHERE user_id = $1`, [userId]),
      section('messages', `SELECT id, conversation_id, sender_role, text, created_at FROM chat_messages WHERE sender_id = $1 ORDER BY id`, [userId]),
      section('progress_photos', `SELECT id, storage_key, content_type, taken_at, pose, note, status, created_at FROM progress_photos WHERE user_id = $1 AND status = 'active' ORDER BY id`, [userId]),
      section('sport_profile', `SELECT * FROM user_sport_profile WHERE user_id = $1`, [userId]),
      // Módulo Performance (Spec 033). Dado derivado continua sendo dado do
      // titular: se ele pede a própria cópia, tem que vir junto.
      section('performance_session_metrics', `SELECT * FROM workout_session_metrics WHERE user_id = $1 ORDER BY performed_at`, [userId]),
      section('performance_pr_events', `SELECT * FROM user_pr_events WHERE user_id = $1 ORDER BY achieved_at`, [userId]),
      section('performance_goals', `SELECT * FROM user_performance_goals WHERE user_id = $1 ORDER BY id`, [userId]),
      section('performance_snapshots', `SELECT * FROM user_performance_snapshots WHERE user_id = $1 ORDER BY snapshot_date`, [userId]),
      // Spec 034. O extrato de XP e os marcos seguem a mesma regra: o aluno
      // pediu a própria cópia, e "derivado" não deixa de ser dele.
      section('xp_events', `SELECT * FROM xp_events WHERE user_id = $1 ORDER BY id`, [userId]),
      section('milestones', `SELECT * FROM user_milestones WHERE user_id = $1 ORDER BY unlocked_at`, [userId]),
      // Participações em desafio: o dado é do titular. O desafio em si é do
      // personal — daqui vai só o que descreve a participação DESTA pessoa.
      section(
        'challenges',
        `SELECT p.challenge_id, c.title, c.kind, c.starts_on, c.ends_on,
                p.status, p.invited_at, p.joined_at, p.left_at, p.completed_at,
                p.consent_ack_at, p.final_pct
           FROM challenge_participants p
           JOIN challenges c ON c.id = p.challenge_id
          WHERE p.user_id = $1
          ORDER BY p.id`,
        [userId],
      ),
    ]);

  // URLs de leitura assinadas curtas para as fotos (não expor storage_key cru).
  let photosWithUrls = photos;
  if (isStorageConfigured() && photos.length > 0) {
    const storage = getStorage();
    photosWithUrls = await Promise.all(
      photos.map(async (p: any) => ({
        ...p,
        storage_key: undefined,
        url: await storage.createDownloadUrl(p.storage_key, 600).catch(() => null),
      })),
    );
  }

  return {
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    workoutSessions,
    dailyCheckins,
    metabolicCheckins,
    nutrition: { plans: nutritionPlans, adherence, mealCheckins },
    progressPhotos: photosWithUrls,
    consents,
    messages,
    sportProfile: sport[0] ?? null,
    performance: {
      sessionMetrics,
      prEvents,
      goals: perfGoals,
      snapshots: perfSnapshots,
    },
    community: {
      xpEvents,
      milestones,
      challenges: challengeParticipations,
    },
  };
}
