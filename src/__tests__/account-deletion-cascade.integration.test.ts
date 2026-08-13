/**
 * Exclusão de conta — a cascata inteira, com banco real (hardening pós-QA).
 *
 * O QA de produção descobriu que apagar uma conta deixava a FICHA para trás,
 * viva e sem dono. As contas sumiam, os consentimentos sumiam, os vínculos
 * sumiam — e a prescrição ficava, com dias e exercícios intactos.
 *
 * Este teste monta um aluno completo (vínculo, ficha, execução, métricas,
 * recordes, metas, consentimentos, adaptação) e prova que, depois do DELETE,
 * não sobra entidade operacional órfã nem dado pessoal solto. É a checagem que
 * faltava: a migration 1822 provou que a exclusão NÃO FALHA; esta prova que ela
 * LIMPA.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createUser,
  describeWithDb,
  hasTestDb,
  releaseSuiteLock,
  restorePerformanceSchema,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(90_000);

const TAG = 'itest-del';

describeWithDb('Exclusão de conta · a cascata limpa tudo', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    // `restorePerformanceSchema` aplica TODA migration a partir da 1823, o que
    // inclui a 1826 — o objeto deste teste. Um carregador próprio aqui seria
    // uma segunda lista de migrations para alguém esquecer de atualizar.
    await restorePerformanceSchema(c);
    const { ensurePlanFeaturesSchema } = await import('../db/ensurePlanFeaturesSchema');
    await ensurePlanFeaturesSchema();
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await releaseSuiteLock(c);
    await c.end();
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  /**
   * Aluno completo: tudo que um usuário real acumula em algumas semanas.
   *
   * O nome do exercício leva um contador porque `exercises` tem único por
   * (nome, source) e a fixture é montada uma vez POR TESTE.
   */
  let seq = 0;
  async function montarAlunoCompleto() {
    seq += 1;
    const personalId = await createUser(c, TAG, `personal-${seq}`);
    const studentId = await createUser(c, TAG, `aluno-${seq}`);
    const exerciseId = await createExercise(c, TAG, `Supino da exclusão ${seq}`);

    await c.query(
      `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id)
       VALUES ($1, $2, 'active', NULL)`,
      [personalId, studentId],
    );

    for (const scope of ['profile', 'workouts', 'daily_checkins']) {
      await c.query(
        `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
         VALUES ($1, $2, 'personal', $3, 'granted')`,
        [studentId, personalId, scope],
      );
    }

    const plano = await c.query<{ id: number }>(
      `INSERT INTO personal_workout_plans
         (personal_id, student_id, title, week_preset, payload_json, academy_id)
       VALUES ($1, $2, 'Ficha da exclusão', '4', '[]'::jsonb, NULL) RETURNING id`,
      [personalId, studentId],
    );
    const planId = plano.rows[0].id;

    await c.query(
      `INSERT INTO personal_workout_plan_days (plan_id, day_index, name, payload_json)
       VALUES ($1, 1, 'Dia A', '[]'::jsonb)`,
      [planId],
    );

    const sessao = await c.query<{ id: number }>(
      `INSERT INTO workout_sessions (user_id, personal_id, plan_id, day_index, status, source, started_at, performed_at)
       VALUES ($1, $2, $3, 1, 'completed', 'personal', NOW(), NOW()) RETURNING id`,
      [studentId, personalId, planId],
    );
    const sessionId = sessao.rows[0].id;

    await c.query(
      `INSERT INTO workout_set_logs
         (session_id, exercise_id, exercise_name, order_index, set_index, reps_done, load_done_kg, status)
       VALUES ($1, $2::uuid, 'Supino da exclusão', 0, 1, 10, 80, 'done')`,
      [sessionId, exerciseId],
    );

    await c.query(
      `INSERT INTO workout_session_metrics
         (session_id, user_id, performed_at, sets_done, reps_total, tonnage_kg, formula_version)
       VALUES ($1, $2, NOW(), 1, 10, 800, 1)`,
      [sessionId, studentId],
    );

    await c.query(
      `INSERT INTO user_pr_events
         (user_id, exercise_id, exercise_name, kind, value, reps, load_kg, is_first, achieved_at, formula_version)
       VALUES ($1, $2::uuid, 'Supino da exclusão', 'max_load', 80, 10, 80, true, NOW(), 1)`,
      [studentId, exerciseId],
    );

    await c.query(
      `INSERT INTO user_performance_goals
         (user_id, kind, target_value, unit, status, starts_on, metric_version)
       VALUES ($1, 'weekly_frequency', 4, 'sessions', 'active', CURRENT_DATE, 1)`,
      [studentId],
    );

    await c.query(
      `INSERT INTO user_daily_checkins (user_id, date_key, source, xp_awarded, feeling)
       VALUES ($1, CURRENT_DATE, 'wellbeing', 0, 'tired')`,
      [studentId],
    );

    await c.query(
      `INSERT INTO workout_adaptation_log
         (student_id, personal_id, plan_id, day_index, snapshot_date, readiness_level, policy_version,
          policy_snapshot, original_payload, adapted_payload, changes)
       VALUES ($1, $2, $3, 1, CURRENT_DATE, 'yellow', 1, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [studentId, personalId, planId],
    );

    return { personalId, studentId, planId, sessionId };
  }

  const contar = async (sql: string, params: unknown[]): Promise<number> => {
    const { rows } = await c.query<{ n: number }>(sql, params);
    return Number(rows[0].n);
  };

  it('apaga o aluno e não deixa NENHUMA entidade operacional para trás', async () => {
    const { studentId, planId, sessionId } = await montarAlunoCompleto();

    // Antes: tudo existe.
    expect(await contar(`SELECT COUNT(*)::int n FROM personal_workout_plans WHERE id=$1`, [planId])).toBe(1);
    expect(await contar(`SELECT COUNT(*)::int n FROM workout_sessions WHERE id=$1`, [sessionId])).toBe(1);

    // O DELETE não pode falhar por FK — foi o P0 da migration 1822.
    await expect(c.query(`DELETE FROM users WHERE id = $1`, [studentId])).resolves.toBeDefined();

    const sobras = {
      ficha: await contar(`SELECT COUNT(*)::int n FROM personal_workout_plans WHERE id=$1`, [planId]),
      dias: await contar(`SELECT COUNT(*)::int n FROM personal_workout_plan_days WHERE plan_id=$1`, [planId]),
      sessoes: await contar(`SELECT COUNT(*)::int n FROM workout_sessions WHERE user_id=$1`, [studentId]),
      series: await contar(`SELECT COUNT(*)::int n FROM workout_set_logs WHERE session_id=$1`, [sessionId]),
      metricas: await contar(`SELECT COUNT(*)::int n FROM workout_session_metrics WHERE user_id=$1`, [studentId]),
      recordes: await contar(`SELECT COUNT(*)::int n FROM user_pr_events WHERE user_id=$1`, [studentId]),
      metas: await contar(`SELECT COUNT(*)::int n FROM user_performance_goals WHERE user_id=$1`, [studentId]),
      checkins: await contar(`SELECT COUNT(*)::int n FROM user_daily_checkins WHERE user_id=$1`, [studentId]),
      consents: await contar(`SELECT COUNT(*)::int n FROM user_data_consents WHERE user_id=$1`, [studentId]),
      vinculos: await contar(`SELECT COUNT(*)::int n FROM personal_student_assignments WHERE student_id=$1`, [studentId]),
      adaptacoes: await contar(`SELECT COUNT(*)::int n FROM workout_adaptation_log WHERE student_id=$1`, [studentId]),
    };

    expect(sobras).toEqual({
      ficha: 0, dias: 0, sessoes: 0, series: 0, metricas: 0, recordes: 0,
      metas: 0, checkins: 0, consents: 0, vinculos: 0, adaptacoes: 0,
    });
  });

  it('nenhuma ficha fica com student_id NULL — era o defeito encontrado', async () => {
    const { studentId } = await montarAlunoCompleto();
    const antes = await contar(`SELECT COUNT(*)::int n FROM personal_workout_plans WHERE student_id IS NULL`, []);

    await c.query(`DELETE FROM users WHERE id = $1`, [studentId]);

    const depois = await contar(`SELECT COUNT(*)::int n FROM personal_workout_plans WHERE student_id IS NULL`, []);
    expect(depois).toBe(antes);
  });

  it('a ficha SOBREVIVE quando quem sai é o personal — ela é do aluno também', async () => {
    // A contrapartida da regra: o aluno não pode perder a prescrição que está
    // seguindo porque o treinador encerrou a conta.
    const { personalId, studentId, planId } = await montarAlunoCompleto();

    await c.query(`DELETE FROM users WHERE id = $1`, [personalId]);

    const { rows } = await c.query<{ student_id: number | null; personal_id: number | null }>(
      `SELECT student_id, personal_id FROM personal_workout_plans WHERE id = $1`,
      [planId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].student_id).toBe(studentId);
    expect(rows[0].personal_id).toBeNull();
  });

  it('o serviço de exclusão da aplicação também roda até o fim, sem 500', async () => {
    // O caminho do DELETE direto prova o schema; este prova o caminho que o
    // usuário aciona no app.
    const { deleteUserAccount } = await import('../services/accountDeletionService');
    const { studentId } = await montarAlunoCompleto();

    await expect(deleteUserAccount(studentId, { requestedBy: 'self' })).resolves.not.toThrow();
    expect(await contar(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [studentId])).toBe(0);
    expect(await contar(`SELECT COUNT(*)::int n FROM personal_workout_plans WHERE student_id=$1`, [studentId])).toBe(0);
  });

  it('a trilha de acesso de OUTRO titular não é destruída junto', async () => {
    // Regra da migration 1822: `actor_id` vira NULL, `subject_user_id`
    // cascateia. Apagar a linha inteira destruiria a prova de acesso aos dados
    // de quem não pediu exclusão.
    const { personalId, studentId } = await montarAlunoCompleto();
    const outro = await createUser(c, TAG, 'outro-titular');

    await c.query(
      `INSERT INTO data_access_audit (actor_id, subject_user_id, event_type, event_payload)
       VALUES ($1, $2, 'personal.snapshot.read', '{}'::jsonb)`,
      [studentId, outro],
    );

    await c.query(`DELETE FROM users WHERE id = $1`, [studentId]);

    const { rows } = await c.query<{ actor_id: number | null }>(
      `SELECT actor_id FROM data_access_audit WHERE subject_user_id = $1`,
      [outro],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
    expect(personalId).toBeGreaterThan(0);
  });
});
