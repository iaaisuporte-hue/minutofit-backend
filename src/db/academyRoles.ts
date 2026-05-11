import { Pool, PoolClient } from 'pg';

export interface SystemRole {
  slug: string;
  label: string;
  permissions: string[];
}

export const SYSTEM_ROLES: SystemRole[] = [
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
    permissions: ['academy.students.read', 'academy.students.metabolic'],
  },
  {
    slug: 'academy_nutri',
    label: 'Nutricionista',
    permissions: ['academy.students.read', 'academy.students.metabolic'],
  },
  {
    slug: 'academy_student',
    label: 'Aluno',
    permissions: [],
  },
];

/**
 * Idempotente — garante que todos os roles do sistema existem para um academy_id.
 * Retorna map slug → id.
 */
export async function ensureAcademyRoles(
  db: Pool | PoolClient,
  academyId: number
): Promise<Record<string, number>> {
  const roleIdMap: Record<string, number> = {};
  for (const r of SYSTEM_ROLES) {
    const result = await db.query(
      `INSERT INTO academy_roles (academy_id, slug, label, permissions, is_system)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (academy_id, slug) DO UPDATE
         SET label = EXCLUDED.label,
             permissions = EXCLUDED.permissions
       RETURNING id`,
      [academyId, r.slug, r.label, JSON.stringify(r.permissions)]
    );
    roleIdMap[r.slug] = result.rows[0].id;
  }
  return roleIdMap;
}

export function roleSlugFromUserRole(role: string, accessProfile: string | null): string {
  if (role === 'admin') return 'metacore_admin';
  if (role === 'personal') return 'academy_personal';
  if (role === 'nutri') return 'academy_nutri';
  if (accessProfile === 'clientes_sb') return 'academy_student';
  return 'academy_student';
}
