/**
 * Protocolos do personal autônomo (QA 01/ago/2026, P0-1).
 *
 * `workout_protocols_scope_academy_chk` exigia `academy_id IS NOT NULL` para
 * scope 'personal'. Personal autônomo tem academy_id NULL por design
 * (isolamento por owner_personal_id, não por tenant), então TODA gravação de
 * ficha falhava: `createPersonalProtocolSnapshot` roda dentro da transação de
 * `createPersonalWorkoutPlan*`, o INSERT violava o CHECK e o personal recebia
 * 500 em qualquer save — multi-dia, legado e criação manual de protocolo.
 *
 * O commit 7e5572f corrigiu a LEITURA da biblioteca para o autônomo; a escrita
 * seguia barrada no schema.
 *
 * Novo predicado: 'personal' passa a exigir dono (owner_personal_id) em vez de
 * academia. academy_id livre — NULL = autônomo, preenchido = personal de
 * academia (o isolamento por tenant continua nas queries do service, que já
 * casam `academy_id = $2` quando há tenant).
 */

const CHK = 'workout_protocols_scope_academy_chk';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // Banco virgem: a tabela é criada por ensureWorkoutProtocolsSchema, que roda
  // depois das migrations e já nasce com o predicado novo. Sem a guarda, o
  // ALTER derrubaria o boot com 42P01 num banco limpo.
  await pgm.db.query(`
    DO $$
    BEGIN
      IF to_regclass('public.workout_protocols') IS NOT NULL THEN
        ALTER TABLE workout_protocols DROP CONSTRAINT IF EXISTS ${CHK};
        ALTER TABLE workout_protocols
          ADD CONSTRAINT ${CHK} CHECK (
               (scope = 'platform' AND academy_id IS NULL)
            OR (scope = 'academy'  AND academy_id IS NOT NULL)
            OR (scope = 'personal' AND owner_personal_id IS NOT NULL)
          );
      END IF;
    END $$;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Volta ao predicado antigo. Protocolos de personal autônomo (academy_id NULL)
  // criados sob o predicado novo violariam o CHECK — removidos antes para que o
  // rollback não trave. Perda aceitável: são snapshots derivados de fichas, e a
  // ficha em personal_workout_plans continua intacta.
  await pgm.db.query(`
    DO $$
    BEGIN
      IF to_regclass('public.workout_protocols') IS NOT NULL THEN
        DELETE FROM workout_protocols WHERE scope = 'personal' AND academy_id IS NULL;
        ALTER TABLE workout_protocols DROP CONSTRAINT IF EXISTS ${CHK};
        ALTER TABLE workout_protocols
          ADD CONSTRAINT ${CHK} CHECK (
               (scope = 'platform' AND academy_id IS NULL)
            OR (scope IN ('personal', 'academy') AND academy_id IS NOT NULL)
          );
      END IF;
    END $$;
  `);
};
