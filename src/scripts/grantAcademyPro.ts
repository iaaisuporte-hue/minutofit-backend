/**
 * Concede plano Pro SaaS (intelligence on) a academias do piloto — sem cobrança.
 *
 * Uso:
 *   npm run script:grant-academy-pro -- minha-academia outra-academia   (slugs)
 *   npm run script:grant-academy-pro -- 12 34                            (ids numéricos)
 *
 * Idempotente: re-rodar atualiza o period_end para mais PERIOD_DAYS a partir de agora.
 * set_by_user_id fica NULL (bootstrap). Para grant rastreado, usar
 * POST /admin/academies/:academyId/plan.
 */

import pool from '../config/database';
import { setAcademySubscription } from '../services/academySubscriptionService';
import logger from '../lib/logger';

const PERIOD_DAYS = 30;
const NOTES = 'piloto-academia';

/** Args após `--`: slug (texto) ou id (numérico). */
function resolveArgs(): string[] {
  return process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
}

async function resolveAcademy(token: string): Promise<{ id: number; name: string } | null> {
  const asId = Number(token);
  const res = Number.isFinite(asId) && /^\d+$/.test(token)
    ? await pool.query<{ id: number; display_name: string }>(
        `SELECT id, display_name FROM academies WHERE id = $1`, [asId])
    : await pool.query<{ id: number; display_name: string }>(
        `SELECT id, display_name FROM academies WHERE slug = $1`, [token.toLowerCase()]);
  if (res.rows.length === 0) return null;
  return { id: res.rows[0].id, name: res.rows[0].display_name };
}

async function run() {
  const tokens = resolveArgs();
  if (tokens.length === 0) {
    console.error('⚠  Informe slugs ou ids de academia. Ex: npm run script:grant-academy-pro -- minha-academia');
    process.exit(1);
  }

  console.log(`\n🚀 Concedendo Pro SaaS (${PERIOD_DAYS} dias) para ${tokens.length} academia(s)...\n`);
  let ok = 0;
  let fail = 0;

  for (const token of tokens) {
    try {
      const academy = await resolveAcademy(token);
      if (!academy) {
        console.log(`  ✗  ${token}  →  academia não encontrada (slug ou id)`);
        fail++;
        continue;
      }
      // Bootstrap: atribui ao owner da academia; null se não houver (coluna é nullable).
      const owner = await pool.query<{ owner_user_id: number | null }>(
        `SELECT owner_user_id FROM academies WHERE id = $1`, [academy.id]);
      const setBy = owner.rows[0]?.owner_user_id ?? null;

      await setAcademySubscription(academy.id, 'pro', { periodDays: PERIOD_DAYS, notes: NOTES, setBy });

      const until = new Date(Date.now() + PERIOD_DAYS * 86400_000).toLocaleDateString('pt-BR');
      console.log(`  ✓  ${token}  →  ${academy.name} (id=${academy.id})  Pro até ${until}`);
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗  ${token}  →  ERRO: ${msg}`);
      fail++;
    }
  }

  console.log(`\n✅ Concluído — ${ok} ok, ${fail} falha(s)\n`);
  await pool.end();
}

run().catch((err) => {
  logger.error({ err }, 'grantAcademyPro: fatal');
  process.exit(1);
});
