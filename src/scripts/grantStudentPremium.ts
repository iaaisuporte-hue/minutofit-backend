/**
 * Concede o plano Premium (assinatura de ALUNO) a um ou mais usuários.
 *
 * Uso:
 *   npm run script:grant-student-premium -- 17 136           (por id)
 *   npm run script:grant-student-premium -- a@b.com 17       (id ou e-mail, misturados)
 *   npm run script:grant-student-premium -- 17 --dry-run     (só mostra o que faria)
 *   npm run script:grant-student-premium -- 17 --revoke      (volta para Free)
 *
 * Existia `grantAcademyPro` e `grantPilotPersonalPro`, mas nada para o plano do
 * ALUNO — que é outra tabela (`user_subscriptions` + `subscription_tiers`) e
 * outro conceito: o personal assina a plataforma, o aluno assina o app.
 *
 * ## Como o plano do aluno é resolvido
 *
 * `resolveCurrentPlanForUser` procura a assinatura ATIVA mais recente e casa o
 * nome do tier com o nome do plano (`plans p ON p.name = st.name`). Por isso o
 * script grava uma linha em `user_subscriptions` com o tier Premium e status
 * 'active' — é exatamente o que aquela consulta espera encontrar.
 *
 * Idempotente: se já existir assinatura ativa do mesmo tier, não duplica.
 * Assinaturas ativas de OUTROS tiers são encerradas, senão a ordenação por
 * `created_at DESC` poderia devolver a antiga.
 *
 * ## Atenção à ordem em produção
 *
 * A feature `performance` (Spec 033, P2) só passa a existir na tabela `features`
 * quando o backend sobe com o código da P2 — quem semeia é o
 * `ensurePlanFeaturesSchema` no boot. Conceder Premium ANTES do deploy deixa o
 * usuário no plano certo mas sem a chave, e o gate continua fechado. Deploy
 * primeiro, concessão depois (ou reinicie o serviço após conceder).
 */

import pool from '../config/database';
import logger from '../lib/logger';

const TIER_NAME = 'Premium';

interface Target {
  raw: string;
  userId: number | null;
  email: string | null;
}

function parseTargets(): { targets: Target[]; dryRun: boolean; revoke: boolean } {
  const args = process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
  const dryRun = args.includes('--dry-run');
  const revoke = args.includes('--revoke');
  const targets = args
    .filter((a) => !a.startsWith('--'))
    .map((raw) => ({
      raw,
      userId: /^\d+$/.test(raw) ? Number(raw) : null,
      email: raw.includes('@') ? raw.toLowerCase() : null,
    }))
    .filter((t) => t.userId !== null || t.email !== null);
  return { targets, dryRun, revoke };
}

async function run(): Promise<void> {
  const { targets, dryRun, revoke } = parseTargets();

  if (targets.length === 0) {
    console.error(
      'Informe ao menos um id ou e-mail.\n' +
        '  npm run script:grant-student-premium -- 17 136\n' +
        '  npm run script:grant-student-premium -- 17 --dry-run\n' +
        '  npm run script:grant-student-premium -- 17 --revoke',
    );
    process.exitCode = 1;
    return;
  }

  const tier = await pool.query<{ id: number }>(
    `SELECT id FROM subscription_tiers WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [TIER_NAME],
  );
  if (tier.rows.length === 0) {
    console.error(`Tier "${TIER_NAME}" não existe em subscription_tiers. Abortando.`);
    process.exitCode = 1;
    return;
  }
  const tierId = tier.rows[0].id;

  // Aviso de ordem: sem a chave no catálogo, Premium não destrava Performance.
  const feature = await pool.query(`SELECT 1 FROM features WHERE key = 'performance'`);
  if (feature.rows.length === 0) {
    console.warn(
      '\n⚠  A feature "performance" ainda NÃO existe neste banco.\n' +
        '   O usuário ficará Premium, mas o módulo Performance segue bloqueado até\n' +
        '   o backend subir com o código da P2 (o boot semeia o catálogo).\n',
    );
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}${revoke ? 'Revogando' : 'Concedendo'} ${TIER_NAME} — ${targets.length} alvo(s)\n`);

  for (const t of targets) {
    const found = await pool.query<{ id: number; email: string; name: string }>(
      t.userId !== null
        ? `SELECT id, email, name FROM users WHERE id = $1`
        : `SELECT id, email, name FROM users WHERE LOWER(email) = $1`,
      [t.userId !== null ? t.userId : t.email],
    );

    if (found.rows.length === 0) {
      console.log(`  ✗ ${t.raw}: usuário não encontrado`);
      continue;
    }
    const user = found.rows[0];

    const atual = await pool.query<{ tier: string; status: string }>(
      `SELECT st.name AS tier, us.status
         FROM user_subscriptions us
         JOIN subscription_tiers st ON st.id = us.tier_id
        WHERE us.user_id = $1 AND us.status = 'active'
        ORDER BY us.created_at DESC`,
      [user.id],
    );
    const antes = atual.rows.length > 0 ? atual.rows.map((r) => r.tier).join(', ') : 'Free (sem assinatura)';

    if (dryRun) {
      console.log(`  · ${user.id} (${user.email}): ${antes} → ${revoke ? 'Free' : TIER_NAME}`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Encerra qualquer assinatura ativa: a resolução do plano pega a mais
      // recente, e deixar duas ativas torna o resultado dependente de ordenação.
      await client.query(
        `UPDATE user_subscriptions
            SET status = 'cancelled', active_to = NOW(), updated_at = NOW()
          WHERE user_id = $1 AND status = 'active'`,
        [user.id],
      );

      if (!revoke) {
        await client.query(
          `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from)
           VALUES ($1, $2, 'active', NOW())`,
          [user.id, tierId],
        );
      }

      await client.query('COMMIT');
      console.log(`  ✓ ${user.id} (${user.email}): ${antes} → ${revoke ? 'Free' : TIER_NAME}`);
      logger.info(
        { userId: user.id, tier: revoke ? 'free' : TIER_NAME, script: 'grant-student-premium' },
        '[script] plano do aluno alterado',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      console.log(`  ✗ ${user.id} (${user.email}): falhou — ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log('');
}

run()
  .catch((err) => {
    console.error('Erro ao executar o script:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
