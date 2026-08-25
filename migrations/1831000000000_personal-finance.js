/**
 * Gestão financeira da carteira do personal (Onda F1).
 *
 * ## Não é processamento de pagamento
 *
 * O dinheiro continua fora da plataforma — PIX, dinheiro, MP do próprio
 * personal. Aqui só se registra o **acordo** e o **status** de cada cobrança,
 * para que o personal saiba quem pagou, quem atrasou e quanto entra no mês.
 * Por isso nada nestas tabelas fala com gateway.
 *
 * ## Por que tabelas novas, e não `personal_billing_*`
 *
 * As quatro tabelas de `1747200002000_personal-billing.js` modelam assinatura
 * recorrente via Mercado Pago pre-approval (dinheiro passando pela plataforma)
 * e estão **congeladas** pela decisão V1 "sem take-rate". Reaproveitá-las
 * exigiria descongelar aquele domínio e misturar duas semânticas de cobrança
 * na mesma linha. Elas seguem intocadas; `origin`/`external_reference` abaixo
 * reservam o espaço de uma conciliação MP futura sem acoplar nada agora.
 *
 * ## Estado armazenado é o mínimo; "vencido" é derivado
 *
 * `status` guarda só o que uma ação humana decide (`open|paid|partial|waived|
 * canceled`). **Vencido** e **a vencer** saem da comparação de `due_date` com o
 * dia corrente na leitura — nenhum cron precisa varrer a tabela virando status,
 * e não existe janela em que o banco diz "em aberto" enquanto a tela já mostra
 * "vencido".
 *
 * ## `UNIQUE (plan_id, competence)` é o que sustenta a geração preguiçosa
 *
 * As cobranças são criadas na leitura (`ensureCharges`), não por job agendado.
 * Duas requisições simultâneas do mesmo personal tentam inserir a mesma
 * competência; o índice único + `ON CONFLICT DO NOTHING` resolvem no banco, que
 * é o único lugar onde a corrida realmente se decide.
 *
 * ## Toda FK para `users` declara ação de delete
 *
 * A migration 1822 nasceu de 12 FKs `NO ACTION` que faziam `DELETE
 * /api/user/account` responder 500 em 100% das contas. Aqui: as linhas do
 * titular vão junto (`CASCADE`), e `recorded_by` — que aponta para QUEM
 * registrou, não para o dono do dado — vira NULL, preservando o histórico
 * financeiro do outro lado.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_financial_plans (
      id               SERIAL PRIMARY KEY,
      personal_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
      period           VARCHAR(20) NOT NULL
                       CHECK (period IN ('monthly','quarterly','semiannual','annual','package','single')),
      due_day          SMALLINT CHECK (due_day BETWEEN 1 AND 28),
      package_sessions INTEGER,
      auto_renew       BOOLEAN NOT NULL DEFAULT true,
      payment_method   VARCHAR(20)
                       CHECK (payment_method IN ('pix','cash','card','transfer','mp','other')),
      status           VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','ended')),
      starts_on        DATE NOT NULL DEFAULT CURRENT_DATE,
      ends_on          DATE,
      notes            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  // Um acordo ativo por par. Parcial porque acordos encerrados se acumulam por
  // design (histórico), e um único total impediria o segundo contrato do mesmo
  // aluno.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pfp_personal_student_active
      ON personal_financial_plans (personal_id, student_id)
      WHERE status = 'active'`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pfp_personal_status
      ON personal_financial_plans (personal_id, status)`);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_financial_charges (
      id                 SERIAL PRIMARY KEY,
      plan_id            INTEGER NOT NULL REFERENCES personal_financial_plans(id) ON DELETE CASCADE,
      personal_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      competence         DATE NOT NULL,
      due_date           DATE NOT NULL,
      amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
      paid_cents         INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
      status             VARCHAR(20) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','paid','partial','waived','canceled')),
      paid_at            TIMESTAMPTZ,
      paid_method        VARCHAR(20)
                         CHECK (paid_method IN ('pix','cash','card','transfer','mp','other')),
      origin             VARCHAR(10) NOT NULL DEFAULT 'manual'
                         CHECK (origin IN ('manual','mp')),
      external_reference VARCHAR(120),
      notes              TEXT,
      recorded_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_pfc_plan_competence UNIQUE (plan_id, competence)
    )`);

  // `personal_id` é desnormalizado de propósito: todo filtro de isolamento
  // ("as cobranças DESTE personal") passa por ele, e resolvê-lo por join com o
  // plano em cada leitura só transformaria a garantia mais importante do módulo
  // na mais fácil de esquecer.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pfc_personal_status_due
      ON personal_financial_charges (personal_id, status, due_date)`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pfc_personal_competence
      ON personal_financial_charges (personal_id, competence)`);

  // Ledger imutável: só INSERT, via serviço. Estorno é um evento novo
  // (`payment_reverted`), nunca a remoção do evento anterior.
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS personal_financial_events (
      id           SERIAL PRIMARY KEY,
      personal_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      charge_id    INTEGER REFERENCES personal_financial_charges(id) ON DELETE CASCADE,
      plan_id      INTEGER REFERENCES personal_financial_plans(id) ON DELETE CASCADE,
      event_type   VARCHAR(40) NOT NULL CHECK (event_type IN (
                     'plan_created','plan_updated','plan_paused','plan_ended',
                     'charge_created','payment_recorded','payment_reverted',
                     'charge_waived','charge_canceled'
                   )),
      actor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pfe_personal_created
      ON personal_financial_events (personal_id, created_at DESC)`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_pfe_charge
      ON personal_financial_events (charge_id)`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS personal_financial_events`);
  await pgm.db.query(`DROP TABLE IF EXISTS personal_financial_charges`);
  await pgm.db.query(`DROP TABLE IF EXISTS personal_financial_plans`);
};
