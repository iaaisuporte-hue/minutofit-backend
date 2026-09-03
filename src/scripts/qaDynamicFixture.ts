/**
 * Fixture para QA da feature "Execução Dinâmica de Treino" (substituir/adicionar
 * exercício). Baseado em src/scripts/qaDemoFixture.ts, adaptado para incluir um
 * par de Bi-Set e 5 exercícios no dia.
 *
 * Uso (rodar a partir do backend, com DATABASE_URL local):
 *   npx tsx /caminho/qaDynamicFixture.ts --setup
 *   npx tsx /caminho/qaDynamicFixture.ts --teardown
 */
import { randomBytes } from 'crypto';

import pool from '../config/database';
import { grantMembership } from '../services/membershipService';
import { findOrCreateUserFromContext } from '../services/userIdentityService';

const TAG = 'qa-dyn';
const EMAIL_ALUNO = `${TAG}-aluno@s2core.invalid`;
const EMAIL_PERSONAL = `${TAG}-personal@s2core.invalid`;
const PLAN_TITLE = 'Ficha QA Dynamic';

const CONSENT_SCOPES = ['profile', 'workouts', 'daily_checkins', 'metabolic', 'body_metrics'];

function documentoSintetico(seed: number): { cpf: string; phone: string } {
  const n = String(Date.now() % 100000).padStart(5, '0') + String(seed).padStart(4, '0');
  return { cpf: `999${n}`.slice(0, 11).padEnd(11, '0'), phone: `1199${n}`.slice(0, 11) };
}

function senhaForte(): string {
  return `Qa${randomBytes(9).toString('base64url')}#7`;
}

async function setup(): Promise<void> {
  const senhaAluno = 'QaDynAluno#2026';
  const senhaPersonal = 'QaDynPersonal#2026';

  const docPersonal = documentoSintetico(11);
  const personal = await findOrCreateUserFromContext({
    email: EMAIL_PERSONAL,
    name: 'QA Dynamic Personal',
    password: senhaPersonal,
    cpf: docPersonal.cpf,
    phone: docPersonal.phone,
    matchBy: ['email'],
  });
  await pool.query(`UPDATE users SET role = 'personal', profile_completed = true WHERE id = $1`, [
    personal.user.id,
  ]);
  await grantMembership(personal.user.id, 'personal', { source: 'corefit' });

  const docAluno = documentoSintetico(12);
  const aluno = await findOrCreateUserFromContext({
    email: EMAIL_ALUNO,
    name: 'QA Dynamic Aluno',
    password: senhaAluno,
    cpf: docAluno.cpf,
    phone: docAluno.phone,
    matchBy: ['email'],
  });
  await pool.query(`UPDATE users SET role = 'user', profile_completed = true WHERE id = $1`, [
    aluno.user.id,
  ]);
  await grantMembership(aluno.user.id, 'app', { source: 'bonus_personal' });

  const tier = await pool.query(
    `SELECT id FROM subscription_tiers WHERE LOWER(name) = 'premium' LIMIT 1`,
  );
  await pool.query(
    `UPDATE user_subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
    [aluno.user.id],
  );
  await pool.query(
    `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
     VALUES ($1, $2, 'active', NOW())`,
    [aluno.user.id, tier.rows[0].id],
  );

  await pool.query(
    `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id)
     VALUES ($1, $2, 'active', NULL)
     ON CONFLICT DO NOTHING`,
    [personal.user.id, aluno.user.id],
  );

  for (const scope of CONSENT_SCOPES) {
    await pool.query(
      `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
       VALUES ($1, $2, 'personal', $3, 'granted')
       ON CONFLICT DO NOTHING`,
      [aluno.user.id, personal.user.id, scope],
    );
  }

  // PAR-Q liberado: sem clearance o aluno não consegue registrar treino.
  await pool.query(
    `UPDATE users SET parq_signed_at = NOW(), parq_any_yes = false WHERE id = $1`,
    [aluno.user.id],
  );

  // 5 exercícios reais do catálogo: 3 comuns + 2 em Bi-Set.
  const ex = await pool.query<{ id: string; name: string }>(
    `SELECT id::text, name FROM exercises ORDER BY name LIMIT 5`,
  );
  if (ex.rows.length < 5) {
    throw new Error('menos de 5 exercícios disponíveis no catálogo');
  }
  const [e1, e2, e3, e4, e5] = ex.rows;
  const BISET_GROUP = 'qa-dyn-biset-1';
  const itens = [
    { exerciseId: e1.id, name: e1.name, sets: '3', reps: '10-12', rest: '60', rpe: '7', order: 0 },
    { exerciseId: e2.id, name: e2.name, sets: '3', reps: '8-10', rest: '90', rpe: '8', order: 1 },
    {
      exerciseId: e3.id,
      name: e3.name,
      sets: '3',
      reps: '12-15',
      rest: '45',
      rpe: '7',
      order: 2,
      technique: { type: 'bi_set', biSetGroupId: BISET_GROUP },
    },
    {
      exerciseId: e4.id,
      name: e4.name,
      sets: '3',
      reps: '12-15',
      rest: '45',
      rpe: '7',
      order: 3,
      technique: { type: 'bi_set', biSetGroupId: BISET_GROUP },
    },
    { exerciseId: e5.id, name: e5.name, sets: '4', reps: '8-12', rest: '75', rpe: '8', order: 4 },
  ];

  const plano = await pool.query<{ id: number }>(
    `INSERT INTO personal_workout_plans
       (personal_id, student_id, title, week_preset, selected_group, payload_json, academy_id)
     VALUES ($1, $2, $3, '1', 'academia', '[]'::jsonb, NULL)
     RETURNING id`,
    [personal.user.id, aluno.user.id, PLAN_TITLE],
  );

  await pool.query(
    `INSERT INTO personal_workout_plan_days (plan_id, day_index, name, focus, payload_json)
     VALUES ($1, 1, 'Dia A', 'Full body', $2::jsonb)`,
    [plano.rows[0].id, JSON.stringify(itens)],
  );

  console.log(JSON.stringify({
    alunoId: aluno.user.id,
    personalId: personal.user.id,
    planId: plano.rows[0].id,
    aluno: { email: EMAIL_ALUNO, senha: senhaAluno },
    personal: { email: EMAIL_PERSONAL, senha: senhaPersonal },
    exercicios: ex.rows.map((e) => ({ id: e.id, name: e.name })),
    biSetGroup: BISET_GROUP,
    biSetMembers: [e3.name, e4.name],
  }, null, 2));
}

async function teardown(): Promise<void> {
  const dias = await pool.query(
    `DELETE FROM personal_workout_plan_days
      WHERE plan_id IN (SELECT id FROM personal_workout_plans WHERE title = $1)`,
    [PLAN_TITLE],
  );
  const planos = await pool.query(`DELETE FROM personal_workout_plans WHERE title = $1`, [PLAN_TITLE]);

  const { rows } = await pool.query<{ id: number; email: string }>(
    `DELETE FROM users WHERE email IN ($1, $2) RETURNING id, email`,
    [EMAIL_ALUNO, EMAIL_PERSONAL],
  );
  console.log(JSON.stringify({
    removidos: rows,
    planosRemovidos: planos.rowCount,
    diasRemovidos: dias.rowCount,
  }, null, 2));
}

const modo = process.argv[2];
const acao = modo === '--teardown' ? teardown : modo === '--setup' ? setup : null;
if (!acao) {
  console.error('uso: qaDynamicFixture.ts --setup | --teardown');
  process.exit(1);
}
acao()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('ERRO:', err.message, err.stack);
    await pool.end();
    process.exit(1);
  });
