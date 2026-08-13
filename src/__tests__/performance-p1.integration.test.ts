/**
 * Módulo Performance P1 — invariantes que SÓ o banco pode provar (Spec 033).
 *
 * Estes dez blocos são a fundação das ondas P2–P5: se qualquer um quebrar, os
 * recordes, o score e as metas ficam construídos sobre chão falso. Foram
 * validados por sondas manuais durante a implementação; aqui viram teste
 * versionado, porque o registro do próprio CLAUDE.md é explícito sobre o custo
 * de entregar fundação sem teste ("o P0 passou por três QAs porque a Spec 025
 * foi entregue sem teste").
 *
 * Rodar:
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/<db> npm test
 *
 * Sem `TEST_DATABASE_URL` a suíte inteira se auto-pula. Ver helpers/integrationDb.ts.
 */
import { createRequire } from 'module';

import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createExercise,
  createSessionRow,
  createSetLog,
  createUser,
  describeWithDb,
  hasTestDb,
  releaseSuiteLock,
  runBackfill,
} from './helpers/integrationDb';

/** Namespace desta suíte — não colide com as fixtures das outras. */
const TAG = 'itest-p1';

const loadCjs = createRequire(__filename);

// O serviço real precisa do pool apontando para o banco de teste. Só faz
// sentido quando há banco; sem ele o describe é pulado e nada disto roda.
if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(60_000);

describeWithDb('Performance P1 · integração com banco real', () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    // Enfileira contra a outra suíte de integração — as duas dividem o banco.
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await releaseSuiteLock(c);
    await c.end();
    // Fecha o pool do app, senão o Jest não encerra.
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  // ── 1. migration up → down → up ─────────────────────────────────────────

  describe('1 · migration é reversível de verdade', () => {
    it('down remove as 4 tabelas e up as recria com constraints', async () => {
      const migration = loadCjs('../../migrations/1823000000000_performance-foundation.js');
      const pgm = { db: { query: (sql: string, p?: unknown[]) => c.query(sql, p) } };
      const TABLES = [
        'workout_session_metrics',
        'user_pr_events',
        'user_performance_goals',
        'user_performance_snapshots',
      ];

      const exists = async () => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM pg_tables
            WHERE schemaname = 'public' AND tablename = ANY($1)`,
          [TABLES],
        );
        return rows[0].n as number;
      };

      expect(await exists()).toBe(4);
      await migration.down(pgm);
      expect(await exists()).toBe(0);
      await migration.up(pgm);
      expect(await exists()).toBe(4);

      // E as constraints voltam junto — recriar tabela sem CHECK seria uma
      // reversão só na aparência.
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'workout_session_metrics'::regclass AND contype = 'c'`,
      );
      const names = rows.map((r) => r.conname);
      expect(names).toEqual(
        expect.arrayContaining([
          'workout_session_metrics_method_chk',
          'workout_session_metrics_load_pair_chk',
        ]),
      );
    });

    it('up roda duas vezes seguidas sem erro (idempotente)', async () => {
      const migration = loadCjs('../../migrations/1823000000000_performance-foundation.js');
      const pgm = { db: { query: (sql: string, p?: unknown[]) => c.query(sql, p) } };
      await expect(migration.up(pgm)).resolves.not.toThrow();
      await expect(migration.up(pgm)).resolves.not.toThrow();
    });
  });

  // ── 2 e 3. backfill ─────────────────────────────────────────────────────

  describe('2 · backfill de workout_session_metrics', () => {
    it('agrega só séries realizadas e ignora sessão sem execução', async () => {
      const userId = await createUser(c, TAG, 'bf-metrics');
      const ex = await createExercise(c, TAG, 'Supino Backfill');

      const s1 = await createSessionRow(c, { userId, daysAgo: 10, sessionRpe: 7 });
      await createSetLog(c, { sessionId: s1, exerciseId: ex, name: 'Supino Backfill', setIndex: 1, reps: 10, loadKg: 70 });
      await createSetLog(c, { sessionId: s1, exerciseId: ex, name: 'Supino Backfill', setIndex: 2, reps: 10, loadKg: 70 });
      await createSetLog(c, { sessionId: s1, exerciseId: ex, name: 'Supino Backfill', setIndex: 3, reps: 8, loadKg: 70, status: 'skipped' });

      // abandonada: não descreve execução
      const s2 = await createSessionRow(c, { userId, daysAgo: 9, status: 'abandoned', sessionRpe: 9 });
      await createSetLog(c, { sessionId: s2, exerciseId: ex, name: 'Supino Backfill', setIndex: 1, reps: 10, loadKg: 200 });

      // sem RPE algum
      const s3 = await createSessionRow(c, { userId, daysAgo: 8, sessionRpe: null });
      await createSetLog(c, { sessionId: s3, exerciseId: ex, name: 'Supino Backfill', setIndex: 1, reps: 5, loadKg: 60 });

      await runBackfill(c);

      const { rows } = await c.query(
        `SELECT session_id, sets_done, reps_total, tonnage_kg::float8 AS tonnage,
                duration_min, srpe, effort_load::float8 AS load, effort_load_method
           FROM workout_session_metrics WHERE user_id = $1 ORDER BY session_id`,
        [userId],
      );
      const by = Object.fromEntries(rows.map((r) => [r.session_id, r]));

      expect(by[s1].sets_done).toBe(2); // a pulada não conta
      expect(by[s1].reps_total).toBe(20);
      expect(by[s1].tonnage).toBe(1400);
      expect(by[s1].srpe).toBe(7);
      expect(by[s1].load).toBe(56); // 7 × 2 séries × 4 min
      expect(by[s1].effort_load_method).toBe('srpe_sets');
      // started_at = ended_at: não houve medição de duração
      expect(by[s1].duration_min).toBeNull();

      expect(by[s2]).toBeUndefined(); // abandonada não gera métrica

      expect(by[s3].load).toBeNull(); // sem RPE não se inventa carga interna
      expect(by[s3].effort_load_method).toBeNull();
    });

    it('é idempotente: reexecutar não duplica nem altera', async () => {
      const before = await c.query(`SELECT count(*)::int AS n FROM workout_session_metrics
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      await runBackfill(c);
      const after = await c.query(`SELECT count(*)::int AS n FROM workout_session_metrics
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('treino sem carga tem tonelagem NULL, não zero', async () => {
      const userId = await createUser(c, TAG, 'bf-bodyweight');
      const ex = await createExercise(c, TAG, 'Barra Fixa BF');
      const s = await createSessionRow(c, { userId, daysAgo: 5, sessionRpe: 8 });
      await createSetLog(c, { sessionId: s, exerciseId: ex, name: 'Barra Fixa BF', setIndex: 1, reps: 12, loadKg: null });
      await runBackfill(c);

      const { rows } = await c.query(
        `SELECT tonnage_kg, reps_total FROM workout_session_metrics WHERE session_id = $1`, [s]);
      expect(rows[0].tonnage_kg).toBeNull();
      expect(rows[0].reps_total).toBe(12);
    });
  });

  describe('3 · backfill de user_pr_events', () => {
    it('emite evento só quando supera o melhor anterior, com previous_value', async () => {
      const userId = await createUser(c, TAG, 'bf-pr');
      const ex = await createExercise(c, TAG, 'Agacho PR');

      // 70 (estreia) → 72 (recorde) → 68 (regressão) → 80 (recorde)
      for (const [daysAgo, load] of [[30, 70], [20, 72], [10, 68], [5, 80]] as const) {
        const s = await createSessionRow(c, { userId, daysAgo, sessionRpe: 7 });
        for (let i = 1; i <= 3; i += 1) {
          await createSetLog(c, { sessionId: s, exerciseId: ex, name: 'Agacho PR', setIndex: i, reps: 10, loadKg: load });
        }
      }
      await runBackfill(c);

      const { rows } = await c.query(
        `SELECT value::float8 AS v, previous_value::float8 AS pv, is_first
           FROM user_pr_events
          WHERE user_id = $1 AND exercise_id = $2 AND kind = 'max_load'
          ORDER BY value`,
        [userId, ex],
      );
      expect(rows.map((r) => r.v)).toEqual([70, 72, 80]); // 68 não gerou evento
      expect(rows[0].is_first).toBe(true);
      expect(rows[0].pv).toBeNull();
      expect(rows[1].pv).toBe(70);
      expect(rows[2].pv).toBe(72);
    });

    it('e1RM respeita a guarda de 12 repetições', async () => {
      const userId = await createUser(c, TAG, 'bf-e1rm');
      const ex = await createExercise(c, TAG, 'Rosca E1RM');
      const s = await createSessionRow(c, { userId, daysAgo: 4, sessionRpe: 7 });
      // 20 reps: fora da faixa em que a estimativa se sustenta
      await createSetLog(c, { sessionId: s, exerciseId: ex, name: 'Rosca E1RM', setIndex: 1, reps: 20, loadKg: 30 });
      await runBackfill(c);

      const e1rm = await c.query(
        `SELECT 1 FROM user_pr_events WHERE user_id = $1 AND kind = 'best_e1rm'`, [userId]);
      expect(e1rm.rows).toHaveLength(0);
      // mas a série ainda vale como carga e volume
      const other = await c.query(
        `SELECT kind FROM user_pr_events WHERE user_id = $1 ORDER BY kind`, [userId]);
      expect(other.rows.map((r) => r.kind)).toEqual(['max_load', 'session_volume']);
    });

    it('max_reps só existe para série SEM carga', async () => {
      const userId = await createUser(c, TAG, 'bf-reps');
      const comCarga = await createExercise(c, TAG, 'Com Carga');
      const semCarga = await createExercise(c, TAG, 'Sem Carga');
      const s = await createSessionRow(c, { userId, daysAgo: 3, sessionRpe: 6 });
      await createSetLog(c, { sessionId: s, exerciseId: comCarga, name: 'Com Carga', setIndex: 1, reps: 15, loadKg: 40 });
      await createSetLog(c, { sessionId: s, exerciseId: semCarga, name: 'Sem Carga', setIndex: 1, reps: 15, loadKg: null });
      await runBackfill(c);

      const withLoad = await c.query(
        `SELECT 1 FROM user_pr_events WHERE exercise_id = $1 AND kind = 'max_reps'`, [comCarga]);
      expect(withLoad.rows).toHaveLength(0);

      const bodyweight = await c.query(
        `SELECT value::float8 AS v FROM user_pr_events WHERE exercise_id = $1 AND kind = 'max_reps'`, [semCarga]);
      expect(bodyweight.rows[0].v).toBe(15);
    });

    it('é idempotente: reexecutar não duplica evento', async () => {
      const before = await c.query(`SELECT count(*)::int AS n FROM user_pr_events
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      await runBackfill(c);
      const after = await c.query(`SELECT count(*)::int AS n FROM user_pr_events
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  // ── 4 e 5. transação do createSession ───────────────────────────────────

  describe('4 · rollback do createSession não deixa linha órfã', () => {
    it('falha no meio da transação desfaz sessão E métrica', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'rollback');
      const ex = await createExercise(c, TAG, 'Ex Rollback');

      const count = async (table: string) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
        return rows[0].n as number;
      };
      expect(await count('workout_sessions')).toBe(0);

      // plan_id inexistente viola a FK do cabeçalho → ROLLBACK de tudo
      await expect(
        createSession(userId, null, {
          source: 'free',
          status: 'completed',
          planId: 2147483600,
          sessionRpe: 7,
          sets: [{ exerciseId: ex, name: 'Ex Rollback', setIndex: 1, repsDone: 10, loadDoneKg: 50, status: 'done' }],
        }),
      ).rejects.toThrow();

      expect(await count('workout_sessions')).toBe(0);
      expect(await count('workout_session_metrics')).toBe(0);
    });

    it('sucesso grava sessão e métrica na MESMA transação', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'writethrough');
      const ex = await createExercise(c, TAG, 'Ex WT');

      const res = await createSession(userId, null, {
        source: 'free',
        status: 'completed',
        title: 'Sessão WT',
        sessionRpe: 8,
        sets: [
          { exerciseId: ex, name: 'Ex WT', setIndex: 1, repsDone: 10, loadDoneKg: 100, status: 'done' },
          { exerciseId: ex, name: 'Ex WT', setIndex: 2, repsDone: 8, loadDoneKg: 100, status: 'done' },
          { exerciseId: ex, name: 'Ex WT', setIndex: 3, repsDone: 6, loadDoneKg: 100, status: 'skipped' },
        ],
      });

      const { rows } = await c.query(
        `SELECT sets_done, reps_total, tonnage_kg::float8 AS tonnage, srpe,
                effort_load::float8 AS load, effort_load_method, formula_version
           FROM workout_session_metrics WHERE session_id = $1`,
        [res.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].sets_done).toBe(2);
      expect(rows[0].reps_total).toBe(18);
      expect(rows[0].tonnage).toBe(1800);
      expect(rows[0].srpe).toBe(8);
      expect(rows[0].load).toBe(64);
      expect(rows[0].effort_load_method).toBe('srpe_sets');
      expect(rows[0].formula_version).toBe(1);
    });

    it('sessão sem série realizada não gera métrica (nem zero artificial)', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'noexec');
      const ex = await createExercise(c, TAG, 'Ex NoExec');
      const res = await createSession(userId, null, {
        source: 'free',
        status: 'completed',
        sessionRpe: 5,
        sets: [{ exerciseId: ex, name: 'Ex NoExec', setIndex: 1, repsDone: 10, loadDoneKg: 50, status: 'skipped' }],
      });
      const { rows } = await c.query(
        `SELECT 1 FROM workout_session_metrics WHERE session_id = $1`, [res.id]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('5 · replay idempotente da mesma conclusão', () => {
    it('reenvio devolve a MESMA sessão e não duplica métrica', async () => {
      const { createSession } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'replay');
      const ex = await createExercise(c, TAG, 'Ex Replay');
      const plan = await c.query(
        `INSERT INTO personal_workout_plans (personal_id, student_id, title, week_preset, payload_json)
         VALUES ($1, $1, 'Ficha Replay', '4', '[]'::jsonb) RETURNING id`,
        [userId],
      );
      const planId = plan.rows[0].id;
      const payload = {
        source: 'personal' as const,
        status: 'completed' as const,
        title: 'Dia A',
        planId,
        dayIndex: 0,
        sessionRpe: 7,
        sets: [{ exerciseId: ex, name: 'Ex Replay', setIndex: 1, repsDone: 10, loadDoneKg: 90, status: 'done' as const }],
        awardGamification: true,
      };

      const first = await createSession(userId, null, payload);
      const second = await createSession(userId, null, payload);

      expect(second.duplicate).toBe(true);
      expect(second.id).toBe(first.id);

      const metrics = await c.query(
        `SELECT count(*)::int AS n FROM workout_session_metrics WHERE session_id = $1`, [first.id]);
      expect(metrics.rows[0].n).toBe(1);

      const sessions = await c.query(
        `SELECT count(*)::int AS n FROM workout_sessions WHERE user_id = $1`, [userId]);
      expect(sessions.rows[0].n).toBe(1);
    });
  });

  // ── 6, 7 e 8. consistência: UNION, dedupe e fuso ────────────────────────

  describe('6 e 7 · UNION das três fontes de dia ativo', () => {
    it('conta as três fontes e não dobra o mesmo dia', async () => {
      const { countActiveDays } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'union');

      // Dia A: presente nas TRÊS fontes ao mesmo tempo → deve contar 1
      await c.query(
        `INSERT INTO user_workout_logs (user_id, workout_id, title, muscle_groups, completed_at)
         VALUES ($1, 'w1', 't', ARRAY['legs'], NOW() - INTERVAL '3 days')`, [userId]);
      await createSessionRow(c, { userId, daysAgo: 3 });
      await c.query(
        `INSERT INTO personal_session_logs (personal_id, student_id, status, session_at)
         VALUES ($1, $1, 'present', NOW() - INTERVAL '3 days')`, [userId]);
      expect(await countActiveDays(userId, 28)).toBe(1);

      // Dia B: SÓ presença marcada pelo personal → conta (Spec 009)
      await c.query(
        `INSERT INTO personal_session_logs (personal_id, student_id, status, session_at)
         VALUES ($1, $1, 'present', NOW() - INTERVAL '5 days')`, [userId]);
      expect(await countActiveDays(userId, 28)).toBe(2);

      // 'absent' NÃO é dia ativo — é justamente o que deixa o gap crescer
      await c.query(
        `INSERT INTO personal_session_logs (personal_id, student_id, status, session_at)
         VALUES ($1, $1, 'absent', NOW() - INTERVAL '7 days')`, [userId]);
      expect(await countActiveDays(userId, 28)).toBe(2);

      // sessão abandonada também não
      await createSessionRow(c, { userId, daysAgo: 9, status: 'abandoned' });
      expect(await countActiveDays(userId, 28)).toBe(2);
    });

    it('o calendário marca o dia que só tem presença do personal', async () => {
      const { loadMonthCalendar } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'cal-personal');
      await c.query(
        `INSERT INTO personal_session_logs (personal_id, student_id, status, session_at)
         VALUES ($1, $1, 'present', NOW() - INTERVAL '1 day')`, [userId]);

      const now = new Date();
      const days = await loadMonthCalendar(userId, now.getUTCFullYear(), now.getUTCMonth() + 1);
      const fromPersonal = days.find((d) => d.sources.includes('personal'));
      // (pode cair no mês anterior se hoje for dia 1 — nesse caso o teste do mês
      // anterior cobre; aqui só exigimos que não desapareça quando está no mês)
      if (now.getUTCDate() > 1) {
        expect(fromPersonal).toBeDefined();
        expect(fromPersonal?.active).toBe(true);
      }
    });
  });

  describe('8 · fuso: colunas timestamptz vs timestamp sem fuso', () => {
    it('treino às 22h (BRT) e 19h do dia seguinte são DOIS dias', async () => {
      const { countActiveDays } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'tz-two-days');
      // Em UTC o primeiro viraria o dia seguinte e os dois colidiriam em 1 dia.
      await createSessionRow(c, { userId, daysAgo: 4, atTime: '22:00' });
      await createSessionRow(c, { userId, daysAgo: 3, atTime: '19:00' });
      expect(await countActiveDays(userId, 28)).toBe(2);
    });

    it('a coluna SEM fuso resolve no mesmo dia que a coluna COM fuso', async () => {
      const { countActiveDays } = await import('../modules/performance/performance.repository');
      const userId = await createUser(c, TAG, 'tz-naive');

      // MESMO instante em duas fontes de tipo diferente:
      //   user_workout_logs.completed_at → timestamp SEM fuso
      //   workout_sessions.performed_at  → timestamptz
      // Se a conversão não tratar a naive como UTC antes, ela desloca 3h e o
      // mesmo treino aparece em dois dias — inflando os dias ativos.
      await c.query(
        `INSERT INTO user_workout_logs (user_id, workout_id, title, muscle_groups, completed_at)
         VALUES ($1, 'tz', 't', ARRAY['legs'],
                 ((CURRENT_DATE - 2 + TIME '22:30') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')`,
        [userId],
      );
      await createSessionRow(c, { userId, daysAgo: 2, atTime: '22:30' });

      expect(await countActiveDays(userId, 28)).toBe(1);
    });
  });

  // ── 9. paginação keyset ─────────────────────────────────────────────────

  describe('9 · keyset com performed_at idêntico', () => {
    it('percorre tudo sem repetir nem pular quando os instantes empatam', async () => {
      const { listSessionsPage, decodeSessionCursor } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'keyset');

      // 7 sessões com o MESMO performed_at — o caso real do registro retroativo,
      // que ancora a data ao meio-dia UTC.
      const ids: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const { rows } = await c.query(
          `INSERT INTO workout_sessions
             (user_id, source, status, prescribed_snapshot, started_at, ended_at, performed_at)
           VALUES ($1,'free','completed','[]'::jsonb,
                   NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', '2026-07-01T12:00:00Z')
           RETURNING id`,
          [userId],
        );
        ids.push(rows[0].id);
      }
      // e mais 3 em datas distintas, para exercitar a mudança de instante
      for (let i = 1; i <= 3; i += 1) {
        ids.push(await createSessionRow(c, { userId, daysAgo: i }));
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page: { sessions: Record<string, unknown>[]; nextCursor: string | null } =
          await listSessionsPage(userId, 3, cursor ? decodeSessionCursor(cursor) : null);
        seen.push(...page.sessions.map((s) => Number(s.id)));
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor && guard < 50);

      expect(seen).toHaveLength(ids.length);
      expect(new Set(seen).size).toBe(ids.length); // nenhuma repetida
      expect(seen.sort((a, b) => a - b)).toEqual(ids.sort((a, b) => a - b)); // nenhuma pulada
    });

    it('cursor ilegível cai na primeira página em vez de estourar', async () => {
      const { listSessionsPage, decodeSessionCursor } = await import('../services/workoutSessionService');
      const userId = await createUser(c, TAG, 'keyset-bad');
      await createSessionRow(c, { userId, daysAgo: 1 });
      const page = await listSessionsPage(userId, 5, decodeSessionCursor('lixo-invalido'));
      expect(page.sessions.length).toBe(1);
    });
  });

  // ── 10. exclusão de exercício preserva o recorde ────────────────────────

  describe('10 · exclusão de exercício NÃO apaga o recorde do aluno', () => {
    it('SET NULL preserva a linha, o valor e o nome histórico', async () => {
      const userId = await createUser(c, TAG, 'ex-delete');
      const ex = await createExercise(c, TAG, 'Exercicio Que Sera Removido');

      const s = await createSessionRow(c, { userId, daysAgo: 6, sessionRpe: 8 });
      await createSetLog(c, {
        sessionId: s, exerciseId: ex, name: 'Exercicio Que Sera Removido',
        setIndex: 1, reps: 5, loadKg: 120,
      });
      await runBackfill(c);

      const before = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE user_id = $1 AND exercise_id = $2`,
        [userId, ex],
      );
      expect(before.rows[0].n).toBeGreaterThan(0);

      // O catálogo é global: um dia a limpeza da duplicação de `exercises`
      // vai apagar linhas. O recorde do aluno não pode ir junto.
      await c.query(`DELETE FROM exercises WHERE id = $1`, [ex]);

      const after = await c.query(
        `SELECT exercise_id, exercise_name, value::float8 AS v, kind
           FROM user_pr_events WHERE user_id = $1 ORDER BY kind`,
        [userId],
      );
      expect(after.rows.length).toBe(before.rows[0].n); // nada foi apagado
      for (const row of after.rows) {
        expect(row.exercise_id).toBeNull(); // vínculo desfeito
        expect(row.exercise_name).toBe('Exercicio Que Sera Removido'); // contexto preservado
      }
      expect(after.rows.find((r) => r.kind === 'max_load')?.v).toBe(120);
    });

    it('o recorde órfão continua visível numa leitura sem JOIN obrigatório', async () => {
      // Contrato para a P2: LEFT JOIN (ou nenhum) — um INNER JOIN em `exercises`
      // sumiria com exatamente estas linhas.
      const userId = await createUser(c, TAG, 'ex-delete-read');
      const ex = await createExercise(c, TAG, 'Outro Removido');
      const s = await createSessionRow(c, { userId, daysAgo: 6, sessionRpe: 8 });
      await createSetLog(c, { sessionId: s, exerciseId: ex, name: 'Outro Removido', setIndex: 1, reps: 5, loadKg: 90 });
      await runBackfill(c);
      await c.query(`DELETE FROM exercises WHERE id = $1`, [ex]);

      const leftJoin = await c.query(
        `SELECT p.exercise_name, e.name AS catalog_name
           FROM user_pr_events p
           LEFT JOIN exercises e ON e.id = p.exercise_id
          WHERE p.user_id = $1`,
        [userId],
      );
      expect(leftJoin.rows.length).toBeGreaterThan(0);
      expect(leftJoin.rows[0].catalog_name).toBeNull();
      expect(leftJoin.rows[0].exercise_name).toBe('Outro Removido');

      const innerJoin = await c.query(
        `SELECT 1 FROM user_pr_events p
           JOIN exercises e ON e.id = p.exercise_id
          WHERE p.user_id = $1`,
        [userId],
      );
      expect(innerJoin.rows).toHaveLength(0); // a prova de por que o JOIN tem que ser LEFT
    });

    it('dois exercícios excluídos NÃO colapsam num só (NULLS DISTINCT)', async () => {
      const userId = await createUser(c, TAG, 'ex-delete-two');
      const a = await createExercise(c, TAG, 'Removido A');
      const b = await createExercise(c, TAG, 'Removido B');
      const s = await createSessionRow(c, { userId, daysAgo: 6, sessionRpe: 8 });
      // MESMO valor nos dois: se o índice único tratasse NULL como igual, um
      // dos recordes seria perdido no futuro.
      await createSetLog(c, { sessionId: s, exerciseId: a, name: 'Removido A', setIndex: 1, reps: 5, loadKg: 100 });
      await createSetLog(c, { sessionId: s, exerciseId: b, name: 'Removido B', setIndex: 2, reps: 5, loadKg: 100 });
      await runBackfill(c);
      await c.query(`DELETE FROM exercises WHERE id = ANY($1)`, [[a, b]]);

      const { rows } = await c.query(
        `SELECT exercise_name, value::float8 AS v FROM user_pr_events
          WHERE user_id = $1 AND kind = 'max_load' ORDER BY exercise_name`,
        [userId],
      );
      expect(rows.map((r) => r.exercise_name)).toEqual(['Removido A', 'Removido B']);
      expect(rows.every((r) => r.v === 100)).toBe(true);
    });

    it('reexecutar o backfill depois da exclusão não ressuscita nem duplica', async () => {
      const before = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE exercise_id IS NULL
           AND user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      await runBackfill(c);
      const after = await c.query(
        `SELECT count(*)::int AS n FROM user_pr_events WHERE exercise_id IS NULL
           AND user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}-%@test.local`]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });
});
