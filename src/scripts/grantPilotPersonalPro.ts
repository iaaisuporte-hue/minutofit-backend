/**
 * Concede plano Pro (30 dias) a cada personal do piloto jun/2026.
 *
 * Uso:
 *   npm run script:grant-pilot-personal-pro -- a@email.com b@email.com   (e-mails via CLI)
 *   npm run script:grant-pilot-personal-pro                              (usa PILOT_EMAILS abaixo)
 *
 * E-mails passados na linha de comando têm prioridade sobre a lista PILOT_EMAILS.
 * Idempotente: re-rodar atualiza o period_end para mais 30 dias a partir de agora.
 *
 * O campo set_by_user_id fica NULL neste script (operação de bootstrap).
 * Para grant rastreado por admin humano, usar POST /admin/users/:userId/personal-plan.
 */

import pool from '../config/database';
import { setPersonalPlan } from '../services/personalPlanService';
import logger from '../lib/logger';

// ─── Fallback: e-mails dos personais do piloto (usado se nada vier por CLI) ───
const PILOT_EMAILS: string[] = [
  // 'personal1@email.com',
  // 'personal2@email.com',
  // ...
];

const PERIOD_DAYS = 30;
const NOTES = 'piloto-jun26';

// ─────────────────────────────────────────────────────────────────────────────

/** E-mails da CLI (após `--`) têm prioridade sobre a lista PILOT_EMAILS. */
function resolveEmails(): string[] {
  const fromCli = process.argv
    .slice(2)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes('@'));
  return fromCli.length > 0 ? fromCli : PILOT_EMAILS;
}

async function run() {
  const emails = resolveEmails();
  if (emails.length === 0) {
    console.error('⚠  Nenhum e-mail informado. Passe via CLI (-- a@b.com) ou edite PILOT_EMAILS.');
    process.exit(1);
  }

  console.log(`\n🚀 Concedendo plano Pro (${PERIOD_DAYS} dias) para ${emails.length} personal(is)...\n`);

  let ok = 0;
  let fail = 0;

  for (const email of emails) {
    try {
      const result = await pool.query<{ id: number; name: string; role: string }>(
        `SELECT id, name, role FROM users WHERE email = $1`,
        [email.trim().toLowerCase()],
      );

      if (result.rows.length === 0) {
        console.log(`  ✗  ${email}  →  usuário não encontrado`);
        fail++;
        continue;
      }

      const user = result.rows[0];

      if (user.role !== 'personal') {
        console.log(`  ✗  ${email}  →  role "${user.role}" (esperado: personal)`);
        fail++;
        continue;
      }

      await setPersonalPlan(user.id, 'pro', {
        periodDays: PERIOD_DAYS,
        notes: NOTES,
        setBy: user.id, // self — bootstrap sem admin humano rastreado
      });

      const until = new Date(Date.now() + PERIOD_DAYS * 86400_000).toLocaleDateString('pt-BR');
      console.log(`  ✓  ${email}  →  ${user.name} (id=${user.id})  Pro até ${until}`);
      ok++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗  ${email}  →  ERRO: ${msg}`);
      fail++;
    }
  }

  console.log(`\n✅ Concluído — ${ok} ok, ${fail} falha(s)\n`);
  await pool.end();
}

run().catch((err) => {
  logger.error({ err }, 'grantPilotPersonalPro: fatal');
  process.exit(1);
});
