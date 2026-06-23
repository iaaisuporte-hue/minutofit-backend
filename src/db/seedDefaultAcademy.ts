import pool from '../config/database';
import logger from '../lib/logger';
import { ensureAcademyRoles, roleSlugFromUserRole } from './academyRoles';

/**
 * Idempotente — cria a academia padrão "CoreFit Direto", os roles do sistema
 * e migra todos os usuários existentes para academy_users com o role correspondente.
 *
 * Deve rodar APÓS ensureAcademiesSchema() e ensureUsersCoreColumns().
 */

const DEFAULT_ACADEMY_SLUG = 'corefit-direto';

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
      [DEFAULT_ACADEMY_SLUG, 'S2Core Direto', 'S2Core Direto']
    );

    let academyId: number;
    if (acResult.rows.length > 0) {
      academyId = acResult.rows[0].id;
      logger.info(`[seed] Academia padrão criada (id=${academyId})`);
    } else {
      const existing = await client.query(
        `SELECT id FROM academies WHERE slug = $1`,
        [DEFAULT_ACADEMY_SLUG]
      );
      academyId = existing.rows[0].id;
      logger.info(`[seed] Academia padrão já existe (id=${academyId})`);
    }

    // 2. Marcar usuários admin como is_corefit_admin
    await client.query(
      `UPDATE users SET is_corefit_admin = TRUE WHERE role = 'admin' AND is_corefit_admin = FALSE`
    );

    // 3. Criar/garantir roles do sistema para esta academia
    const roleIdMap = await ensureAcademyRoles(client, academyId);
    logger.info(`[seed] ${Object.keys(roleIdMap).length} roles do sistema garantidos`);

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

    logger.info(`[seed] academy_users: ${linked} vinculados, ${skipped} já existiam`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
