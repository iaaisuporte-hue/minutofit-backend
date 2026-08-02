/**
 * Regressões da validação final de prontidão para produção (02/ago/2026).
 *
 * Cada bloco trava um defeito encontrado no Go/No-Go dos módulos Usuário e
 * Personal. Ver plans/validacao_final_prd_2026-08-02_1.md.
 *
 * Aqui ficam as invariantes que dão para travar sem I/O. As que exigem banco
 * (a exclusão de conta de ponta a ponta, a idempotência sob transação) são
 * verificadas pela sonda em banco recriado do zero, descrita no mesmo plano.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import { dayKey, APP_TIMEZONE } from '../utils/appDay';

const loadCjs = createRequire(__filename);
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8');

type FakePgm = { db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } };

describe('PRD-B1 · migration que destrava a exclusão de conta', () => {
  const migration = loadCjs(
    '../../migrations/1822000000000_account-deletion-fk-unblock.js',
  ) as {
    up: (pgm: FakePgm) => Promise<void>;
    down: (pgm: FakePgm) => Promise<void>;
  };

  it('exporta up e down', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  it('cobre as FKs que travavam TODA conta e as que travavam o personal', async () => {
    const touched: Array<[string, string]> = [];
    const pgm: FakePgm = {
      db: {
        query: async (sql, params) => {
          if (sql.includes('to_regclass')) return { rows: [{ oid: 1 }] };
          if (sql.includes('pg_constraint')) {
            touched.push([String(params?.[0]), String(params?.[1])]);
            return { rows: [] }; // sem constraint encontrada → nenhum ALTER
          }
          return { rows: [] };
        },
      },
    };
    await migration.up(pgm);
    expect(touched).toEqual(
      expect.arrayContaining([
        // travava todo mundo desde o cadastro (identity.user_created)
        ['data_access_audit', 'subject_user_id'],
        ['data_access_audit', 'actor_id'],
        // travavam especificamente o personal
        ['user_product_memberships', 'professional_id'],
        ['workout_adaptation_log', 'personal_id'],
      ]),
    );
  });

  it('a trilha do TITULAR cascateia e a do ATOR só anonimiza', async () => {
    // Semântica deliberada: a linha em que o excluído é `subject` é dado dele
    // (some junto); a linha em que ele é `actor` pertence à trilha de OUTRO
    // titular e precisa sobreviver sem o vínculo — apagá-la destruiria a
    // evidência de acesso aos dados de quem não pediu exclusão nenhuma.
    const alters: string[] = [];
    const pgm: FakePgm = {
      db: {
        query: async (sql, params) => {
          if (sql.includes('to_regclass')) return { rows: [{ oid: 1 }] };
          if (sql.includes('pg_constraint')) {
            return params?.[0] === 'data_access_audit'
              ? { rows: [{ conname: `data_access_audit_${params?.[1]}_fkey` }] }
              : { rows: [] };
          }
          alters.push(sql.replace(/\s+/g, ' ').trim());
          return { rows: [] };
        },
      },
    };
    await migration.up(pgm);

    const subject = alters.find((s) => s.includes('subject_user_id') && s.includes('ON DELETE'));
    const actor = alters.find((s) => s.includes('actor_id') && s.includes('ON DELETE'));
    expect(subject).toContain('ON DELETE CASCADE');
    expect(actor).toContain('ON DELETE SET NULL');
    // actor_id era NOT NULL: sem o DROP NOT NULL o SET NULL falharia no delete.
    expect(alters).toContain('ALTER TABLE data_access_audit ALTER COLUMN actor_id DROP NOT NULL');
  });

  it('pula tabelas ausentes em vez de abortar a migration', async () => {
    const pgm: FakePgm = {
      db: {
        query: async (sql) => {
          if (sql.includes('to_regclass')) return { rows: [{ oid: null }] };
          throw new Error('não deveria consultar constraint de tabela inexistente');
        },
      },
    };
    await expect(migration.up(pgm)).resolves.toBeUndefined();
  });
});

describe('PRD-B1 · biblioteca do personal não trava a exclusão dele', () => {
  it('protocolos de scope=personal são apagados, não órfãos', () => {
    // `owner_personal_id` é ON DELETE SET NULL, mas o CHECK
    // `workout_protocols_scope_academy_chk` exige dono quando scope='personal'.
    // O SET NULL violava a constraint e a exclusão do PERSONAL voltava 500 — o
    // defeito não aparecia no aluno, que não tem biblioteca.
    const source = readSrc('../services/accountDeletionService.ts');
    expect(source).toMatch(
      /DELETE FROM workout_protocols WHERE owner_personal_id = \$1 AND scope = 'personal'/,
    );
    // O de academia NÃO pode ir junto: a biblioteca é da academia e o personal
    // só assinou. Ali só a autoria se perde (SET NULL da FK).
    expect(source).not.toMatch(/DELETE FROM workout_protocols WHERE owner_personal_id = \$1\s*`/);
  });
});

describe('PRD-B1 · token sobrevivente de conta excluída vira sessão inválida', () => {
  it('/auth/me responde 401 (e não 404) quando o usuário não existe mais', () => {
    // O authMiddleware só valida a assinatura do JWT — não vai ao banco. Com a
    // conta apagada e o access token ainda dentro da validade (outra aba/outro
    // aparelho), o 404 antigo deixava o SPA em limbo: `authFetch` só reage a 401.
    const source = readSrc('../routes/auth.ts');
    expect(source).toContain("code: 'ACCOUNT_NOT_FOUND'");
    expect(source).toMatch(
      /if \(String\(error\?\.message\) === 'User not found'\)[\s\S]{0,200}status\(401\)/,
    );
  });
});

describe('C1 · idempotência da conclusão de treino', () => {
  // A chave natural do replay é aluno + ficha + dia da ficha + DIA DO ALUNO.
  // Se o dia usado fosse o UTC, um treino às 21h30 (BRT) e outro às 19h do dia
  // seguinte cairiam na mesma chave e o segundo seria engolido como duplicata.
  const key = (u: number, p: number, d: number | null, when: Date) =>
    `workout-session:${u}:${p}:${d ?? -1}:${dayKey(when)}`;

  it('a chave usa o fuso do aluno, não UTC', () => {
    expect(APP_TIMEZONE).toBe('America/Sao_Paulo');
    const seg2130BRT = new Date('2026-08-03T00:30:00Z'); // 21h30 de 02/ago em BRT
    const ter1900BRT = new Date('2026-08-03T22:00:00Z'); // 19h00 de 03/ago em BRT
    expect(key(1, 7, 0, seg2130BRT)).not.toBe(key(1, 7, 0, ter1900BRT));
    expect(key(1, 7, 0, seg2130BRT)).toContain('2026-08-02');
  });

  it('separa alunos, fichas e dias diferentes', () => {
    const t = new Date('2026-08-02T15:00:00Z');
    expect(key(1, 7, 0, t)).not.toBe(key(2, 7, 0, t));
    expect(key(1, 7, 0, t)).not.toBe(key(1, 8, 0, t));
    expect(key(1, 7, 0, t)).not.toBe(key(1, 7, 1, t));
  });

  it('trata dia ausente como valor próprio (não colide com o dia 0)', () => {
    const t = new Date('2026-08-02T15:00:00Z');
    expect(key(1, 7, null, t)).not.toBe(key(1, 7, 0, t));
  });

  it('o serviço serializa concorrentes e só deduplica treino ligado a ficha', () => {
    const source = readSrc('../services/workoutSessionService.ts');
    // Sem o lock transacional, dois envios simultâneos passam limpos pelo SELECT
    // e ambos inserem.
    expect(source).toContain('pg_advisory_xact_lock(hashtext($1))');
    // Avulso/tracker/Lab não têm chave natural — não podem ser bloqueados.
    expect(source).toMatch(
      /input\.planId != null && \(input\.status === 'completed' \|\| input\.status === 'partial'\)/,
    );
    // A comparação de dia tem de acontecer no fuso do app, não no do servidor.
    expect(source).toContain('(started_at AT TIME ZONE $4)::date = $5::date');
  });
});

describe('C2 · revogar `workouts` redige o snapshot do personal', () => {
  // Espelha o bloco de redação do handler: os campos derivados de treino que
  // vazavam com HTTP 200 mesmo depois da revogação.
  type Snap = {
    adherencePct: number;
    streakDays: number;
    today: { latestWorkout: unknown; workoutStatus: string; lastCheckinISO?: string };
    week: { days: Array<{ date: string; workedOut: boolean; checkedIn: boolean }>; avgFormScore: number | null; movementSessions7d: number };
    history: { muscleGroupCounts: unknown[]; formScoreSeries: unknown[]; xp: number };
  };

  function redact(data: Snap, scopes: Set<string>): Snap {
    if (!scopes.has('workouts')) {
      data.adherencePct = 0;
      data.streakDays = 0;
      if (data.today) {
        data.today.latestWorkout = null;
        data.today.workoutStatus = 'not_started';
      }
      if (data.week) {
        data.week.days = data.week.days.map((d) => ({ ...d, workedOut: false }));
        data.week.avgFormScore = null;
        data.week.movementSessions7d = 0;
      }
      if (data.history) {
        data.history.muscleGroupCounts = [];
        data.history.formScoreSeries = [];
        data.history.xp = 0;
      }
    }
    return data;
  }

  const snapshot = (): Snap => ({
    adherencePct: 80,
    streakDays: 12,
    today: { latestWorkout: { title: 'Peito' }, workoutStatus: 'completed', lastCheckinISO: 'x' },
    week: {
      days: [
        { date: '2026-08-01', workedOut: true, checkedIn: true },
        { date: '2026-08-02', workedOut: false, checkedIn: true },
      ],
      avgFormScore: 74,
      movementSessions7d: 3,
    },
    history: { muscleGroupCounts: [{ group: 'chest', count: 4 }], formScoreSeries: [1], xp: 300 },
  });

  it('sem `workouts`, nenhum sinal de treino permanece visível', () => {
    const out = redact(snapshot(), new Set(['profile', 'metabolic']));
    expect(out.week.days.every((d) => d.workedOut === false)).toBe(true);
    expect(out.today.latestWorkout).toBeNull();
    expect(out.today.workoutStatus).toBe('not_started');
    expect(out.adherencePct).toBe(0);
    expect(out.streakDays).toBe(0);
    expect(out.history.muscleGroupCounts).toEqual([]);
    expect(out.history.xp).toBe(0);
  });

  it('não apaga o que pertence a outros escopos', () => {
    const out = redact(snapshot(), new Set(['profile']));
    expect(out.week.days.every((d) => d.checkedIn === true)).toBe(true);
    expect(out.today.lastCheckinISO).toBe('x');
  });

  it('com `workouts` concedido, nada é redigido', () => {
    const out = redact(snapshot(), new Set(['profile', 'workouts']));
    expect(out.week.days[0].workedOut).toBe(true);
    expect(out.adherencePct).toBe(80);
    expect(out.history.xp).toBe(300);
  });

  it('o handler do snapshot aplica a redação de fato', () => {
    const source = readSrc('../routes/personal.ts');
    expect(source).toMatch(/if \(!scopes\.has\('workouts'\)\)[\s\S]{0,600}workedOut: false/);
  });
});

describe('C5 · cadastro público não confirma existência de conta por CPF', () => {
  it('a mensagem de conflito de CPF não cita CPF nem afirma cadastro', () => {
    // Qualquer regressão que volte a dizer "CPF ja cadastrado" reabre o oráculo
    // de enumeração num endpoint público e sem autenticação.
    const source = readSrc('../services/authService.ts');
    const block = source.slice(
      source.indexOf('function throwFriendlyUniqueError'),
      source.indexOf('export async function registerUser'),
    );
    expect(block).toContain("err.code = 'REGISTRATION_CONFLICT'");
    expect(block).not.toMatch(/throw new Error\('CPF ja cadastrado\.'\)/);
    // O e-mail continua específico de propósito: é a chave de identidade do
    // signup e o próprio dono o conhece — é o que permite oferecer "entre".
    expect(block).toContain("throw new Error('Email ja cadastrado.')");
  });

  it('as duas rotas de cadastro tratam o conflito genérico como 409', () => {
    const routes = readSrc('../routes/auth.ts');
    const occurrences = routes.split("code === 'REGISTRATION_CONFLICT' ? 409 : 400").length - 1;
    expect(occurrences).toBe(2); // /register e /register-personal
  });
});

describe('C4 · /api/health reporta a última migration de verdade', () => {
  it('desempata por id, não só por run_on', () => {
    // `run_on` tem granularidade de segundo e um deploy aplica várias migrations
    // no mesmo instante: sem o desempate a verificação pós-deploy mentia.
    expect(readSrc('../index.ts')).toContain('ORDER BY run_on DESC, id DESC LIMIT 1');
  });
});
