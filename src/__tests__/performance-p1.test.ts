/**
 * Módulo Performance — Onda P1 (Spec 033).
 *
 * Aqui ficam as invariantes que dá para travar sem I/O: engines puros, cursor,
 * forma da migration e as expressões de fuso das queries. O comportamento que
 * exige banco (backfill sobre dados reais, write-through na transação,
 * rollback, UNION das três fontes) é verificado pelas sondas em banco recriado
 * do zero, descritas no relatório da onda.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import { estimateOneRepMax } from '../modules/performance/e1rm.engine';
import {
  computeSessionMetrics,
  resolveDurationMin,
} from '../modules/performance/sessionMetrics.engine';
import {
  computeConsistencyPct,
  resolveConsistencyTarget,
} from '../modules/performance/consistency.engine';
import { FORMULA_VERSION } from '../modules/performance/performance.constants';
import { decodeSessionCursor, encodeSessionCursor } from '../services/workoutSessionService';

const loadCjs = createRequire(__filename);
const readSrc = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8');

// ── e1RM ────────────────────────────────────────────────────────────────────

describe('P1 · e1RM (Epley com guardas)', () => {
  it('1 repetição devolve praticamente a própria carga', () => {
    // 100 × (1 + 1/30) = 103.33 → 103.5 no arredondamento de 0,5
    expect(estimateOneRepMax(100, 1)).toBe(103.5);
  });

  it('calcula no limite superior aceito (12 reps)', () => {
    // 70 × (1 + 12/30) = 98
    expect(estimateOneRepMax(70, 12)).toBe(98);
  });

  it('NÃO estima acima de 12 reps — extrapolação vira número inventado', () => {
    expect(estimateOneRepMax(70, 13)).toBeNull();
    expect(estimateOneRepMax(70, 30)).toBeNull();
  });

  it('exige carga positiva e reps válidas', () => {
    expect(estimateOneRepMax(0, 10)).toBeNull();
    expect(estimateOneRepMax(null, 10)).toBeNull();
    expect(estimateOneRepMax(70, 0)).toBeNull();
    expect(estimateOneRepMax(70, null)).toBeNull();
    expect(estimateOneRepMax(NaN, 5)).toBeNull();
  });

  it('arredonda a 0,5 kg', () => {
    // 72 × (1 + 10/30) = 96 exato
    expect(estimateOneRepMax(72, 10)).toBe(96);
    // 70 × (1 + 10/30) = 93.33 → 93.5
    expect(estimateOneRepMax(70, 10)).toBe(93.5);
  });
});

// ── métricas da sessão ──────────────────────────────────────────────────────

const doneSet = (reps: number | null, load: number | null, rpe: number | null = null) =>
  ({ repsDone: reps, loadDoneKg: load, rpe, status: 'done' as const });

describe('P1 · métricas da sessão', () => {
  it('só séries realizadas entram — pulada não conta', () => {
    const m = computeSessionMetrics(
      [doneSet(10, 100), doneSet(10, 100), { ...doneSet(10, 100), status: 'skipped' }],
      { sessionRpe: 8, durationMin: null },
    );
    expect(m?.setsDone).toBe(2);
    expect(m?.repsTotal).toBe(20);
    expect(m?.tonnageKg).toBe(2000);
  });

  it('sessão sem nenhuma série realizada não gera métrica', () => {
    expect(
      computeSessionMetrics([{ ...doneSet(10, 100), status: 'skipped' }], {
        sessionRpe: 8,
        durationMin: null,
      }),
    ).toBeNull();
    expect(computeSessionMetrics([], { sessionRpe: 8, durationMin: null })).toBeNull();
  });

  it('treino sem carga tem tonelagem null (não zero) mas mantém esforço', () => {
    const m = computeSessionMetrics([doneSet(15, null), doneSet(12, null)], {
      sessionRpe: 7,
      durationMin: null,
    });
    expect(m?.tonnageKg).toBeNull();
    expect(m?.repsTotal).toBe(27);
    // carga interna existe mesmo sem peso: 7 × 2 séries × 4 min
    expect(m?.effortLoad).toBe(56);
    expect(m?.effortLoadMethod).toBe('srpe_sets');
  });

  it('usa duração medida quando ela existe', () => {
    const m = computeSessionMetrics([doneSet(10, 50)], { sessionRpe: 6, durationMin: 45 });
    expect(m?.effortLoad).toBe(270); // 6 × 45
    expect(m?.effortLoadMethod).toBe('srpe_duration');
  });

  it('sem RPE algum, carga interna é null — não se inventa dado', () => {
    const m = computeSessionMetrics([doneSet(10, 50), doneSet(10, 50)], {
      sessionRpe: null,
      durationMin: null,
    });
    expect(m?.effortLoad).toBeNull();
    expect(m?.effortLoadMethod).toBeNull();
    expect(m?.srpe).toBeNull();
  });

  it('cai para a média dos RPEs por série quando não há RPE de sessão', () => {
    const m = computeSessionMetrics([doneSet(10, 50, 6), doneSet(10, 50, 9)], {
      sessionRpe: null,
      durationMin: null,
    });
    expect(m?.srpe).toBe(8); // média 7.5 arredondada
  });

  it('RPE de série pulada não entra na média', () => {
    const m = computeSessionMetrics(
      [doneSet(10, 50, 6), { repsDone: 10, loadDoneKg: 50, rpe: 10, status: 'skipped' }],
      { sessionRpe: null, durationMin: null },
    );
    expect(m?.srpe).toBe(6);
  });

  it('série com carga mas reps nulas não contamina a tonelagem', () => {
    const m = computeSessionMetrics([doneSet(null, 100), doneSet(10, 100)], {
      sessionRpe: 5,
      durationMin: null,
    });
    expect(m?.tonnageKg).toBe(1000);
  });
});

describe('P1 · duração medida', () => {
  const t = (iso: string) => new Date(iso);

  it('retroativo não tem duração', () => {
    expect(resolveDurationMin(t('2026-08-01T10:00:00Z'), t('2026-08-01T11:00:00Z'), true)).toBeNull();
  });

  it('início igual ao fim (registro no final do treino) é ausência de medida', () => {
    const same = t('2026-08-01T10:00:00Z');
    expect(resolveDurationMin(same, same, false)).toBeNull();
  });

  it('mede e aplica o piso e o teto', () => {
    expect(resolveDurationMin(t('2026-08-01T10:00:00Z'), t('2026-08-01T10:45:00Z'), false)).toBe(45);
    // 2 minutos → piso de 5
    expect(resolveDurationMin(t('2026-08-01T10:00:00Z'), t('2026-08-01T10:02:00Z'), false)).toBe(5);
    // 9 horas → teto de 240
    expect(resolveDurationMin(t('2026-08-01T10:00:00Z'), t('2026-08-01T19:00:00Z'), false)).toBe(240);
  });
});

// ── consistência ────────────────────────────────────────────────────────────

describe('P1 · consistência de frequência', () => {
  it('alvo cheio é o semanal × 4 (28 dias = 4 semanas)', () => {
    expect(resolveConsistencyTarget(4, 60)).toBe(16);
    expect(resolveConsistencyTarget(5, null)).toBe(20);
  });

  it('alvo é proporcional para ficha recém-criada', () => {
    // 7 dias de ficha, alvo de 4/semana: 16 × (7/28) = 4
    expect(resolveConsistencyTarget(4, 7)).toBe(4);
  });

  it('piso de 7 dias impede denominador ridículo no primeiro dia', () => {
    // sem o piso, 1 dia de ficha daria alvo 1 e um treino marcaria 100%
    expect(resolveConsistencyTarget(4, 1)).toBe(4);
  });

  it('sem ficha não há denominador — null, nunca 0', () => {
    expect(resolveConsistencyTarget(null, 30)).toBeNull();
    expect(computeConsistencyPct(5, null)).toBeNull();
  });

  it('percentual tem teto de 100', () => {
    expect(computeConsistencyPct(20, 16)).toBe(100);
    expect(computeConsistencyPct(8, 16)).toBe(50);
    expect(computeConsistencyPct(0, 16)).toBe(0);
  });
});

// ── cursor do histórico ─────────────────────────────────────────────────────

describe('P1 · cursor keyset do histórico', () => {
  it('ida e volta preserva instante e id', () => {
    const cursor = encodeSessionCursor('2026-08-01T12:00:00.000Z', 42);
    expect(decodeSessionCursor(cursor)).toEqual({
      performedAt: '2026-08-01T12:00:00.000Z',
      id: 42,
    });
  });

  it('aceita Date além de string', () => {
    const cursor = encodeSessionCursor(new Date('2026-08-01T12:00:00.000Z'), 7);
    expect(decodeSessionCursor(cursor)?.id).toBe(7);
  });

  it('devolve null para entrada malformada em vez de lançar', () => {
    for (const bad of ['', 'lixo', '_', 'abc_xyz', '2026-08-01T12:00:00.000Z_0', 42, null, undefined, {}]) {
      expect(decodeSessionCursor(bad as unknown)).toBeNull();
    }
  });

  it('o id faz parte do cursor — performed_at sozinho não desempata', () => {
    // Duas sessões retroativas do mesmo dia têm o MESMO performed_at (âncora ao
    // meio-dia UTC). Sem o id, a fronteira entre páginas pularia ou repetiria.
    const a = encodeSessionCursor('2026-08-01T12:00:00.000Z', 10);
    const b = encodeSessionCursor('2026-08-01T12:00:00.000Z', 11);
    expect(a).not.toBe(b);
    expect(decodeSessionCursor(a)?.id).toBe(10);
    expect(decodeSessionCursor(b)?.id).toBe(11);
  });
});

// ── migration ───────────────────────────────────────────────────────────────

describe('P1 · migration 1823', () => {
  const migration = loadCjs('../../migrations/1823000000000_performance-foundation.js') as {
    up: (pgm: unknown) => Promise<void>;
    down: (pgm: unknown) => Promise<void>;
  };

  it('exporta up e down', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  it('down remove as quatro tabelas — reversão de verdade', async () => {
    const dropped: string[] = [];
    await migration.down({
      db: {
        query: async (sql: string) => {
          if (sql.includes('to_regclass')) return { rows: [{ oid: 1 }] };
          const m = sql.match(/DROP TABLE (\w+)/);
          if (m) dropped.push(m[1]);
          return { rows: [] };
        },
      },
    });
    expect(dropped.sort()).toEqual([
      'user_performance_goals',
      'user_performance_snapshots',
      'user_pr_events',
      'workout_session_metrics',
    ]);
  });

  it('backfill cobre apenas sessões completed/partial', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    const backfills = sql.match(/ws\.status IN \('completed', 'partial'\)/g) ?? [];
    // um filtro no backfill de métricas, outro no de recordes
    expect(backfills.length).toBeGreaterThanOrEqual(2);
  });

  it('backfill é idempotente nas duas tabelas', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(sql).toContain('ON CONFLICT (session_id) DO NOTHING');
    expect(sql).toContain('ON CONFLICT (user_id, exercise_id, kind, value) DO NOTHING');
  });

  it('e1RM do backfill respeita a mesma guarda de 12 reps do engine', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(sql).toContain('sl.reps_done BETWEEN 1 AND 12');
  });

  it('max_reps do backfill só considera séries SEM carga', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(sql).toMatch(/FILTER \(WHERE sl\.load_done_kg IS NULL AND sl\.reps_done > 0\) AS max_reps/);
  });

  it('as quatro tabelas cascateiam na exclusão da conta (LGPD)', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    const cascades = sql.match(/REFERENCES users\(id\) ON DELETE CASCADE/g) ?? [];
    expect(cascades.length).toBe(4);
  });

  it('o recorde sobrevive à exclusão do exercício (SET NULL, não CASCADE)', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    // O recorde é do aluno, não do catálogo. Mesma escolha de
    // workout_set_logs.exercise_id (migration 1802).
    expect(sql).toContain('exercise_id     UUID REFERENCES exercises(id) ON DELETE SET NULL');
    expect(sql).not.toContain('exercise_id     UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE');
  });

  it('tonelagem nula não vira número fabricado pelo LEAST', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    // LEAST(NULL, x) devolve x no Postgres: sem o CASE, todo treino de peso
    // corporal era gravado com ~1e10 kg.
    expect(sql).toContain('CASE WHEN a.tonnage_kg IS NULL THEN NULL');
    expect(sql).not.toMatch(/LEAST\(a\.tonnage_kg, 9999999999\.99\) AS tonnage_kg/);
  });

  it('score sem breakdown é proibido no banco — não só por convenção', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(sql).toContain('score IS NULL OR jsonb_array_length(factors) > 0');
  });

  it('grava a mesma FORMULA_VERSION que o código usa', () => {
    const sql = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(sql).toContain(`const FORMULA_VERSION = ${FORMULA_VERSION}`);
  });
});

// ── fuso nas queries ────────────────────────────────────────────────────────

describe('P1 · dia do aluno nas queries de consistência', () => {
  const repoRaw = readSrc('../modules/performance/performance.repository.ts');
  const repo = repoRaw;
  /** Só o código: comentários citam justamente o que NÃO fazemos. */
  const repoCode = repoRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('a coluna sem fuso (user_workout_logs) é normalizada por UTC antes do fuso do aluno', () => {
    // `AT TIME ZONE $2` direto num `timestamp` naive faz a conversão INVERSA e
    // empurra a data para a frente — o mesmo treino era contado em dois dias.
    expect(repo).toContain(`dayFromNaive('uwl.completed_at')`);
    expect(repo).toContain(`AT TIME ZONE 'UTC' AT TIME ZONE $2`);
  });

  it('as colunas com fuso usam a conversão direta', () => {
    expect(repo).toContain(`dayFromTz('ws.performed_at')`);
    expect(repo).toContain(`dayFromTz('psl.session_at')`);
  });

  it('nenhuma query usa date_trunc, que resolveria no fuso do servidor', () => {
    expect(repoCode).not.toContain('date_trunc');
  });

  it('conta as três fontes da Spec 009, com UNION (não UNION ALL)', () => {
    expect(repo).toContain('user_workout_logs');
    expect(repo).toContain('workout_sessions');
    expect(repo).toContain('personal_session_logs');
    expect(repo).toContain('COUNT(DISTINCT d)');
    expect(repoCode).not.toContain('UNION ALL');
  });

  it('só presença conta do lado do personal — falta não vira dia ativo', () => {
    expect(repo).toContain(`psl.status IN ('present', 'partial')`);
  });

  it('só sessão efetivamente treinada conta', () => {
    expect(repo).toContain(`ws.status IN ('completed', 'partial')`);
  });
});

describe('P1 · correções do review da onda', () => {
  const repo = readSrc('../modules/performance/performance.repository.ts');

  it('a idade da prescrição sai da PRIMEIRA ficha, não da ficha ativa', () => {
    // Usar `created_at` da ficha ativa zeraria o denominador a cada revisão e
    // a consistência saltaria para 100% sem o aluno mudar nada.
    expect(repo).toContain('MIN(created_at)');
    // A subconsulta da idade começa no SELECT do EXTRACT e termina em days_since:
    // dentro dela não pode haver filtro de ficha ativa.
    const start = repo.indexOf('EXTRACT(EPOCH FROM (NOW() - MIN(created_at))');
    const daysSince = repo.slice(start, repo.indexOf('AS days_since', start));
    expect(daysSince).toContain('MIN(created_at)');
    expect(daysSince).not.toContain('abandoned_at');
    expect(daysSince).not.toContain('ORDER BY');
  });

  it('o preset continua vindo da ficha ATIVA', () => {
    const preset = repo.slice(repo.indexOf('AS week_preset') - 300, repo.indexOf('AS week_preset'));
    expect(preset).toContain('abandoned_at IS NULL');
    expect(preset).toContain('ORDER BY created_at DESC');
  });

  it('o resumo Free vem numa consulta só (fan-out de conexões)', () => {
    expect(repo).toContain('loadFreeSummaryCounters');
    expect(repo).not.toContain('export async function countSessionsInWindow');
    expect(repo).not.toContain('export async function loadCurrentStreak');
  });

  it('sessions30d também conta por dia do aluno, como o activeDays28', () => {
    const fn = repo.slice(repo.indexOf('loadFreeSummaryCounters'));
    expect(fn.slice(0, 1200)).toContain('SOURCE_DAY_EXPR.session');
  });

  it('o mês padrão do calendário é o do aluno, não o UTC', () => {
    const raw = readSrc('../modules/performance/performance.routes.ts');
    // Só o código: o comentário cita `getUTCMonth()` justamente para explicar
    // por que ele NÃO é usado.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain("dayKey().split('-')");
    expect(code).not.toContain('getUTCMonth');
  });

  it('o export da conta inclui as quatro tabelas novas (LGPD)', () => {
    const del = readSrc('../services/accountDeletionService.ts');
    for (const t of [
      'workout_session_metrics',
      'user_pr_events',
      'user_performance_goals',
      'user_performance_snapshots',
    ]) {
      expect(del).toContain(t);
    }
  });

  it('a migration avisa a P2 sobre o ledger congelado', () => {
    const mig = readSrc('../../migrations/1823000000000_performance-foundation.js');
    expect(mig).toContain('ATENÇÃO PARA A ONDA P2');
  });
});

describe('P1 · getWorkoutStats usa a data canônica', () => {
  const svc = readSrc('../services/workoutSessionService.ts');

  it('as contas de frequência e progressão saem de performed_at', () => {
    const stats = svc.slice(svc.indexOf('export async function getWorkoutStats'));
    const body = stats.slice(0, stats.indexOf('export async function getStudentExecutionSummary'));
    expect(body).not.toContain('started_at');
    // e o dia/semana são os do ALUNO: date_trunc cru resolveria no fuso do
    // servidor (UTC na Render) e jogaria o treino das 21h30 para a semana seguinte.
    expect(body).toContain('AT TIME ZONE $2');
    expect(body).toContain("date_trunc('week', (now() AT TIME ZONE $2))");
    expect(body).not.toMatch(/performed_at >= date_trunc\('week', now\(\)\)/);
    expect(body).not.toContain('ws.performed_at::date');
  });
});

describe('P1 · write-through das métricas', () => {
  const svc = readSrc('../services/workoutSessionService.ts');

  it('o INSERT das métricas está dentro da transação, antes do COMMIT', () => {
    const insertAt = svc.indexOf('INSERT INTO workout_session_metrics');
    const commitAt = svc.indexOf("await client.query('COMMIT')", insertAt);
    expect(insertAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(insertAt);
  });

  it('usa o cliente da transação, nunca o pool', () => {
    const i = svc.indexOf('INSERT INTO workout_session_metrics');
    const before = svc.slice(Math.max(0, i - 200), i);
    expect(before).toContain('client.query');
  });

  it('as métricas derivam dos valores JÁ sanitizados que foram gravados', () => {
    expect(svc).toContain('persistedSets.push({ repsDone, loadDoneKg, rpe: setRpe, status: setStatus })');
  });
});
