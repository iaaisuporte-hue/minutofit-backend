/**
 * Cobrança recorrente no encerramento de conta (Spec 040).
 *
 * Três decisões de produto sustentam este módulo:
 *
 * 1. **Dono de academia não se exclui sozinho.** Excluir o dono deixaria a academia sem
 *    responsável e o Pro seguiria cobrando no cartão de quem saiu. Exige-se sucessor JÁ
 *    efetivado (outro dono ativo); a transferência é um ato de atendimento — nada aqui
 *    transfere propriedade sozinho.
 * 2. **Só se cancela o que é do titular.** Cancela-se a recorrência cujo contratante é a conta
 *    que está sendo encerrada (assinatura própria do aluno, plano SaaS do personal, contratos
 *    em que o próprio titular é o PAGADOR). Contratos de TERCEIROS — alunos que pagam a um
 *    profissional que está saindo — não são cancelados por este fluxo nem deixados órfãos pelo
 *    CASCADE: o profissional encerra cada contrato pelo fluxo contratual (cancelByProfessional)
 *    e só então exclui a conta.
 * 3. **A conta só some depois que a cobrança do titular parou.** Falha do gateway não apaga
 *    nada: o pedido fica pendente, é retentado (idempotente) pelo cron de 6 em 6 horas durante
 *    até 24h e, esgotado o prazo, vira `stalled` — conta mantida, evidência operacional,
 *    reconciliação manual. Nunca cobrança silenciosa.
 */
import type { PoolClient } from 'pg';
import pool from '../config/database';
import logger from '../lib/logger';
import {
  cancelRecurringAtGateway,
  GatewayCancelError,
  type GatewayOutcome,
} from './recurringCancellation';

type Db = Pick<PoolClient, 'query'>;

// ---------------------------------------------------------------------------
// Janela e backoff (decisão aprovada: até 24h)
// ---------------------------------------------------------------------------

export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A tentativa síncrona da requisição conta como a 1ª; o cron de 6h dá as seguintes (~6h, 12h, 18h, 24h). */
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export const backoffMs = (attemptsDone: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsDone - 1));

// ---------------------------------------------------------------------------
// Bloqueios
// ---------------------------------------------------------------------------

export type DeletionBlockCode =
  | 'academy_owner_transfer_required'
  | 'academy_billing_handover_required'
  | 'client_contracts_active';

const BLOCK_MESSAGES: Record<DeletionBlockCode, string> = {
  academy_owner_transfer_required:
    'Você é o único responsável por uma academia ativa. Antes de excluir a conta, a propriedade precisa ser transferida a outro responsável (ou a academia encerrada formalmente). Fale com o atendimento: s2core.contato@gmail.com.',
  academy_billing_handover_required:
    'A academia que você administra tem assinatura paga em andamento. Antes de excluir a conta, a cobrança precisa passar para o novo responsável. Fale com o atendimento: s2core.contato@gmail.com.',
  client_contracts_active:
    'Você tem contratos ativos com alunos. Encerre cada contrato em Minha rede antes de excluir a conta, para que ninguém continue sendo cobrado por um serviço que deixou de existir.',
};

export class AccountDeletionBlockedError extends Error {
  readonly status = 409;

  constructor(
    readonly code: DeletionBlockCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(BLOCK_MESSAGES[code]);
    this.name = 'AccountDeletionBlockedError';
  }
}

interface AcademyRow {
  id: number;
  display_name: string | null;
  is_registered_owner: boolean;
  has_other_owner: boolean;
  has_paid_subscription: boolean;
}

/**
 * Lança `AccountDeletionBlockedError` se a exclusão deixaria uma academia sem responsável, ou um
 * contrato de terceiros órfão. É a fonte de verdade — a trava da UI é só conveniência.
 */
export async function assertDeletionAllowed(userId: number, db: Db = pool): Promise<void> {
  // "Academia ativa" = não encerrada formalmente (`cancelled`). Suspensa/em trial ainda pode voltar
  // e continua precisando de responsável — era exatamente o furo da trava que dependia da lista de
  // academias ativas do app.
  const academies = await db.query<AcademyRow>(
    `SELECT a.id,
            a.display_name,
            (a.owner_user_id = $1) AS is_registered_owner,
            EXISTS (
              SELECT 1 FROM academy_users au
                JOIN academy_roles ar ON ar.id = au.role_id
               WHERE au.academy_id = a.id AND au.user_id <> $1
                 AND au.status = 'active' AND au.is_active = TRUE
                 AND ar.slug = 'academy_owner'
            ) AS has_other_owner,
            EXISTS (
              SELECT 1 FROM academy_subscriptions s
               WHERE s.academy_id = a.id
                 AND s.mp_preapproval_id IS NOT NULL
                 AND s.status IN ('active','trial','pending')
            ) AS has_paid_subscription
       FROM academies a
      WHERE a.status <> 'cancelled'
        AND ( a.owner_user_id = $1
              OR EXISTS (
                SELECT 1 FROM academy_users au
                  JOIN academy_roles ar ON ar.id = au.role_id
                 WHERE au.academy_id = a.id AND au.user_id = $1
                   AND au.status = 'active' AND ar.slug = 'academy_owner'
              ) )`,
    [userId],
  );

  const semSucessor = academies.rows.filter((a) => !a.has_other_owner);
  if (semSucessor.length > 0) {
    throw new AccountDeletionBlockedError('academy_owner_transfer_required', {
      academies: semSucessor.map((a) => ({ id: a.id, displayName: a.display_name })),
    });
  }

  // Há sucessor, mas a assinatura paga é um contrato da academia no cartão de quem tem o registro
  // de dono. Cancelá-la mataria o produto de terceiros; deixá-la seria cobrar quem saiu.
  const cobrando = academies.rows.filter((a) => a.is_registered_owner && a.has_paid_subscription);
  if (cobrando.length > 0) {
    throw new AccountDeletionBlockedError('academy_billing_handover_required', {
      academies: cobrando.map((a) => ({ id: a.id, displayName: a.display_name })),
    });
  }

  // Contratos em que o titular é o PROFISSIONAL: o pagador é o aluno. O CASCADE apagaria a linha
  // (e o id da recorrência) e o aluno seguiria pagando por um serviço que não existe.
  const contratos = await db.query<{ n: string }>(
    `SELECT (
        (SELECT COUNT(*) FROM professional_subscriptions
          WHERE professional_id = $1
            AND (status IN ('active','paused')
                 OR (status = 'pending_payment' AND mp_preapproval_id IS NOT NULL)))
      + (SELECT COUNT(*) FROM personal_student_subscriptions
          WHERE personal_id = $1
            AND (status IN ('active','paused')
                 OR (status = 'pending' AND mp_preapproval_id IS NOT NULL)))
     )::text AS n`,
    [userId],
  );
  const n = Number(contratos.rows[0]?.n ?? 0);
  if (n > 0) throw new AccountDeletionBlockedError('client_contracts_active', { count: n });
}

// ---------------------------------------------------------------------------
// Recorrências do próprio titular
// ---------------------------------------------------------------------------

export type RecurrenceSource =
  | 'user_subscriptions'
  | 'personal_platform_subscriptions'
  | 'professional_subscriptions'
  | 'personal_student_subscriptions';

export interface Recurrence {
  source: RecurrenceSource;
  preapprovalId: string;
}

/**
 * Recorrências cujo CONTRATANTE é este titular:
 *  - `user_subscriptions`: o aluno paga a própria assinatura do app;
 *  - `personal_platform_subscriptions`: o personal paga o SaaS;
 *  - `professional_subscriptions` / `personal_student_subscriptions` onde ele é o ALUNO (pagador).
 * Todas, em qualquer status local: quem decide se ainda existe cobrança é o gateway.
 */
export async function listOwnedRecurrences(userId: number, db: Db = pool): Promise<Recurrence[]> {
  const { rows } = await db.query<{ source: RecurrenceSource; ref: string }>(
    `SELECT 'user_subscriptions' AS source, mercado_pago_subscription_id AS ref
       FROM user_subscriptions
      WHERE user_id = $1 AND COALESCE(mercado_pago_subscription_id, '') <> ''
     UNION ALL
     SELECT 'personal_platform_subscriptions', mp_preapproval_id
       FROM personal_platform_subscriptions
      WHERE personal_id = $1 AND COALESCE(mp_preapproval_id, '') <> ''
     UNION ALL
     SELECT 'professional_subscriptions', mp_preapproval_id
       FROM professional_subscriptions
      WHERE student_id = $1 AND COALESCE(mp_preapproval_id, '') <> ''
     UNION ALL
     SELECT 'personal_student_subscriptions', mp_preapproval_id
       FROM personal_student_subscriptions
      WHERE student_id = $1 AND COALESCE(mp_preapproval_id, '') <> ''`,
    [userId],
  );

  const seen = new Set<string>();
  const out: Recurrence[] = [];
  for (const r of rows) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    out.push({ source: r.source, preapprovalId: r.ref });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pedido de encerramento
// ---------------------------------------------------------------------------

export type RequestStatus = 'pending_cancellation' | 'stalled' | 'completed';

export interface DeletionRequest {
  id: number;
  userId: number;
  emailHash: string;
  requestedBy: 'self' | 'admin';
  reason: string | null;
  status: RequestStatus;
  attempts: number;
  deadlineAt: Date;
  nextRetryAt: Date | null;
}

const mapRequest = (r: Record<string, any>): DeletionRequest => ({
  id: Number(r.id),
  userId: r.user_id,
  emailHash: r.email_hash,
  requestedBy: r.requested_by,
  reason: r.reason,
  status: r.status,
  attempts: r.attempts,
  deadlineAt: r.deadline_at,
  nextRetryAt: r.next_retry_at ?? null,
});

/** Abre o pedido do usuário — ou devolve o que já está aberto (no máximo um por usuário). */
export async function openRequest(
  userId: number,
  emailHash: string,
  requestedBy: 'self' | 'admin',
  reason?: string,
): Promise<DeletionRequest> {
  const { rows } = await pool.query(
    `INSERT INTO account_deletion_requests (user_id, email_hash, requested_by, reason, deadline_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::bigint * INTERVAL '1 millisecond'))
     ON CONFLICT (user_id) WHERE status IN ('pending_cancellation','stalled')
       DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId, emailHash, requestedBy, reason ?? null, RETRY_WINDOW_MS],
  );
  return mapRequest(rows[0]);
}

export async function findOpenRequest(userId: number): Promise<DeletionRequest | null> {
  const { rows } = await pool.query(
    `SELECT * FROM account_deletion_requests
      WHERE user_id = $1 AND status IN ('pending_cancellation','stalled') LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function getRequest(requestId: number): Promise<DeletionRequest | null> {
  const { rows } = await pool.query(`SELECT * FROM account_deletion_requests WHERE id = $1`, [requestId]);
  return rows[0] ? mapRequest(rows[0]) : null;
}

/** Enfileira as recorrências (idempotente: o id do gateway é único). */
export async function enqueueCancellations(requestId: number, recurrences: Recurrence[]): Promise<void> {
  for (const r of recurrences) {
    await pool.query(
      `INSERT INTO account_deletion_cancellations (request_id, source_table, mp_preapproval_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (mp_preapproval_id) DO NOTHING`,
      [requestId, r.source, r.preapprovalId],
    );
  }
}

export type GatewayCancel = (preapprovalId: string) => Promise<GatewayOutcome>;

/**
 * Tenta cancelar, no gateway, tudo o que ainda está pendente neste pedido. Cada falha é gravada
 * (tipo da falha, nunca o corpo da resposta); o que der certo é marcado terminal na hora.
 * Devolve quantas ficaram pendentes.
 */
export async function attemptPendingCancellations(
  requestId: number,
  gateway: GatewayCancel = cancelRecurringAtGateway,
): Promise<{ pending: number; lastError: string | null }> {
  const { rows } = await pool.query<{ id: string; mp_preapproval_id: string }>(
    `SELECT id, mp_preapproval_id FROM account_deletion_cancellations
      WHERE request_id = $1 AND status = 'pending' ORDER BY id`,
    [requestId],
  );

  let lastError: string | null = null;
  const results = await Promise.all(
    rows.map(async (row) => {
      try {
        const outcome = await gateway(row.mp_preapproval_id);
        // 404 libera a exclusão, mas também é o que um token de OUTRA conta/ambiente devolveria para
        // uma recorrência viva. Não dá para distinguir daqui: fica o alerta para quem opera conferir.
        if (outcome === 'not_found') {
          logger.warn({ requestId, cancellationId: row.id }, '[account-deletion] recorrência não encontrada no gateway — tratada como inexistente; conferir se o token/ambiente é o mesmo que a criou');
        }
        await pool.query(
          `UPDATE account_deletion_cancellations
              SET status = $2, attempts = attempts + 1, last_error = NULL, resolved_at = NOW()
            WHERE id = $1`,
          [row.id, outcome],
        );
        return true;
      } catch (err) {
        const code = err instanceof GatewayCancelError ? err.message : 'gateway_unknown_error';
        lastError = code;
        await pool.query(
          `UPDATE account_deletion_cancellations SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
          [row.id, code],
        );
        return false;
      }
    }),
  );

  return { pending: results.filter((ok) => !ok).length, lastError };
}

/** Ids de recorrência já resolvidos (terminais) neste pedido. */
export async function resolvedPreapprovals(requestId: number, db: Db = pool): Promise<Set<string>> {
  const { rows } = await db.query<{ mp_preapproval_id: string }>(
    `SELECT mp_preapproval_id FROM account_deletion_cancellations
      WHERE request_id = $1 AND status <> 'pending'`,
    [requestId],
  );
  return new Set(rows.map((r) => r.mp_preapproval_id));
}

export async function countCancelled(requestId: number, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM account_deletion_cancellations WHERE request_id = $1 AND status = 'cancelled'`,
    [requestId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Fecha uma rodada que terminou com pendência: conta a tentativa, agenda a próxima com backoff e,
 * esgotadas as tentativas ou o prazo de 24h, marca `stalled`. Devolve o estado resultante.
 */
export async function recordFailedRound(
  request: DeletionRequest,
  lastError: string | null,
  now: Date = new Date(),
): Promise<{ status: RequestStatus; attempts: number; becameStalled: boolean }> {
  // `attempts + 1` no SQL (e não o valor lido antes): o cron e a requisição do usuário podem fechar
  // rodadas ao mesmo tempo, e ler-modificar-escrever perderia uma delas.
  const attempts = request.attempts + 1;

  if (request.status === 'stalled') {
    // Já em reconciliação manual: só registra a tentativa extra, sem reagendar.
    await pool.query(
      `UPDATE account_deletion_requests SET attempts = attempts + 1, last_error = $2, updated_at = NOW() WHERE id = $1`,
      [request.id, lastError],
    );
    return { status: 'stalled', attempts, becameStalled: false };
  }

  const exhausted = attempts >= MAX_ATTEMPTS || now.getTime() >= new Date(request.deadlineAt).getTime();
  if (exhausted) {
    await pool.query(
      `UPDATE account_deletion_requests
          SET status = 'stalled', attempts = attempts + 1, last_error = $2,
              stalled_at = NOW(), next_retry_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [request.id, lastError],
    );
    return { status: 'stalled', attempts, becameStalled: true };
  }

  await pool.query(
    `UPDATE account_deletion_requests
        SET attempts = attempts + 1, last_error = $2,
            next_retry_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE id = $1`,
    [request.id, lastError, backoffMs(attempts)],
  );
  return { status: 'pending_cancellation', attempts, becameStalled: false };
}

/** Pedidos vencidos para retentativa (usado pelo cron). */
export async function listDueRequests(limit = 50): Promise<DeletionRequest[]> {
  const { rows } = await pool.query(
    `SELECT * FROM account_deletion_requests
      WHERE status = 'pending_cancellation' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return rows.map(mapRequest);
}

export async function markStalledByBlock(requestId: number, code: string): Promise<void> {
  await pool.query(
    `UPDATE account_deletion_requests
        SET status = 'stalled', last_error = $2, stalled_at = NOW(), next_retry_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'pending_cancellation'`,
    [requestId, code],
  );
}
