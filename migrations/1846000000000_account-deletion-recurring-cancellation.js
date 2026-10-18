/**
 * Encerramento de conta com cobrança recorrente (Spec 040).
 *
 * Excluir a conta não cancelava nada no Mercado Pago, e o CASCADE ainda apagava a linha que
 * guardava o id da recorrência — a cobrança seguia no cartão do titular sem como reconciliar.
 * Agora a exclusão só se conclui depois que as recorrências DO PRÓPRIO titular estão
 * canceladas (ou em estado terminal aceitável), e o que falta fica reconciliável.
 *
 * Duas tabelas novas, SEM FK para `users` de propósito: o pedido precisa sobreviver à
 * exclusão do usuário (é a evidência do que foi cancelado) e não pode ser levado por CASCADE.
 * Só guardam hash do e-mail, ids numéricos e ids de recorrência — nenhuma PII.
 *
 *  - account_deletion_requests       o pedido: estado, tentativas, prazo (24h) e próxima tentativa.
 *                                     No máximo UM aberto por usuário (índice único parcial).
 *  - account_deletion_cancellations  uma linha por recorrência a cancelar; UNIQUE no id do MP
 *                                     torna o enfileiramento idempotente.
 *
 * Estados do pedido:
 *   pending_cancellation  aguardando o gateway; o job de 6 em 6 horas retenta.
 *   stalled               esgotou as tentativas/prazo: conta mantida, evidência operacional
 *                         gerada, reconciliação manual (nunca segue cobrando em silêncio).
 *   completed             recorrências encerradas e conta excluída.
 *
 * `account_deletions` (tombstone da Spec 025) ganha a contagem do que foi encerrado.
 *
 * Aditiva e reversível.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS account_deletion_requests (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER      NOT NULL,
      email_hash     VARCHAR(64)  NOT NULL,
      requested_by   VARCHAR(12)  NOT NULL DEFAULT 'self' CHECK (requested_by IN ('self','admin')),
      reason         VARCHAR(120),
      status         VARCHAR(24)  NOT NULL DEFAULT 'pending_cancellation'
                       CHECK (status IN ('pending_cancellation','stalled','completed')),
      attempts       INTEGER      NOT NULL DEFAULT 0,
      next_retry_at  TIMESTAMPTZ,
      deadline_at    TIMESTAMPTZ  NOT NULL,
      last_error     VARCHAR(200),
      stalled_at     TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_adr_open_per_user
      ON account_deletion_requests (user_id)
      WHERE status IN ('pending_cancellation','stalled')
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_adr_due
      ON account_deletion_requests (next_retry_at)
      WHERE status = 'pending_cancellation'
  `);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS account_deletion_cancellations (
      id                 BIGSERIAL PRIMARY KEY,
      request_id         BIGINT       NOT NULL REFERENCES account_deletion_requests(id) ON DELETE CASCADE,
      source_table       VARCHAR(48)  NOT NULL
                           CHECK (source_table IN ('user_subscriptions','personal_platform_subscriptions',
                                                   'professional_subscriptions','personal_student_subscriptions')),
      mp_preapproval_id  VARCHAR(120) NOT NULL,
      status             VARCHAR(20)  NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','cancelled','already_terminal','not_found')),
      attempts           INTEGER      NOT NULL DEFAULT 0,
      last_error         VARCHAR(200),
      resolved_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_adc_preapproval UNIQUE (mp_preapproval_id)
    )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_adc_request ON account_deletion_cancellations (request_id)
  `);

  await pgm.db.query(`ALTER TABLE account_deletions ADD COLUMN IF NOT EXISTS subscriptions_cancelled INTEGER NOT NULL DEFAULT 0`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE account_deletions DROP COLUMN IF EXISTS subscriptions_cancelled`);
  await pgm.db.query(`DROP TABLE IF EXISTS account_deletion_cancellations`);
  await pgm.db.query(`DROP TABLE IF EXISTS account_deletion_requests`);
};
