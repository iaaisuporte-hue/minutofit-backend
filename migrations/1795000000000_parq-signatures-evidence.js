/**
 * PAR-Q+ Evidence Layer
 * Adds append-only `parq_signatures` table (legal source of truth) and two
 * fast-path columns on `users` so that physical-activity clearance can be
 * derived without a JOIN on the hot /auth/me path.
 *
 * Signature level 1 = drawn canvas + checkbox + IP + UA + SHA-256 hash.
 * Signature level 2 = level 1 + OTP (columns present but unused until implemented).
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── 1. Append-only evidence table ─────────────────────────────────────────
  pgm.createTable('parq_signatures', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: {
      type: 'integer',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    form_version:       { type: 'varchar(64)', notNull: true },
    parq_answers:       { type: 'jsonb', notNull: true },
    parq_any_yes:       { type: 'boolean', notNull: true },
    health_flags:       { type: 'jsonb', notNull: true },
    signature_data:     { type: 'text', notNull: true },
    acceptance_checkbox: { type: 'boolean', notNull: true, default: true },
    evidence_hash:      { type: 'char(64)', notNull: true },
    signature_level:    { type: 'smallint', notNull: true, default: 1 },
    signed_at:          { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at:         { type: 'timestamptz', notNull: true },
    ip:                 { type: 'inet' },
    user_agent:         { type: 'text' },
    // Level-2 OTP fields — schema only, not used until implemented
    otp_channel:              { type: 'varchar(16)' },
    otp_verified_at:          { type: 'timestamptz' },
    otp_destination_masked:   { type: 'varchar(64)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('parq_signatures', ['user_id', 'signed_at'], { name: 'idx_parq_sig_user_signed' });
  pgm.createIndex('parq_signatures', ['user_id', 'expires_at'], { name: 'idx_parq_sig_user_expires' });

  // ── 2. Fast-path columns on users (latest pointer — avoids JOIN on /auth/me) ─
  pgm.addColumn('users', {
    parq_expires_at:      { type: 'timestamptz' },
    parq_signature_level: { type: 'smallint' },
  });

  // ── 3. Backfill: existing signed users keep access (12-month grace from sign date) ─
  pgm.sql(`
    UPDATE users
    SET
      parq_expires_at      = parq_signed_at + INTERVAL '12 months',
      parq_signature_level = 1
    WHERE parq_signed_at IS NOT NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('users', 'parq_expires_at');
  pgm.dropColumn('users', 'parq_signature_level');
  pgm.dropTable('parq_signatures');
};
