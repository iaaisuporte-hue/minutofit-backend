/**
 * Reversibilidade da migration 1829 (Spec 034, Onda C2).
 *
 * O `down` aqui é o arriscado: ele APAGA linhas de `user_data_consents` com
 * escopo `group_visibility` e reescreve um CHECK enumerado. Se estiver
 * quebrado, só se descobre num rollback de produção — que é o pior momento
 * possível para descobrir.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  connect,
  describeWithDb,
  hasTestDb,
  finishSuite,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
jest.setTimeout(120_000);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../migrations/1829000000000_challenges.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const teardown = require('../../migrations/1830000000000_academy-teardown-and-challenge-fk.js');

describeWithDb('Migration 1829 · up → down → up', () => {
  let c: Client;
  const pgm = (cli: Client) => ({
    db: { query: (sql: string, params?: unknown[]) => cli.query(sql, params) },
  });

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
  });

  afterAll(async () => {
    // `finishSuite` libera o lock no `finally`: limpeza que falha não
    // pode reter o advisory lock e travar as suítes seguintes.
    await finishSuite(c, async () => {
      // Deixa o schema no estado esperado pelas demais suítes.
      await migration.up(pgm(c));
      await teardown.up(pgm(c));
    });
  });

  async function existe(tabela: string): Promise<boolean> {
    const { rows } = await c.query<{ r: string | null }>(
      `SELECT to_regclass('public.' || $1)::text AS r`,
      [tabela],
    );
    return rows[0].r != null;
  }

  async function checkAceita(escopo: string): Promise<boolean> {
    const { rows } = await c.query<{ ok: boolean }>(
      `SELECT pg_get_constraintdef(oid) LIKE '%' || $1 || '%' AS ok
         FROM pg_constraint WHERE conname = 'user_data_consents_scope_check'`,
      [escopo],
    );
    return rows[0]?.ok === true;
  }

  it('sobe, desce e sobe de novo sem deixar resto', async () => {
    await migration.up(pgm(c));
    expect(await existe('challenges')).toBe(true);
    expect(await existe('challenge_participants')).toBe(true);
    expect(await checkAceita('group_visibility')).toBe(true);

    await migration.down(pgm(c));
    expect(await existe('challenges')).toBe(false);
    expect(await existe('challenge_participants')).toBe(false);
    // O CHECK volta ao enumerado anterior — sem o escopo novo, com os antigos.
    expect(await checkAceita('group_visibility')).toBe(false);
    expect(await checkAceita('clinical_nutrition')).toBe(true);

    await migration.up(pgm(c));
    expect(await existe('challenges')).toBe(true);
    expect(await checkAceita('group_visibility')).toBe(true);
  });

  it('o down apaga os consents do escopo ANTES de restaurar o CHECK', async () => {
    // Se apagasse depois, a constraint voltaria já violada e o rollback
    // morreria no meio, deixando o banco num estado que ninguém previu.
    await migration.up(pgm(c));

    const { rows: u } = await c.query<{ id: number }>(
      `INSERT INTO users (email, password, role, name, cpf, phone)
       VALUES ('mig1829-a@test.local','x','user','Fixture','918273645','11918273645')
       RETURNING id`,
    );
    const { rows: p } = await c.query<{ id: number }>(
      `INSERT INTO users (email, password, role, name, cpf, phone)
       VALUES ('mig1829-b@test.local','x','personal','Fixture','918273646','11918273646')
       RETURNING id`,
    );
    await c.query(
      `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
       VALUES ($1, $2, 'personal', 'group_visibility', 'granted')`,
      [u[0].id, p[0].id],
    );

    await expect(migration.down(pgm(c))).resolves.toBeUndefined();

    const { rows } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM user_data_consents WHERE scope = 'group_visibility'`,
    );
    expect(rows[0].n).toBe(0);

    await migration.up(pgm(c));
    await c.query(`DELETE FROM users WHERE email LIKE 'mig1829-%@test.local'`);
  });

  it('a 1830 sobe, desce e sobe — e é ela que torna possível excluir academia', async () => {
    await migration.up(pgm(c));
    await teardown.up(pgm(c));

    // O defeito: `academy_roles` cascateia da academia e tem gatilho de
    // auditoria; a FK do audit recusava o INSERT do gatilho porque a academia
    // já tinha sumido na mesma transação. Excluir academia era impossível.
    const { rows: a } = await c.query<{ id: number }>(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ('mig1830-a', 'Teste', 'Teste', 'active') RETURNING id`,
    );
    await c.query(
      `INSERT INTO academy_roles (academy_id, slug, label, permissions, is_system)
       VALUES ($1, 'academy_student', 'Aluno', '[]'::jsonb, true)`,
      [a[0].id],
    );
    await expect(
      c.query(`DELETE FROM academies WHERE id = $1`, [a[0].id]),
    ).resolves.toBeDefined();

    await teardown.down(pgm(c));
    await teardown.up(pgm(c));
    // Depois do round trip, continua funcionando.
    const { rows: b } = await c.query<{ id: number }>(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ('mig1830-b', 'Teste', 'Teste', 'active') RETURNING id`,
    );
    await c.query(
      `INSERT INTO academy_roles (academy_id, slug, label, permissions, is_system)
       VALUES ($1, 'academy_student', 'Aluno', '[]'::jsonb, true)`,
      [b[0].id],
    );
    await expect(
      c.query(`DELETE FROM academies WHERE id = $1`, [b[0].id]),
    ).resolves.toBeDefined();
  });

  it('desafio institucional CASCATEIA quando a academia some', async () => {
    await migration.up(pgm(c));
    await teardown.up(pgm(c));

    const { rows: a } = await c.query<{ id: number }>(
      `INSERT INTO academies (slug, legal_name, display_name, status)
       VALUES ('mig1830-c', 'Teste', 'Teste', 'active') RETURNING id`,
    );
    const { rows: u } = await c.query<{ id: number }>(
      `INSERT INTO users (email, password, role, name, cpf, phone)
       VALUES ('mig1830-c@test.local','x','user','Fixture','918273650','11918273650')
       RETURNING id`,
    );
    const { rows: ch } = await c.query<{ id: string }>(
      `INSERT INTO challenges (scope, created_by_user_id, academy_id, title, kind,
                               rule_json, starts_on, ends_on, status)
       VALUES ('academy', $1, $2, 'X', 'consistency', '{"requiredWeeks":1}'::jsonb,
               CURRENT_DATE, CURRENT_DATE + 7, 'active')
       RETURNING id::text`,
      [u[0].id, a[0].id],
    );

    await c.query(`DELETE FROM academies WHERE id = $1`, [a[0].id]);

    // Entidade operacional não sobrevive ao dono (precedente da 1826).
    const { rows } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM challenges WHERE id = $1::bigint`,
      [ch[0].id],
    );
    expect(rows[0].n).toBe(0);

    await c.query(`DELETE FROM users WHERE id = $1`, [u[0].id]);
  });

  it('o CHECK de dono tolera o SET NULL do personal excluído', async () => {
    // Foi a armadilha das migrations 1819 e 1825: um CHECK que exige a FK
    // colide com o ON DELETE SET NULL da mesma coluna e IMPEDE a exclusão.
    await migration.up(pgm(c));
    const { rows: p } = await c.query<{ id: number }>(
      `INSERT INTO users (email, password, role, name, cpf, phone)
       VALUES ('mig1829-c@test.local','x','personal','Fixture','918273647','11918273647')
       RETURNING id`,
    );
    await c.query(
      `INSERT INTO challenges (scope, created_by_user_id, personal_id, title, kind,
                               rule_json, starts_on, ends_on, status)
       VALUES ('personal', $1, $1, 'X', 'consistency', '{"requiredWeeks":1}'::jsonb,
               CURRENT_DATE, CURRENT_DATE + 7, 'active')`,
      [p[0].id],
    );

    // O UPDATE simula o SET NULL da FK sem depender da ordem de exclusão.
    await expect(
      c.query(`UPDATE challenges SET personal_id = NULL WHERE created_by_user_id = $1`, [p[0].id]),
    ).resolves.toBeDefined();

    await c.query(`DELETE FROM challenges WHERE created_by_user_id = $1`, [p[0].id]);
    await c.query(`DELETE FROM users WHERE id = $1`, [p[0].id]);
  });
});
