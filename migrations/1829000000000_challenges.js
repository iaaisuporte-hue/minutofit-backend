/**
 * Desafios de accountability (Spec 034, Onda C2).
 *
 * ## O que um desafio é
 *
 * Um **dispositivo de compromisso** com prazo e critério, entre pessoas que já
 * têm relação no produto — a turma de um personal. Não é competição: o
 * progresso de cada participante é medido contra o **próprio plano**, então
 * quem cumpre 3 de 3 fica à frente de quem cumpre 3 de 4. Volume absoluto nunca
 * vence, e é essa regra que separa a tabela abaixo de um app de ranking.
 *
 * ## Duas tabelas, não quatro
 *
 * Não existe `challenge_rules` (a regra é `rule_json` versionado por
 * `rules_version` na própria linha) nem `challenge_progress` (o progresso é
 * derivado na leitura, a partir das métricas canônicas do módulo Performance).
 * Materializar progresso antes de haver evidência de custo criaria um segundo
 * número a manter sincronizado — o defeito recorrente deste repositório.
 *
 * ## O CHECK exige DONO, não uma FK específica
 *
 * `scope='personal'` exige `personal_id`; `scope='academy'` exige `academy_id`.
 * As duas colunas são `ON DELETE SET NULL`, e um CHECK que exigisse a coluna
 * NOT NULL colidiria com o próprio SET NULL, impedindo a exclusão do dono —
 * foi exatamente o que aconteceu nas migrations 1819 (`workout_protocols`) e
 * 1825 (`user_performance_goals`). Aqui o predicado é escrito para tolerar o
 * SET NULL: quando o dono some, a linha deixa de satisfazer o escopo e o
 * serviço de exclusão de conta remove o desafio (precedente da 1826 — entidade
 * operacional não sobrevive ao dono).
 *
 * ## `group_visibility` — escopo de consentimento novo
 *
 * Os 13 escopos existentes cobrem **profissional lendo dado do aluno**.
 * Aparecer numa turma, para **outros alunos**, é divulgação de natureza
 * diferente, e reaproveitar `workouts` seria usar consentimento fora da
 * finalidade declarada. O `down` apaga as linhas do escopo novo ANTES de
 * restaurar o CHECK anterior, senão a constraint volta violada.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS challenges (
      id                 BIGSERIAL PRIMARY KEY,
      scope              TEXT NOT NULL,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      personal_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      academy_id         INTEGER,
      title              TEXT NOT NULL,
      description        TEXT,
      kind               TEXT NOT NULL,
      rule_json          JSONB NOT NULL,
      rules_version      SMALLINT NOT NULL DEFAULT 1,
      starts_on          DATE NOT NULL,
      ends_on            DATE NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pgm.db.query(`
    ALTER TABLE challenges
      DROP CONSTRAINT IF EXISTS challenges_scope_chk,
      DROP CONSTRAINT IF EXISTS challenges_kind_chk,
      DROP CONSTRAINT IF EXISTS challenges_status_chk,
      DROP CONSTRAINT IF EXISTS challenges_window_chk,
      DROP CONSTRAINT IF EXISTS challenges_owner_chk`);

  await pgm.db.query(`
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_scope_chk  CHECK (scope IN ('personal', 'academy')),
      ADD CONSTRAINT challenges_kind_chk   CHECK (kind IN ('consistency', 'weekly_goal', 'comeback')),
      ADD CONSTRAINT challenges_status_chk CHECK (status IN ('draft', 'active', 'finished', 'cancelled')),
      -- Uma janela precisa ter duração. Sem isto, um desafio de zero dias
      -- passaria a existir e o denominador do progresso seria indefinido.
      ADD CONSTRAINT challenges_window_chk CHECK (ends_on > starts_on),
      ADD CONSTRAINT challenges_owner_chk  CHECK (
        (scope = 'personal' AND personal_id IS NOT NULL)
        OR (scope = 'academy' AND academy_id IS NOT NULL)
        -- Terceira alternativa deliberada: quando o dono é excluído e a FK vira
        -- NULL, a linha continua válida até o serviço de exclusão removê-la.
        -- Sem ela, apagar a conta de um personal falharia por constraint.
        OR (personal_id IS NULL AND academy_id IS NULL)
      )`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_challenges_personal
      ON challenges (personal_id, status, starts_on DESC)`);

  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS challenge_participants (
      id             BIGSERIAL PRIMARY KEY,
      challenge_id   BIGINT  NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status         TEXT NOT NULL DEFAULT 'invited',
      invited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      joined_at      TIMESTAMPTZ,
      left_at        TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ,
      consent_ack_at TIMESTAMPTZ,
      final_pct      NUMERIC(5,2),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pgm.db.query(`
    ALTER TABLE challenge_participants
      DROP CONSTRAINT IF EXISTS challenge_participants_status_chk,
      DROP CONSTRAINT IF EXISTS challenge_participants_uq,
      DROP CONSTRAINT IF EXISTS challenge_participants_completed_chk`);

  await pgm.db.query(`
    ALTER TABLE challenge_participants
      ADD CONSTRAINT challenge_participants_status_chk
        CHECK (status IN ('invited', 'active', 'left', 'completed')),
      -- Uma pessoa participa de um desafio uma vez. É o que torna o join
      -- idempotente sem lógica de aplicação.
      ADD CONSTRAINT challenge_participants_uq UNIQUE (challenge_id, user_id),
      -- Conclusão é um fato congelado: ou tem data e percentual, ou não
      -- aconteceu. Sem este CHECK, um estado meio-concluído passaria a existir
      -- e o histórico do desafio deixaria de ser auditável.
      ADD CONSTRAINT challenge_participants_completed_chk CHECK (
        (status = 'completed' AND completed_at IS NOT NULL AND final_pct IS NOT NULL)
        OR (status <> 'completed')
      )`);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_challenge_participants_user
      ON challenge_participants (user_id, status)`);

  // ── Escopo de consent `group_visibility` ──────────────────────────────────
  // Mesmo padrão dos três precedentes (1790600000000, 1792000000000,
  // 1809000000000): o CHECK é enumerado e precisa ser reescrito inteiro.
  await pgm.db.query(
    `ALTER TABLE user_data_consents DROP CONSTRAINT IF EXISTS user_data_consents_scope_check`,
  );
  await pgm.db.query(`
    ALTER TABLE user_data_consents ADD CONSTRAINT user_data_consents_scope_check
    CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','clinical_nutrition',
      'parq_anamnese','activity_logs','chat_history','sports','group_visibility'
    ))
  `);
  // Sem backfill: aparecer para outros alunos é opt-in por desafio
  // (`consent_ack_at`), e conceder retroativamente seria decidir por quem não
  // foi perguntado.
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS challenge_participants`);
  await pgm.db.query(`DROP TABLE IF EXISTS challenges`);

  await pgm.db.query(`DELETE FROM user_data_consents WHERE scope = 'group_visibility'`);
  await pgm.db.query(
    `ALTER TABLE user_data_consents DROP CONSTRAINT IF EXISTS user_data_consents_scope_check`,
  );
  await pgm.db.query(`
    ALTER TABLE user_data_consents ADD CONSTRAINT user_data_consents_scope_check
    CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','clinical_nutrition',
      'parq_anamnese','activity_logs','chat_history','sports'
    ))
  `);
};
