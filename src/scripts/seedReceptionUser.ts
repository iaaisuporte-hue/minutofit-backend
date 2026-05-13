/**
 * seed: Usuário de recepção Ana Claudia + histórico de acessos MOCK (5 dias)
 *
 * Uso:
 *   npm run db:seed-reception-user
 *
 * Pré-requisito: PH Gym deve existir no banco (rodar seedPhGymDemoData primeiro).
 * Idempotente: re-rodar não duplica — usa ON CONFLICT DO NOTHING.
 *
 * Credenciais:
 *   E-mail:  recepcao@phgym.com
 *   Senha:   Recepcao@123
 *   Role:    academy_reception
 */

import bcrypt from 'bcryptjs';
import pool from '../config/database';
import { ensureAcademyRoles } from '../db/academyRoles';

const EMAIL = 'recepcao@phgym.com';
const PASSWORD = 'Recepcao@123';
const NAME = 'Ana Claudia';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugKey(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

async function findPhGymAcademy(): Promise<{ id: number; slug: string; display_name: string }> {
  const res = await pool.query<{ id: number; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM academies WHERE status = 'active'`,
  );
  const row = res.rows.find((r) => slugKey(r.slug).includes('phgym'));
  if (!row) throw new Error('Academia PH Gym não encontrada. Execute seedPhGymDemoData primeiro.');
  return row;
}

// ─── Mock access events ────────────────────────────────────────────────────────

/** Lotação típica PH Gym por hora — 06:00–22:00 */
const TYPICAL_OCCUPANCY: Record<number, number> = {
  6: 8, 7: 25, 8: 35, 9: 20, 10: 12, 11: 18, 12: 28, 13: 22,
  14: 10, 15: 8, 16: 14, 17: 32, 18: 55, 19: 78, 20: 68, 21: 45, 22: 18,
};

/** Gera horários de entrada realistas para um dia (retorna horas decimais) */
function generateEntryTimes(dayOccupancy: Record<number, number>): number[] {
  const entries: number[] = [];
  for (const [hStr, count] of Object.entries(dayOccupancy)) {
    const h = Number(hStr);
    const entriesThisHour = Math.max(1, Math.round(count * 0.3 + (Math.random() * 4)));
    for (let i = 0; i < entriesThisHour; i++) {
      entries.push(h + Math.random());
    }
  }
  return entries.sort((a, b) => a - b);
}

/** Cria uma data N dias atrás no horário H:MM */
function makeTimestamp(daysAgo: number, hourDecimal: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(Math.floor(hourDecimal), Math.round((hourDecimal % 1) * 60), 0, 0);
  return d;
}

const MOCK_NAMES = [
  'Bruno Costa', 'Mariana Lima', 'Felipe Rocha', 'Camila Andrade', 'Rafael Souza',
  'Patrícia Gomes', 'Lucas Martins', 'Fernanda Alves', 'Diego Moreira', 'Juliana Castro',
  'Tiago Almeida', 'Beatriz Nunes', 'Rodrigo Melo', 'Larissa Freitas', 'André Carvalho',
];

const ENTRY_SOURCES: Array<'manual' | 'qr' | 'facial'> = ['manual', 'qr', 'qr', 'manual', 'facial'];
const EVENT_TYPES: Array<'checkin' | 'checkin' | 'checkin' | 'exception' | 'denied'> =
  ['checkin', 'checkin', 'checkin', 'checkin', 'checkin', 'exception', 'denied'] as any;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[seed-reception] Iniciando...');

  const academy = await findPhGymAcademy();
  const academyId = academy.id;
  console.log(`[seed-reception] Academia: ${academy.display_name} (id=${academyId})`);

  // 1. Garantir roles
  const roleMap = await ensureAcademyRoles(pool, academyId);
  const receptionRoleId = roleMap['academy_reception'];
  const studentRoleId = roleMap['academy_student'];
  if (!receptionRoleId) throw new Error('Role academy_reception não encontrado.');
  if (!studentRoleId) throw new Error('Role academy_student não encontrado.');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  let anaId = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. Upsert Ana Claudia
    // CPF e phone fictícios — não passam validação matemática, só seed
    const ANA_CPF   = '00000000001';
    const ANA_PHONE = '00000000001';
    const upsert = await client.query<{ id: number }>(
      `INSERT INTO users (email, password, role, name, cpf, phone, profile_completed, access_profile)
       VALUES ($1, $2, 'user', $3, $4, $5, TRUE, 'academy_reception')
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, password = EXCLUDED.password,
             access_profile = EXCLUDED.access_profile, profile_completed = TRUE
       RETURNING id`,
      [EMAIL, passwordHash, NAME, ANA_CPF, ANA_PHONE],
    );
    anaId = upsert.rows[0].id;
    console.log(`[seed-reception] Usuária Ana Claudia id=${anaId} (${EMAIL})`);

    // 3. Vincular à academia como recepcionista
    await client.query(
      `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active, joined_at)
       VALUES ($1, $2, $3, 'active', TRUE, NOW())
       ON CONFLICT (user_id, academy_id) DO UPDATE
         SET role_id = EXCLUDED.role_id, status = 'active', is_active = TRUE`,
      [anaId, academyId, receptionRoleId],
    );

    // 5. Buscar alunos demo para eventos realistas
    const demoRes = await client.query<{ id: number }>(
      `SELECT u.id FROM users u
       JOIN academy_users au ON au.user_id = u.id AND au.academy_id = $1
       WHERE u.email LIKE 'phgym-demo-%@minutofit.invalid'
       ORDER BY u.id ASC LIMIT 20`,
      [academyId],
    );
    const demoIds: number[] = demoRes.rows.map((r) => r.id);
    console.log(`[seed-reception] ${demoIds.length} alunos demo encontrados para eventos`);

    // 6. Inserir eventos de acesso para os últimos 5 dias
    let eventCount = 0;
    for (let daysAgo = 4; daysAgo >= 0; daysAgo--) {
      const entryTimes = generateEntryTimes(TYPICAL_OCCUPANCY);
      let seq = 0;

      for (const hour of entryTimes) {
        // Pular horas fora do range operacional
        if (hour < 6 || hour > 22.5) continue;

        const ts = makeTimestamp(daysAgo, hour);
        const userId = demoIds.length > 0
          ? demoIds[seq % demoIds.length]
          : anaId;
        const eventType = EVENT_TYPES[seq % EVENT_TYPES.length] as 'checkin' | 'exception' | 'denied';
        const source = ENTRY_SOURCES[seq % ENTRY_SOURCES.length];
        const reason = eventType === 'exception' ? 'Autorizado pela recepção' :
                       eventType === 'denied' ? 'Inadimplência verificada no sistema' : null;

        // Para events com tipo denied/exception, só inserir alguns
        if (eventType !== 'checkin' && Math.random() > 0.3) {
          seq++;
          continue;
        }

        await client.query(
          `INSERT INTO academy_access_events
             (academy_id, user_id, event_type, source, reason, performed_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [academyId, userId, eventType, source, reason, anaId, ts],
        );
        eventCount++;
        seq++;
      }
    }
    console.log(`[seed-reception] ${eventCount} eventos de acesso inseridos (5 dias)`);

    // 7. Alguns visitantes e personais externos nos últimos 3 dias
    const visitors = [
      { name: 'João Visitante', type: 'visitor' as const },
      { name: 'Pedro Personal Ext.', type: 'external_personal' as const },
      { name: 'Carla Visitante', type: 'visitor' as const },
    ];
    for (let i = 0; i < visitors.length; i++) {
      const v = visitors[i];
      const ts = makeTimestamp(i, 17 + i * 1.5);
      const visRes = await client.query<{ id: number }>(
        `INSERT INTO academy_visitors (academy_id, name, visitor_type, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [academyId, v.name, v.type, anaId, ts],
      );
      await client.query(
        `INSERT INTO academy_access_events
           (academy_id, visitor_id, event_type, source, reason, performed_by, created_at)
         VALUES ($1, $2, 'visitor', 'manual', $3, $4, $5)`,
        [academyId, visRes.rows[0].id, `${v.type === 'external_personal' ? 'Personal externo' : 'Visitante'} liberado`, anaId, ts],
      );
    }
    console.log('[seed-reception] 3 visitantes inseridos');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Produto 'academia' — opcional, fora da transação principal para não abortá-la
  try {
    await pool.query(
      `INSERT INTO user_products (user_id, product_key, status, source, source_academy_id)
       VALUES ($1, 'academia', 'active', 'academy_enroll', $2)
       ON CONFLICT (user_id, product_key) DO UPDATE SET status = 'active'`,
      [anaId, academyId],
    );
  } catch { /* tabela user_products pode não existir neste ambiente */ }

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Recepcionista criada com sucesso!');
  console.log('  E-mail:  recepcao@phgym.com');
  console.log('  Senha:   Recepcao@123');
  console.log('  Role:    academy_reception');
  console.log('  Academia: PH Gym');
  console.log('  Acesso:  /app/academy/recepcao apenas');
  console.log('──────────────────────────────────────────────────────');
  console.log('  Rotas permitidas:');
  console.log('    /app/academy/recepcao         (dashboard)');
  console.log('    /app/academy/recepcao/checkin (check-in)');
  console.log('    /app/academy/recepcao/novo-aluno');
  console.log('    /app/academy/students/*        (só leitura + edição)');
  console.log('  Rotas bloqueadas (redirect automático):');
  console.log('    /app/academy/dashboard, /finance, /team, /branding');
  console.log('══════════════════════════════════════════════════════');
}

main()
  .then(async () => { await pool.end(); process.exit(0); })
  .catch(async (err) => {
    console.error('[seed-reception] Erro:', err);
    await pool.end();
    process.exit(1);
  });
