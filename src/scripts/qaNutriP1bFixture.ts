/**
 * QA FIXTURE — Nutri P1B (Design System). Só para verificação visual manual;
 * descartável (banco de QA_SAFE_MODE, nunca produção).
 *
 * Uso: TEST_DATABASE_URL/DATABASE_URL apontando pro banco de QA:
 *   QA_SAFE_MODE=1 DATABASE_URL=... npx tsx src/scripts/qaNutriP1bFixture.ts
 */
import bcrypt from 'bcryptjs';
import pool from '../config/database';
import { createPlan } from '../services/nutriService';
import { createObservation } from '../services/nutriService';
import { publishVoiceNote } from '../services/nutritionVoiceNoteService';

const PASSWORD = 'QaNutri@2026';
const DOMAIN = '@nutriqa.invalid';

let cpfSeq = 92000000000;
function nextCpf(): string { return String(++cpfSeq); }

async function upsertUser(email: string, name: string, role: string) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO users (email, password, role, name, cpf, phone, profile_completed)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)
     ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, name = EXCLUDED.name, role = EXCLUDED.role
     RETURNING id`,
    [email, hash, role, name, nextCpf(), '11999990001'],
  );
  if (r.rows.length) return r.rows[0].id as number;
  const e = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  return e.rows[0].id as number;
}

async function grantConsent(userId: number, professionalId: number, scope: string) {
  await pool.query(
    `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status, granted_at)
     VALUES ($1,$2,'nutri',$3,'granted',NOW())
     ON CONFLICT (user_id, professional_id, professional_role, scope)
     DO UPDATE SET status = 'granted', granted_at = NOW(), revoked_at = NULL`,
    [userId, professionalId, scope],
  );
}

async function main() {
  const nutriId = await upsertUser(`nutri${DOMAIN}`, 'Dra. Fernanda QA', 'nutri');
  const patientId = await upsertUser(`paciente${DOMAIN}`, 'Paciente QA Silva', 'user');

  await pool.query(
    `INSERT INTO nutri_patient_assignments (nutri_id, patient_id, status, created_at, updated_at)
     VALUES ($1,$2,'active',NOW(),NOW())
     ON CONFLICT (nutri_id, patient_id) DO UPDATE SET status = 'active'`,
    [nutriId, patientId],
  ).catch(async () => {
    await pool.query(
      `UPDATE nutri_patient_assignments SET status = 'active' WHERE nutri_id = $1 AND patient_id = $2`,
      [nutriId, patientId],
    );
  });

  for (const scope of ['profile', 'nutrition', 'clinical_nutrition', 'daily_checkins', 'metabolic', 'body_metrics', 'parq_anamnese']) {
    await grantConsent(patientId, nutriId, scope);
  }

  const plan = await createPlan(nutriId, patientId, null, {
    title: 'Plano QA — reeducação alimentar',
    objective: 'weight_loss',
    general_notes: 'Priorizar hidratação e reduzir ultraprocessados nas refeições noturnas.',
    meals: [
      { name: 'Café da manhã', orientation: 'Ovos mexidos + fruta + café sem açúcar.', order_index: 0, meal_time: '07:30' },
      { name: 'Almoço', orientation: 'Arroz, feijão, proteína magra e salada à vontade.', order_index: 1, meal_time: '12:30' },
      { name: 'Lanche da tarde', orientation: 'Iogurte natural com castanhas.', order_index: 2, meal_time: '16:00' },
      { name: 'Jantar', orientation: 'Proteína + legumes grelhados, evitar carboidrato refinado.', order_index: 3, meal_time: '20:00' },
    ] as any,
  });

  const meals = await pool.query(`SELECT id, order_index FROM nutrition_plan_meals WHERE plan_id = $1 ORDER BY order_index`, [plan.id]);
  const statuses = ['done', 'done', 'partial', 'done', 'skipped', 'done', 'substituted', 'done', 'done', 'delayed', 'done', 'done', 'skipped', 'done'];
  for (let dayAgo = 0; dayAgo < 14; dayAgo++) {
    for (const m of meals.rows) {
      // Café pulado com frequência (fica "refeição mais fraca"); resto oscila.
      const idx = (dayAgo * meals.rows.length + m.order_index) % statuses.length;
      const status = m.order_index === 0 && dayAgo % 3 !== 0 ? 'skipped' : statuses[idx];
      await pool.query(
        `INSERT INTO nutrition_meal_checkins (meal_id, patient_id, plan_id, check_date, status, recorded_at)
         VALUES ($1,$2,$3, CURRENT_DATE - $4::int, $5, NOW())
         ON CONFLICT (patient_id, meal_id, check_date) DO UPDATE SET status = EXCLUDED.status`,
        [m.id, patientId, plan.id, dayAgo, status],
      ).catch((e) => console.warn('checkin insert falhou', e.message));
    }
  }

  await createObservation(nutriId, patientId, 'Paciente relatou dificuldade em manter o café da manhã nos dias de semana — considerar opção mais rápida.');
  await publishVoiceNote({
    nutriId,
    patientId,
    body: 'Vi que você tem pulado o café da manhã — bora ajustar juntos essa rotina esta semana?',
  }).catch((e) => console.warn('voice note falhou', e.message));

  // Check-ins diários de bem-estar (Contexto)
  for (let d = 0; d < 5; d++) {
    await pool.query(
      `INSERT INTO user_daily_checkins (user_id, date_key, source, feeling, slept_well, in_pain, stressed, notes, created_at)
       VALUES ($1, CURRENT_DATE - $2::int, 'activity', $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, date_key) DO NOTHING`,
      [patientId, d, d % 2 === 0 ? 'energized' : 'tired', d % 3 !== 0, d === 1, d === 2, d === 0 ? 'Dormi mal por causa do calor.' : null],
    ).catch(() => {});
  }

  console.log('QA Nutri P1B fixture pronta:');
  console.log(`  nutri:    nutri${DOMAIN} / ${PASSWORD} (id=${nutriId})`);
  console.log(`  paciente: paciente${DOMAIN} / ${PASSWORD} (id=${patientId})`);
  console.log(`  plan id: ${plan.id}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
