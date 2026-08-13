/**
 * Cenário de demonstração para QA autenticado — CRIA e DESTRÓI.
 *
 * Existe porque o QA de ago/2026 cobriu só a superfície pública: tudo das ondas
 * P5 e P6 (prontidão, adaptação, cockpit do personal) vive atrás de login, e
 * sem uma conta ninguém tinha aberto essas telas como usuário real.
 *
 * ## Regras que este script respeita, e por quê
 *
 * A criação de usuário passa por `findOrCreateUserFromContext` e a concessão de
 * produto por `grantMembership` — as duas portas que o `CLAUDE.md` define como
 * únicas. Um INSERT direto em `users` seria mais curto e criaria uma conta que
 * o resto do sistema trata como estrangeira (sem auditoria de identidade, sem
 * membership coerente), o que faria o QA testar um caminho que nenhum usuário
 * real percorre.
 *
 * ## Descarte
 *
 * `--teardown` apaga as duas contas. As FKs em cascata levam junto sessões,
 * métricas, recordes, metas, consentimentos e vínculos — é o mesmo caminho da
 * exclusão de conta do titular, então o descarte também exercita essa cascata.
 *
 * Uso:
 *   npx tsx src/scripts/qaDemoFixture.ts --setup
 *   npx tsx src/scripts/qaDemoFixture.ts --teardown
 */
import { randomBytes } from 'crypto';

import pool from '../config/database';
import { grantMembership } from '../services/membershipService';
import { findOrCreateUserFromContext } from '../services/userIdentityService';

/** Prefixo que identifica tudo que este script criou. O teardown depende dele. */
const TAG = 'qa-demo';
const EMAIL_ALUNO = `${TAG}-aluno@s2core.invalid`;
const EMAIL_PERSONAL = `${TAG}-personal@s2core.invalid`;

/** Escopos que o personal precisa para a aba Performance (P5) e o histórico. */
const CONSENT_SCOPES = ['profile', 'workouts', 'daily_checkins', 'metabolic', 'body_metrics'];

/**
 * CPF e telefone sintéticos, únicos por execução.
 *
 * As colunas são NOT NULL no schema legado. Os valores não precisam ser
 * documentos válidos — precisam ser únicos, para não colidirem com cadastro
 * real nem entre si. O prefixo 999 sinaliza que é fixture.
 */
function documentoSintetico(seed: number): { cpf: string; phone: string } {
  const n = String(Date.now() % 100000).padStart(5, '0') + String(seed).padStart(4, '0');
  return { cpf: `999${n}`.slice(0, 11).padEnd(11, '0'), phone: `1199${n}`.slice(0, 11) };
}

function senhaForte(): string {
  // Aleatória por execução: a credencial vive só nesta sessão de QA.
  return `Qa${randomBytes(9).toString('base64url')}#7`;
}

async function setup(): Promise<void> {
  const senhaAluno = senhaForte();
  const senhaPersonal = senhaForte();

  const docPersonal = documentoSintetico(1);
  const personal = await findOrCreateUserFromContext({
    email: EMAIL_PERSONAL,
    name: 'QA Demo Personal',
    password: senhaPersonal,
    cpf: docPersonal.cpf,
    phone: docPersonal.phone,
    matchBy: ['email'],
  });
  await pool.query(`UPDATE users SET role = 'personal', profile_completed = true WHERE id = $1`, [
    personal.user.id,
  ]);
  await grantMembership(personal.user.id, 'personal', { source: 'corefit' });

  const docAluno = documentoSintetico(2);
  const aluno = await findOrCreateUserFromContext({
    email: EMAIL_ALUNO,
    name: 'QA Demo Aluno',
    password: senhaAluno,
    cpf: docAluno.cpf,
    phone: docAluno.phone,
    matchBy: ['email'],
  });
  await pool.query(`UPDATE users SET role = 'user', profile_completed = true WHERE id = $1`, [
    aluno.user.id,
  ]);
  await grantMembership(aluno.user.id, 'app', { source: 'bonus_personal' });

  // Premium: readiness é aberto, mas score, metas, progressão e recordes não.
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

  // Vínculo autônomo (academy_id NULL) — o caso que o produto mais usa.
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

  // Ficha com exercícios REAIS do catálogo — a adaptação lê `sets`/`reps`/
  // `rest`/`rpe` e o teste precisa de valores que dêem para reduzir.
  const ex = await pool.query<{ id: string; name: string }>(
    `SELECT id::text, name FROM exercises WHERE source = 'metacore' ORDER BY name LIMIT 3`,
  );
  const itens = ex.rows.map((e, i) => ({
    exerciseId: e.id,
    name: e.name,
    sets: '4',
    reps: '8-12',
    rest: '90',
    rpe: '8',
    order: i,
  }));
  // O plano guarda os dias em `personal_workout_plan_days`; `payload_json` do
  // plano é o caminho LEGADO (lista de itens de um dia único). Gravar dias ali
  // faria o carregador do treino de hoje ler um dia como se fosse um exercício
  // — foi o que aconteceu na primeira versão desta fixture, e a tela mostrou
  // "1 exercício" para uma ficha de três.
  const plano = await pool.query<{ id: number }>(
    `INSERT INTO personal_workout_plans
       (personal_id, student_id, title, week_preset, selected_group, payload_json, academy_id)
     VALUES ($1, $2, 'Ficha QA Demo', '1', 'academia', '[]'::jsonb, NULL)
     RETURNING id`,
    [personal.user.id, aluno.user.id],
  );

  // `day_index` é 1-based (produção usa 1..6) e `computeTodayDayIndex` nunca
  // devolve 0 — com `week_preset: '1'` ele resolve para 1 todos os dias, que é
  // o que faz o QA sempre encontrar o mesmo treino.
  await pool.query(
    `INSERT INTO personal_workout_plan_days (plan_id, day_index, name, focus, payload_json)
     VALUES ($1, 1, 'Dia A', 'Full body', $2::jsonb)`,
    [plano.rows[0].id, JSON.stringify(itens)],
  );

  // Política de adaptação LIGADA: sem o master switch nada é ajustado, e o
  // QA da P6 mediria um caminho que nunca executa.
  await pool.query(
    `INSERT INTO training_adaptation_policy
       (personal_id, student_id, academy_id, master_enabled,
        allow_volume_reduction, allow_rest_increase, allow_intensity_reduction)
     VALUES ($1, $2, NULL, true, true, true, true)
     ON CONFLICT (personal_id, student_id) DO UPDATE SET
       master_enabled = true, allow_volume_reduction = true,
       allow_rest_increase = true, allow_intensity_reduction = true,
       version = training_adaptation_policy.version + 1`,
    [personal.user.id, aluno.user.id],
  );

  console.log(JSON.stringify({
    alunoId: aluno.user.id,
    personalId: personal.user.id,
    aluno: { email: EMAIL_ALUNO, senha: senhaAluno },
    personal: { email: EMAIL_PERSONAL, senha: senhaPersonal },
    exercicios: ex.rows.map((e) => e.name),
  }, null, 2));
}

async function teardown(): Promise<void> {
  // A ficha NÃO some com o usuário: as FKs de `personal_workout_plans` são
  // SET NULL, então apagar as contas deixa o plano para trás com
  // `student_id`/`personal_id` nulos. Descoberto neste QA — a limpeza precisa
  // ser explícita, e o mesmo vale para a exclusão de conta de um aluno real.
  const dias = await pool.query(
    `DELETE FROM personal_workout_plan_days
      WHERE plan_id IN (SELECT id FROM personal_workout_plans WHERE title = $1)`,
    ['Ficha QA Demo'],
  );
  const planos = await pool.query(
    `DELETE FROM personal_workout_plans WHERE title = $1`,
    ['Ficha QA Demo'],
  );

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
  console.error('uso: qaDemoFixture.ts --setup | --teardown');
  process.exit(1);
}
acao()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('ERRO:', err.message);
    await pool.end();
    process.exit(1);
  });
