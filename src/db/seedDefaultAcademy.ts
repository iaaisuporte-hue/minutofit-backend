import pool from '../config/database';

/**
 * Idempotente — cria a academia padrão "MinutoFit Direto", os roles do sistema
 * e migra todos os usuários existentes para academy_users com o role correspondente.
 *
 * Deve rodar APÓS ensureAcademiesSchema() e ensureUsersCoreColumns().
 * Pode ser chamado no boot ou via: npx ts-node src/db/seedDefaultAcademy.ts
 */

const DEFAULT_ACADEMY_SLUG = 'minutofit-direto';

const SYSTEM_ROLES: Array<{ slug: string; label: string; permissions: string[] }> = [
  {
    slug: 'metacore_admin',
    label: 'Admin MetaCore',
    permissions: [
      'admin.dashboard', 'admin.users', 'admin.users.detail',
      'admin.personals', 'admin.personals.detail', 'admin.nutris',
      'admin.finance', 'admin.accessProfiles', 'admin.professionals.create',
      'academy.dashboard', 'academy.students.read', 'academy.students.write',
      'academy.professionals.read', 'academy.professionals.write',
      'academy.plans.read', 'academy.plans.write',
      'academy.finance.read', 'academy.finance.write', 'academy.finance.dre',
      'academy.reports.read', 'academy.branding', 'academy.audit.read',
      'academy.invitations.write',
    ],
  },
  {
    slug: 'academy_owner',
    label: 'Dono da Academia',
    permissions: [
      'academy.dashboard', 'academy.students.read', 'academy.students.write',
      'academy.students.metabolic', 'academy.professionals.read',
      'academy.professionals.write', 'academy.plans.read', 'academy.plans.write',
      'academy.finance.read', 'academy.finance.write', 'academy.finance.dre',
      'academy.reports.read', 'academy.branding', 'academy.audit.read',
      'academy.invitations.write',
    ],
  },
  {
    slug: 'academy_manager',
    label: 'Gestor de Unidade',
    permissions: [
      'academy.dashboard', 'academy.students.read', 'academy.students.write',
      'academy.professionals.read', 'academy.plans.read',
      'academy.finance.read', 'academy.reports.read', 'academy.invitations.write',
    ],
  },
  {
    slug: 'academy_finance',
    label: 'Financeiro',
    permissions: [
      'academy.dashboard', 'academy.students.read',
      'academy.finance.read', 'academy.finance.write', 'academy.finance.dre',
      'academy.reports.read',
    ],
  },
  {
    slug: 'academy_reception',
    label: 'Recepção',
    permissions: [
      'academy.students.read', 'academy.plans.read',
      'academy.invitations.write',
    ],
  },
  {
    slug: 'academy_personal',
    label: 'Personal / Professor',
    permissions: [
      'academy.students.read', 'academy.students.metabolic',
    ],
  },
  {
    slug: 'academy_nutri',
    label: 'Nutricionista',
    permissions: [
      'academy.students.read', 'academy.students.metabolic',
    ],
  },
  {
    slug: 'academy_student',
    label: 'Aluno',
    permissions: [],
  },
];

function roleSlugFromUserRole(role: string, accessProfile: string | null): string {
  if (role === 'admin') return 'metacore_admin';
  if (role === 'personal') return 'academy_personal';
  if (role === 'nutri') return 'academy_nutri';
  if (accessProfile === 'clientes_sb') return 'academy_student';
  return 'academy_student';
}

export async function seedDefaultAcademy(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert academia padrão
    const acResult = await client.query(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [DEFAULT_ACADEMY_SLUG, 'MinutoFit Direto', 'MinutoFit Direto']
    );

    let academyId: number;
    if (acResult.rows.length > 0) {
      academyId = acResult.rows[0].id;
      console.log(`[seed] Academia padrão criada (id=${academyId})`);
    } else {
      const existing = await client.query(
        `SELECT id FROM academies WHERE slug = $1`,
        [DEFAULT_ACADEMY_SLUG]
      );
      academyId = existing.rows[0].id;
      console.log(`[seed] Academia padrão já existe (id=${academyId})`);
    }

    // 2. Marcar usuários admin como is_metacore_admin
    await client.query(
      `UPDATE users SET is_metacore_admin = TRUE WHERE role = 'admin' AND is_metacore_admin = FALSE`
    );

    // 3. Criar/garantir roles do sistema para esta academia
    const roleIdMap: Record<string, number> = {};
    for (const r of SYSTEM_ROLES) {
      const rResult = await client.query(
        `INSERT INTO academy_roles (academy_id, slug, label, permissions, is_system)
         VALUES ($1, $2, $3, $4::jsonb, TRUE)
         ON CONFLICT (academy_id, slug) DO UPDATE
           SET label = EXCLUDED.label,
               permissions = EXCLUDED.permissions
         RETURNING id`,
        [academyId, r.slug, r.label, JSON.stringify(r.permissions)]
      );
      roleIdMap[r.slug] = rResult.rows[0].id;
    }
    console.log(`[seed] ${SYSTEM_ROLES.length} roles do sistema garantidos`);

    // 4. Migrar usuários existentes para academy_users (sem duplicar)
    const usersRes = await client.query(
      `SELECT id, role, access_profile FROM users`
    );

    let linked = 0;
    let skipped = 0;
    for (const u of usersRes.rows) {
      const slug = roleSlugFromUserRole(u.role, u.access_profile);
      const roleId = roleIdMap[slug];
      if (!roleId) continue;

      const exists = await client.query(
        `SELECT 1 FROM academy_users WHERE user_id = $1 AND academy_id = $2`,
        [u.id, academyId]
      );
      if (exists.rows.length > 0) {
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active, joined_at)
         VALUES ($1, $2, $3, 'active', TRUE, NOW())`,
        [u.id, academyId, roleId]
      );
      linked++;
    }

    console.log(`[seed] academy_users: ${linked} vinculados, ${skipped} já existiam`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
