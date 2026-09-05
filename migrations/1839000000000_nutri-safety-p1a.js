/**
 * SPEC 035 — Nutri Safety, Data Integrity & Truth Layer (P1A).
 *
 * Três correções de schema, todas aditivas ou sobre colunas comprovadamente
 * vazias — nenhuma migra dado real porque não HÁ dado real nesses caminhos:
 *
 * 1. `nutrition_plan_meals.deleted_at` — soft-delete. A edição de plano fazia
 *    DELETE + reinsert das refeições, cascateando sobre
 *    `nutrition_meal_checkins` (histórico de adesão do paciente) e
 *    `nutrition_meal_alternatives`. A partir desta migration, uma refeição
 *    removida pelo nutri só é hard-deleted se nunca teve check-in; se tem
 *    histórico, é marcada `deleted_at` e some das leituras ativas sem apagar
 *    o que o paciente já registrou.
 *
 * 2. `nutrition_meal_reminders.meal_id` — era `uuid` sem FK, mas
 *    `nutrition_plan_meals.id` é `integer` (serial). O cast `npm.id::uuid` em
 *    `pushService.dispatchMealReminders` sempre lançou erro de tipo — a
 *    query nunca completou uma vez sequer, então esta coluna está
 *    garantidamente vazia em qualquer ambiente. Corrigida para `integer` com
 *    FK real, o que desbloqueia o cron de lembretes de refeição.
 *
 * 3. `nutrition_voice_notes.anchor_meal_id` — mesmo engano de tipo na mesma
 *    migration original (1791600000000). Nunca há caminho no produto que
 *    grave um valor nela (o cliente não envia `anchorMealId`), então também
 *    está garantidamente vazia. Corrigida para `integer` com FK
 *    `ON DELETE SET NULL` — perder a âncora não deve apagar a nota.
 *
 * Ambas as correções de tipo têm uma guarda em `up()`: se alguma linha
 * existir com `meal_id`/`anchor_meal_id` preenchido, a migration aborta em
 * vez de descartar dado silenciosamente (SPEC 035 §9 — nunca inventar ou
 * descartar dado sem registrar).
 *
 * Escrita com `pgm.db.query` puro (sem o DSL `pgm.addColumn`/`createIndex`/
 * `addConstraint`) — convenção do repo para toda migration a partir de
 * 1823000000000: `restorePerformanceSchema` (testes de integração) reaplica
 * essas migrations com um `pgm` mínimo que só implementa `db.query`.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // -------------------------------------------------------------------
  // 1. Soft-delete de refeições
  // -------------------------------------------------------------------
  await pgm.db.query(`
    ALTER TABLE nutrition_plan_meals ADD COLUMN IF NOT EXISTS deleted_at timestamptz
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS npm_plan_active_idx
      ON nutrition_plan_meals (plan_id) WHERE deleted_at IS NULL
  `);

  // -------------------------------------------------------------------
  // 2. nutrition_meal_reminders.meal_id: uuid (sem FK) -> integer com FK
  //
  // Guardas de idempotência (não só de segurança): `restorePerformanceSchema`
  // (testes de integração) reaplica `up()` sobre um banco que já rodou esta
  // migration antes — sem checar o tipo/constraint atuais, o segundo ALTER
  // TYPE ou o segundo ADD CONSTRAINT quebrariam com erro de duplicidade.
  // -------------------------------------------------------------------
  const reminderColType = await pgm.db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'nutrition_meal_reminders' AND column_name = 'meal_id'`,
  );
  if (reminderColType.rows[0]?.data_type === 'uuid') {
    const reminders = await pgm.db.query(
      `SELECT COUNT(*)::int AS n FROM nutrition_meal_reminders WHERE meal_id IS NOT NULL`,
    );
    if (reminders.rows[0].n > 0) {
      throw new Error(
        `[1839] nutrition_meal_reminders tem ${reminders.rows[0].n} linha(s) com meal_id preenchido — ` +
          'a migration assumia a coluna sempre vazia (o cast uuid quebrava a query antes de qualquer INSERT). ' +
          'Abortando: decisão manual necessária antes de trocar o tipo.',
      );
    }
    await pgm.db.query(`ALTER TABLE nutrition_meal_reminders ALTER COLUMN meal_id DROP NOT NULL`);
    await pgm.db.query(`ALTER TABLE nutrition_meal_reminders ALTER COLUMN meal_id TYPE integer USING NULL`);
    await pgm.db.query(`ALTER TABLE nutrition_meal_reminders ALTER COLUMN meal_id SET NOT NULL`);
  }
  const reminderFk = await pgm.db.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'nmr_meal_id_fkey'`,
  );
  if (reminderFk.rows.length === 0) {
    await pgm.db.query(`
      ALTER TABLE nutrition_meal_reminders
        ADD CONSTRAINT nmr_meal_id_fkey FOREIGN KEY (meal_id)
        REFERENCES nutrition_plan_meals(id) ON DELETE CASCADE
    `);
  }

  // -------------------------------------------------------------------
  // 3. nutrition_voice_notes.anchor_meal_id: uuid -> integer com FK
  // -------------------------------------------------------------------
  const anchorColType = await pgm.db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'nutrition_voice_notes' AND column_name = 'anchor_meal_id'`,
  );
  if (anchorColType.rows[0]?.data_type === 'uuid') {
    const voiceNotes = await pgm.db.query(
      `SELECT COUNT(*)::int AS n FROM nutrition_voice_notes WHERE anchor_meal_id IS NOT NULL`,
    );
    if (voiceNotes.rows[0].n > 0) {
      throw new Error(
        `[1839] nutrition_voice_notes tem ${voiceNotes.rows[0].n} linha(s) com anchor_meal_id preenchido — ` +
          'abortando pelo mesmo motivo da correção de nutrition_meal_reminders.',
      );
    }
    await pgm.db.query(`ALTER TABLE nutrition_voice_notes ALTER COLUMN anchor_meal_id TYPE integer USING NULL`);
  }
  const anchorFk = await pgm.db.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'nvn_anchor_meal_id_fkey'`,
  );
  if (anchorFk.rows.length === 0) {
    await pgm.db.query(`
      ALTER TABLE nutrition_voice_notes
        ADD CONSTRAINT nvn_anchor_meal_id_fkey FOREIGN KEY (anchor_meal_id)
        REFERENCES nutrition_plan_meals(id) ON DELETE SET NULL
    `);
  }
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE nutrition_voice_notes DROP CONSTRAINT IF EXISTS nvn_anchor_meal_id_fkey`);
  await pgm.db.query(`ALTER TABLE nutrition_voice_notes ALTER COLUMN anchor_meal_id TYPE uuid USING NULL`);

  await pgm.db.query(`ALTER TABLE nutrition_meal_reminders DROP CONSTRAINT IF EXISTS nmr_meal_id_fkey`);
  await pgm.db.query(`ALTER TABLE nutrition_meal_reminders ALTER COLUMN meal_id TYPE uuid USING NULL`);
  await pgm.db.query(`ALTER TABLE nutrition_meal_reminders ALTER COLUMN meal_id SET NOT NULL`);

  await pgm.db.query(`DROP INDEX IF EXISTS npm_plan_active_idx`);
  await pgm.db.query(`ALTER TABLE nutrition_plan_meals DROP COLUMN IF EXISTS deleted_at`);
};
