/**
 * Spec 005 — Onda B Nutri: Rotina Metabólica Viva
 * Novas tabelas: push_subscriptions, nutrition_meal_reminders, nutrition_voice_notes
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── Web Push subscriptions (cross-feature) ─────────────────────────────────
  pgm.createTable('push_subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    endpoint: { type: 'text', notNull: true },
    p256dh: { type: 'text', notNull: true },
    auth: { type: 'text', notNull: true },
    device_label: { type: 'varchar(120)', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('push_subscriptions', 'uq_push_sub_user_endpoint', 'UNIQUE (user_id, endpoint)');
  pgm.createIndex('push_subscriptions', 'user_id');

  // ── Nutrition meal reminders — controle de dispatch ────────────────────────
  pgm.createTable('nutrition_meal_reminders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    patient_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    meal_id: { type: 'uuid', notNull: true },
    reminder_date: { type: 'date', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    push_result: { type: 'varchar(32)', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('nutrition_meal_reminders', 'uq_nmr_patient_meal_date', 'UNIQUE (patient_id, meal_id, reminder_date)');
  pgm.createIndex('nutrition_meal_reminders', ['patient_id', 'reminder_date']);

  // ── Nutrition voice notes — nota da nutri visível ao aluno ─────────────────
  pgm.createTable('nutrition_voice_notes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    nutri_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    patient_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    body: { type: 'varchar(240)', notNull: true },
    anchor_meal_id: { type: 'uuid', notNull: false },
    published_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    read_at: { type: 'timestamptz', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'nutrition_voice_notes',
    'chk_nvn_body_len',
    "CHECK (char_length(body) BETWEEN 1 AND 240)"
  );
  pgm.createIndex('nutrition_voice_notes', ['patient_id', 'published_at']);
  pgm.createIndex('nutrition_voice_notes', ['nutri_id', 'patient_id']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('nutrition_voice_notes');
  pgm.dropTable('nutrition_meal_reminders');
  pgm.dropTable('push_subscriptions');
};
