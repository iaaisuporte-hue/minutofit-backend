/**
 * Cadeia de boot do schema — migrations + `ensure*`, em ordem determinística.
 *
 * Vivia dentro do `index.ts`, o que amarrava "montar o schema" a "subir o
 * servidor": só era possível preparar um banco iniciando o app inteiro. Isso
 * bastava em produção e impedia o CI, que precisa exatamente disto e mais nada
 * — e um CI sem banco é a razão de os testes de integração terem passado meses
 * se auto-pulando.
 *
 * Extraído para cá SEM mudança de comportamento: mesma ordem, mesmos passos
 * críticos, mesma semântica de fatal × resiliente. `index.ts` e o script de
 * preparação do CI chamam a mesma função, para não existir a pergunta "o banco
 * do CI é montado igual ao de produção?".
 */
import * as Sentry from '@sentry/node';

import pool from '../config/database';
import logger from '../lib/logger';
import { ensureUsersCoreColumns } from './ensureUsersCoreColumns';
import { ensureComplianceSchema } from './ensureComplianceSchema';
import { ensurePlanFeaturesSchema } from './ensurePlanFeaturesSchema';
import { ensureMessagesSchema } from './ensureMessagesSchema';
import { ensurePersonalWorkoutPlansSchema } from './ensurePersonalWorkoutPlansSchema';
import { ensureWorkoutReviewsSchema } from './ensureWorkoutReviewsSchema';
import { ensurePersonalDashboardIndexes } from './ensurePersonalDashboardIndexes';
import { ensureUsersMetabolismColumns } from './ensureUsersMetabolismColumns';
import { ensureMetabolismSchema } from './ensureMetabolismSchema';
import { ensureDailyCheckinSignalsSchema } from './ensureDailyCheckinSignalsSchema';
import { ensureRevokedTokensSchema } from './ensureRevokedTokensSchema';
import { ensureActivitySessionsSchema } from './ensureActivitySessionsSchema';
import { ensureMovementSessionsSchema } from './ensureMovementSessionsSchema';
import { ensureAcademiesSchema } from './ensureAcademiesSchema';
import { seedDefaultAcademy } from './seedDefaultAcademy';
import { ensureStudentsSchema } from './ensureStudentsSchema';
import { ensureReceptionSchema } from './ensureReceptionSchema';
import { ensureTenantColumnsPhase2 } from './ensureTenantColumnsPhase2';
import { backfillTenantColumns } from './backfillTenantColumns';
import { ensureTenantColumnsPhase2Lock } from './ensureTenantColumnsPhase2Lock';
import { relaxAcademyIdNullable } from './relaxAcademyIdNullable';
import { ensurePersonalDirectInvitesSchema } from './ensurePersonalDirectInvitesSchema';
import { ensureStudentExerciseNotesSchema } from './ensureStudentExerciseNotesSchema';
import { ensureWorkoutProtocolsSchema } from './ensureWorkoutProtocolsSchema';
import { ensureExercisesSchema } from './ensureExercisesSchema';
import { seedExercisesIfEmpty } from './seedExercisesIfEmpty';
import { ensureProductsSchema } from './ensureProductsSchema';
import { backfillUserProducts } from './backfillUserProducts';
import { runMigrations } from './runMigrations';

/**
 * O schema BASE (users, videos, user_subscriptions…) não vem do boot: é criado
 * uma única vez por `npm run db:seed`. As migrations e os `ensure*` só o
 * ALTERAM. Num banco vazio, portanto, a primeira migration morre com um
 * `relation "..." does not exist` que não diz o que fazer, e o processo sai
 * com código 1 — o que na prática parecia "o app não sobe" para quem estava
 * montando ambiente novo (QA 01/ago/2026, P0-3).
 *
 * A checagem abaixo troca esse erro críptico por uma instrução.
 */
async function assertBaseSchemaPresent(): Promise<void> {
  const { rows } = await pool.query<{ users: string | null }>(
    `SELECT to_regclass('public.users')::text AS users`
  );
  if (rows[0]?.users === null) {
    logger.fatal(
      '[boot] schema base ausente (tabela `users` não existe). Este banco nunca foi ' +
        'inicializado: rode `npm run db:seed` uma vez antes do primeiro boot. ' +
        'Migrations e ensure* apenas ALTERAM o schema base — não o criam.'
    );
    throw new Error('BASE_SCHEMA_MISSING');
  }
}

/**
 * Tabelas criadas por `ensure*` das quais MIGRATIONS dependem (9 migrations
 * referenciam personal_workout_plans, outras workout_protocols/workout_reviews).
 * Se qualquer uma faltar, rodar as migrations primeiro é garantia de 42P01.
 */
const ENSURE_OWNED_MIGRATION_DEPS = [
  'personal_workout_plans',
  'workout_reviews',
  'workout_protocols',
  'personal_student_assignments',
];

async function schemaNeedsEnsurePrepass(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT t.name AS table_name
       FROM unnest($1::text[]) AS t(name)
      WHERE to_regclass('public.' || t.name) IS NULL`,
    [ENSURE_OWNED_MIGRATION_DEPS]
  );
  return rows.map((r) => r.table_name);
}

export async function runBootChain(): Promise<void> {
  await assertBaseSchemaPresent();

  // A ordem canônica é migrations → ensure*. Ela pressupõe que as tabelas
  // legadas JÁ existem — verdade em produção, falso num banco recém-semeado:
  // ali as migrations morrem em `relation "personal_workout_plans" does not
  // exist` e derrubam o boot (QA 01/ago/2026, P0-3).
  //
  // Quando (e só quando) detectamos schema incompleto, rodamos os `ensure*`
  // antes, em modo não-fatal, para estabelecer as tabelas que as migrations
  // esperam. Tudo é idempotente, então o passe autoritativo depois das
  // migrations continua sendo a fonte da verdade. Em produção a sonda não
  // acusa nada e o caminho é exatamente o de sempre.
  const missing = await schemaNeedsEnsurePrepass();
  if (missing.length > 0) {
    logger.warn({ missing }, '[boot] schema incompleto — pré-passe de ensure* antes das migrations');
    await runSchemaSteps(buildSchemaSteps(), { fatal: false });
  }

  await runMigrations();
  await runSchemaSteps(buildSchemaSteps(), { fatal: true });
}

function buildSchemaSteps(): Array<[string, () => Promise<unknown>]> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['ensureUsersCoreColumns', ensureUsersCoreColumns],
    ['ensureComplianceSchema', ensureComplianceSchema],
    ['ensurePlanFeaturesSchema', ensurePlanFeaturesSchema],
    ['ensureMessagesSchema', ensureMessagesSchema],
    ['ensurePersonalWorkoutPlansSchema', ensurePersonalWorkoutPlansSchema],
    ['ensureWorkoutReviewsSchema', ensureWorkoutReviewsSchema],
    ['ensurePersonalDashboardIndexes', ensurePersonalDashboardIndexes],
    ['ensureUsersMetabolismColumns', ensureUsersMetabolismColumns],
    ['ensureMetabolismSchema', ensureMetabolismSchema],
    ['ensureDailyCheckinSignalsSchema', ensureDailyCheckinSignalsSchema],
    ['ensureRevokedTokensSchema', ensureRevokedTokensSchema],
    ['ensureActivitySessionsSchema', ensureActivitySessionsSchema],
    ['ensureMovementSessionsSchema', ensureMovementSessionsSchema],
    ['ensureAcademiesSchema', ensureAcademiesSchema],
    ['seedDefaultAcademy', seedDefaultAcademy],
    ['ensureStudentsSchema', ensureStudentsSchema],
    ['ensureReceptionSchema', ensureReceptionSchema],
    ['ensureTenantColumnsPhase2', ensureTenantColumnsPhase2],
    ['backfillTenantColumns', backfillTenantColumns],
    ['ensureTenantColumnsPhase2Lock', ensureTenantColumnsPhase2Lock],
    ['relaxAcademyIdNullable', relaxAcademyIdNullable],
    ['ensurePersonalDirectInvitesSchema', ensurePersonalDirectInvitesSchema],
    ['ensureStudentExerciseNotesSchema', ensureStudentExerciseNotesSchema],
    ['ensureWorkoutProtocolsSchema', ensureWorkoutProtocolsSchema],
    // ensureProtocolBackfill removido do boot (mai/2026): recriava protocolos
    // a partir de fichas órfãs no banco, conflitando com a intenção do personal
    // de ter excluído o protocolo. CLI ainda disponível via `npm run script:backfill-protocols`.
    ['ensureExercisesSchema', ensureExercisesSchema],
    ['seedExercisesIfEmpty', seedExercisesIfEmpty],
    ['ensureProductsSchema', ensureProductsSchema],
    ['backfillUserProducts', backfillUserProducts],
  ];

  return steps;
}

// Passos cujo schema é pré-requisito de segurança/gating: se falharem, o app
// serviria autenticação/produtos/isolamento de tenant quebrados de forma silenciosa.
// Para esses, falhar é fatal (igual às migrations) — aborta o boot via re-throw.
// Os demais continuam resilientes (degradar > derrubar).
const CRITICAL_STEPS = new Set<string>([
  'ensureProductsSchema',          // sem user_product_memberships → feature gates quebram
  'ensureRevokedTokensSchema',     // sem denylist → logout/refresh não revogam
  'backfillTenantColumns',         // sem backfill, o lock abaixo não aplica NOT NULL
  'ensureTenantColumnsPhase2Lock', // sem NOT NULL → academy_id nullable → vaza entre tenants
]);

async function runSchemaSteps(
  steps: Array<[string, () => Promise<unknown>]>,
  opts: { fatal: boolean }
): Promise<void> {
  const totalStart = Date.now();
  for (const [name, fn] of steps) {
    const t = Date.now();
    try {
      await fn();
      logger.info({ step: name, ms: Date.now() - t }, '[boot] schema ok');
    } catch (err) {
      if (!opts.fatal) {
        logger.warn({ step: name, err }, '[boot] schema error — continuing (non-fatal pass)');
        continue;
      }
      Sentry.captureException(err, { tags: { boot_step: name } });
      if (CRITICAL_STEPS.has(name)) {
        logger.fatal({ step: name, err }, '[boot] passo crítico falhou — abortando startup');
        throw err; // runBootChain().catch() → process.exit(1)
      }
      logger.error({ step: name, err }, '[boot] schema error — continuing');
    }
  }
  logger.info({ total_ms: Date.now() - totalStart, fatal: opts.fatal }, '[boot] schema chain complete');
}

// O boot chain (migrations + ensure*) agora gateia o app.listen() no final
// deste arquivo: uma migration que falha ABORTA o startup (process.exit) em vez
// de subir o servidor com schema parcial servindo 500s silenciosos.

