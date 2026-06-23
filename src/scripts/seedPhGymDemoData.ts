/**
 * Insere ~30 alunos fictícios na academia PH Gym (slug normalizado contém "phgym"),
 * com matrículas, check-ins, treinos, lab (movement), tracker (activity), pagamentos
 * e alguns snapshots de metabolismo — para visualizar dashboard, financeiro e retenção.
 *
 * Uso (na pasta corefit-backend, com DATABASE_URL no .env):
 *   npm run db:seed-phgym-demo
 *
 * Idempotente: remove antes usuários com email `phgym-demo-*@corefit.invalid` (CASCADE).
 */

import bcrypt from 'bcryptjs';
import pool from '../config/database';
import { ensureAcademyRoles } from '../db/academyRoles';

const DEMO_LIKE = 'phgym-demo-%@corefit.invalid';

const NAMES = [
  'Ana Beatriz', 'Bruno Costa', 'Carla Dias', 'Diego Fernandes', 'Elena Gomes',
  'Felipe Henrique', 'Gabriela Inácio', 'Hugo Jardim', 'Isabela Klein', 'João Lucas',
  'Karina Monteiro', 'Leonardo Nunes', 'Mariana Oliveira', 'Nicolas Prado', 'Olivia Queiroz',
  'Paulo Ribeiro', 'Quitéria Silva', 'Rafael Teixeira', 'Sofia Ulrich', 'Thiago Vieira',
  'Úrsula Xavier', 'Vinícius Zago', 'Wesley Alves', 'Yasmin Barros', 'Zeca Cardoso',
  'Alice Duarte', 'Bernardo Esteves', 'Camila Freitas', 'Daniela Guedes', 'Eduardo Horta',
];

function slugKey(slug: string): string {
  return slug.toLowerCase().replace(/[-_]/g, '');
}

async function findPhGymAcademyId(): Promise<{ id: number; slug: string; display_name: string } | null> {
  const res = await pool.query<{ id: number; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM academies WHERE status = 'active'`
  );
  const row = res.rows.find((r) => slugKey(r.slug).includes('phgym'));
  return row ?? null;
}

async function wipeDemoUsers(): Promise<void> {
  const del = await pool.query<{ id: number }>(
    `DELETE FROM users WHERE email LIKE $1 RETURNING id`,
    [DEMO_LIKE]
  );
  if (del.rowCount) {
    console.log(`[phgym-demo] Removidos ${del.rowCount} usuários demo anteriores.`);
  }
}

async function main() {
  const academy = await findPhGymAcademyId();
  if (!academy) {
    console.error(
      '[phgym-demo] Nenhuma academia ativa com slug que contenha "phgym" (ex.: ph-gym). Ajuste o slug ou crie a academia.',
    );
    process.exit(1);
  }

  const academyId = academy.id;
  console.log(`[phgym-demo] Academia: ${academy.display_name} (id=${academyId}, slug=${academy.slug})`);

  await wipeDemoUsers();

  const roleMap = await ensureAcademyRoles(pool, academyId);
  const studentRoleId = roleMap.academy_student;
  if (!studentRoleId) {
    console.error('[phgym-demo] Role academy_student não encontrado.');
    process.exit(1);
  }

  let planId: number | null = null;
  const planRes = await pool.query<{ id: number }>(
    `SELECT id FROM academy_plans WHERE academy_id = $1 AND status = 'active' ORDER BY id ASC LIMIT 1`,
    [academyId]
  );
  if (planRes.rows[0]) {
    planId = planRes.rows[0].id;
  } else {
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO academy_plans (academy_id, name, description, monthly_price, billing_cycle_days, status)
       VALUES ($1, 'Mensalidade PH Gym (demo)', 'Plano fictício para dados de demonstração.', 129.90, 30, 'active')
       RETURNING id`,
      [academyId]
    );
    planId = ins.rows[0].id;
    console.log(`[phgym-demo] Criado plano demo id=${planId}`);
  }

  const personalRow = await pool.query<{ user_id: number }>(
    `SELECT au.user_id
     FROM academy_users au
     JOIN academy_roles ar ON ar.id = au.role_id
     WHERE au.academy_id = $1 AND au.is_active = TRUE AND au.status = 'active'
       AND ar.slug IN ('academy_personal', 'academy_owner', 'academy_manager')
     LIMIT 1`,
    [academyId]
  );
  const personalId = personalRow.rows[0]?.user_id ?? null;

  const passwordHash = await bcrypt.hash('DemoPhGym2026!', 10);

  const statuses: Array<'active' | 'lead' | 'overdue' | 'paused' | 'cancelled'> = [
    ...Array(22).fill('active'),
    ...Array(3).fill('overdue'),
    ...Array(2).fill('paused'),
    ...Array(2).fill('lead'),
    'cancelled',
  ] as Array<'active' | 'lead' | 'overdue' | 'paused' | 'cancelled'>;

  const client = await pool.connect();
  const userIds: number[] = [];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < 30; i += 1) {
      const n = String(i + 1).padStart(2, '0');
      const email = `phgym-demo-${n}@corefit.invalid`;
      const name = NAMES[i] ?? `Aluno Demo ${n}`;

      // CPF fictício único: 9 dígitos base + 2 dígitos índice (não passa validação matemática — só demo)
      const cpf = String(10000000000 + i).slice(0, 11);
      const phone = `859${String(90000000 + i).slice(0, 8)}`;

      const u = await client.query<{ id: number }>(
        `INSERT INTO users (email, password, role, name, cpf, phone, profile_completed, access_profile)
         VALUES ($1, $2, 'user', $3, $4, $5, TRUE, 'user_default')
         RETURNING id`,
        [email, passwordHash, name, cpf, phone]
      );
      const userId = u.rows[0].id;
      userIds.push(userId);

      const joinedDaysAgo = 5 + (i % 45);
      const st = statuses[i] ?? 'active';

      await client.query(
        `INSERT INTO academy_users (
           user_id, academy_id, role_id, status, is_active, joined_at,
           student_status, payment_method
         )
         VALUES ($1, $2, $3, 'active', TRUE, NOW() - ($4::integer * INTERVAL '1 day'), $5, $6)`,
        [userId, academyId, studentRoleId, joinedDaysAgo, st, ['pix', 'cartão', 'dinheiro', 'pix + cartão'][i % 4]]
      );

      if (planId) {
        const startD = new Date();
        startD.setDate(startD.getDate() - (20 + (i % 40)));
        const startStr = startD.toISOString().slice(0, 10);
        const enrStatus = i >= 28 ? 'cancelled' : 'active';
        await client.query(
          `INSERT INTO academy_enrollments (academy_id, user_id, plan_id, start_date, status)
           VALUES ($1, $2, $3, $4::date, $5)`,
          [academyId, userId, planId, startStr, enrStatus]
        );
        if (enrStatus === 'cancelled') {
          await client.query(
            `UPDATE academy_enrollments SET updated_at = NOW() - INTERVAL '5 days'
             WHERE academy_id = $1 AND user_id = $2`,
            [academyId, userId]
          );
        }
      }
    }

    // Pagamentos (mês corrente — alimenta KPIs do financeiro)
    const payStatuses: Array<'approved' | 'pending' | 'failed'> = [
      'approved', 'approved', 'approved', 'pending', 'approved', 'failed', 'approved', 'pending',
    ];
    let paySeq = 0;
    for (const uid of userIds.slice(0, 22)) {
      const rows = 1 + (paySeq % 2);
      for (let r = 0; r < rows; r += 1) {
        const st = payStatuses[(paySeq + r) % payStatuses.length];
        const amount = 89.9 + (paySeq % 5) * 10;
        const dayOffset = paySeq % 20;
        const mpId = `phgym-demo-mp-${academyId}-${uid}-${paySeq}-${r}`;
        const paidAt = st === 'approved'
          ? new Date(new Date().getFullYear(), new Date().getMonth(), dayOffset + 1, 10)
          : null;
        const createdAt = new Date(new Date().getFullYear(), new Date().getMonth(), dayOffset + 1, 9);

        await client.query(
          `INSERT INTO payments (user_id, subscription_id, mercado_pago_payment_id, amount_brl, status, academy_id, created_at, updated_at)
           VALUES ($1, NULL, $2, $3::numeric, $4::varchar, $5, $6, $7)`,
          [uid, mpId, amount, st, academyId, createdAt, paidAt ?? createdAt]
        );
        paySeq += 1;
      }
    }

    // Check-ins e treinos (retenção / risco)
    const atRiskIdx = new Set([3, 7, 11, 19]);
    for (let i = 0; i < userIds.length; i += 1) {
      const uid = userIds[i];
      if (atRiskIdx.has(i)) continue;

      const daysAgo = i % 5;
      await client.query(
        `INSERT INTO user_daily_checkins (user_id, academy_id, date_key, source, xp_awarded, created_at)
         VALUES ($1, $2, (CURRENT_DATE - $3::int)::date, 'workout', 15, NOW() - ($3::integer * INTERVAL '1 day'))
         ON CONFLICT (user_id, date_key) DO NOTHING`,
        [uid, academyId, daysAgo]
      );

      const workoutDaysAgo = (i % 8) + 1;
      await client.query(
        `INSERT INTO user_workout_logs (user_id, academy_id, workout_id, title, muscle_groups, completed_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - ($6::integer * INTERVAL '1 day'))`,
        [uid, academyId, `demo-wkt-${uid}-${i}`, 'Treino full body', ['peito', 'costas', 'pernas'], workoutDaysAgo]
      );
    }

    // Lab (movement_sessions)
    for (const uid of userIds.slice(0, 18)) {
      const daysBack = Math.floor(Math.random() * 18);
      await client.query(
        `INSERT INTO movement_sessions (
           user_id, academy_id, exercise_id, exercise_label, rep_count, avg_form_score,
           best_rep_score, worst_rep_score, avg_symmetry, insight, created_at
         )
         VALUES ($1, $2, 'squat', 'Agachamento', 12, 78, 88, 62, 0.91, 'Demo', NOW() - ($3::integer * INTERVAL '1 day'))`,
        [uid, academyId, daysBack]
      );
    }

    // Tracker (activity_sessions)
    for (let j = 0; j < userIds.slice(0, 14).length; j += 1) {
      const uid = userIds[j];
      const started = new Date();
      started.setDate(started.getDate() - (j % 12));
      const ended = new Date(started.getTime() + 35 * 60 * 1000);
      await client.query(
        `INSERT INTO activity_sessions (
           user_id, academy_id, activity_type, duration_seconds, distance_km, calories_estimated,
           avg_pace, intensity, score, route_coordinates, validation_flag, started_at, ended_at
         )
         VALUES ($1, $2, 'run', 2100, 5.2, 320, 6.7, 'moderate', 72, NULL, FALSE, $3, $4)`,
        [uid, academyId, started, ended]
      );
    }

    // Metabolismo
    const factors = JSON.stringify([{ key: 'sleep', label: 'Sono', impact: 0.2 }]);
    const inputs = JSON.stringify({ weightKg: 72 });
    for (const uid of userIds.slice(0, 8)) {
      for (let d = 1; d <= 3; d += 1) {
        const daysBack = d * 4;
        const score = 55 + ((uid + d) % 35);
        await client.query(
          `INSERT INTO user_metabolism_snapshots (user_id, snapshot_date, score, status, trend, factors, inputs, academy_id, created_at)
           VALUES ($1, (CURRENT_DATE - $2::int)::date, $3, 'stable', 'flat', $4::jsonb, $5::jsonb, $6, NOW() - ($2::integer * INTERVAL '1 day'))
           ON CONFLICT (user_id, snapshot_date) DO UPDATE SET score = EXCLUDED.score, created_at = EXCLUDED.created_at`,
          [uid, daysBack, score, factors, inputs, academyId]
        );
      }
    }

    if (personalId) {
      for (const uid of userIds.slice(0, 14)) {
        await client.query(
          `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, NOW(), NOW())
           ON CONFLICT (personal_id, student_id) DO NOTHING`,
          [personalId, uid, academyId]
        );
      }
    } else {
      console.warn('[phgym-demo] Nenhum personal/gestor na academia — pulando personal_student_assignments.');
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[phgym-demo] Erro:', e);
    process.exit(1);
  } finally {
    client.release();
  }

  console.log(`[phgym-demo] OK — ${userIds.length} alunos. Senha demo (todos): DemoPhGym2026!`);
  console.log('[phgym-demo] Emails: phgym-demo-01@corefit.invalid … phgym-demo-30@corefit.invalid');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
