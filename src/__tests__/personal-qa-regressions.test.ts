/**
 * Regressões do QA ponta a ponta do módulo Personal (01/ago/2026).
 *
 * Cada bloco trava um defeito que chegou a produção e que passou por code
 * review — são regras de produto codificadas, não detalhes de implementação.
 * Ver plans/qa_modulo_personal_2026-08-01_1.md.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import {
  isOnboarding,
  computeEngagementScore,
  computeRiskScore,
  resolveMonthlyTarget,
  weeklyTargetFromPreset,
  daysSinceLastWorkout,
  computeRecognitionMilestones,
} from '../services/personalDashboardService';
import type { PersonalDashboardStudent } from '../shared/types/personal-dashboard';
import { sanitizeWorkoutPlanItem } from '../services/personalWorkoutPlanService';
import { readFileSync } from 'fs';
import { join } from 'path';

const DAY = 24 * 60 * 60 * 1000;
const agoDays = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const noSignals = {
  lastWorkoutISO: null,
  lastCheckinISO: null,
  workouts30d: 0,
  checkins7d: 0,
};

describe('P1-1 · carência de onboarding no motor de risco', () => {
  it('aluno atribuído agora, sem nenhum sinal, está em onboarding', () => {
    expect(isOnboarding({ ...noSignals, assignedAtISO: agoDays(0) })).toBe(true);
  });

  it('sai da carência após 7 dias sem sinal — aí a ausência é informação', () => {
    expect(isOnboarding({ ...noSignals, assignedAtISO: agoDays(8) })).toBe(false);
  });

  it('qualquer sinal encerra a carência, mesmo com vínculo recente', () => {
    expect(
      isOnboarding({ ...noSignals, assignedAtISO: agoDays(1), lastWorkoutISO: agoDays(1) })
    ).toBe(false);
    expect(isOnboarding({ ...noSignals, assignedAtISO: agoDays(1), checkins7d: 1 })).toBe(false);
  });

  it('sem data de atribuição NÃO concede carência (não dá para afirmar que é novo)', () => {
    expect(isOnboarding({ ...noSignals, assignedAtISO: null })).toBe(false);
  });

  it('em onboarding os scores são null — nunca 0/100', () => {
    const engagementScore = computeEngagementScore({
      adherencePct: 0,
      workouts7d: 0,
      streakDays: 0,
      checkins7d: 0,
      onboarding: true,
    });
    expect(engagementScore).toBeNull();

    // O bug original: engajamento 0 ⇒ risco 100 ⇒ aluno recém-cadastrado
    // abrindo a lista "Alunos em risco" no primeiro acesso do personal.
    expect(
      computeRiskScore({
        engagementScore,
        metabolismDelta7d: null,
        latestSleptWell: null,
        lastWorkoutISO: null,
        lastCheckinISO: null,
        assignedAtISO: agoDays(0),
      })
    ).toBeNull();
  });

  it('fora da carência, o aluno realmente inativo continua pontuando risco alto', () => {
    const engagementScore = computeEngagementScore({
      adherencePct: 0,
      workouts7d: 0,
      streakDays: 0,
      checkins7d: 0,
      onboarding: false,
    });
    expect(engagementScore).toBe(0);

    const risk = computeRiskScore({
      engagementScore,
      metabolismDelta7d: null,
      latestSleptWell: null,
      lastWorkoutISO: agoDays(30),
      lastCheckinISO: null,
      assignedAtISO: agoDays(60),
    });
    expect(risk).toBeGreaterThanOrEqual(55);
  });
});

describe('P1-2 · sentinela 999 não vaza para a copy', () => {
  it('daysSinceLastWorkout devolve null quando nunca houve treino', () => {
    expect(daysSinceLastWorkout(null)).toBeNull();
  });

  it('e o número real quando houve', () => {
    expect(daysSinceLastWorkout(agoDays(3))).toBe(3);
  });
});

describe('P1-3 · aderência mede a ficha prescrita, não o tier', () => {
  it('lê o week_preset do builder', () => {
    expect(weeklyTargetFromPreset('4')).toBe(4);
    expect(weeklyTargetFromPreset('6')).toBe(6);
    expect(weeklyTargetFromPreset('semana_util')).toBe(5);
  });

  it('ignora preset ausente ou absurdo', () => {
    expect(weeklyTargetFromPreset(null)).toBeNull();
    expect(weeklyTargetFromPreset('99')).toBeNull();
    expect(weeklyTargetFromPreset('lixo')).toBeNull();
  });

  it('a ficha manda: 4x/semana ≈ 17/mês, não os 6/mês do tier basic', () => {
    expect(resolveMonthlyTarget('basic', '4')).toBe(17);
    expect(resolveMonthlyTarget('basic', '6')).toBe(25);
  });

  it('sem ficha ativa, cai no alvo por tier', () => {
    expect(resolveMonthlyTarget('basic', null)).toBe(6);
    expect(resolveMonthlyTarget('black', null)).toBe(10);
  });

  it('o tier não infla mais o alvo de quem tem ficha — a prescrição prevalece', () => {
    expect(resolveMonthlyTarget('black', '4')).toBe(resolveMonthlyTarget('basic', '4'));
  });

  it('aluno com ficha 5x treinando 2x/sem não marca mais 100%', () => {
    const target = resolveMonthlyTarget('basic', '5'); // 21/mês
    const pct = Math.round((8 / target) * 100); // ~2x/semana
    expect(pct).toBeLessThan(50);
  });
});

describe('P2-2 · exerciseId só é aceito com formato de UUID v4', () => {
  const base = { name: 'Supino', sets: '4', reps: '10', rest: '60s' };

  it('rejeita id legado', () => {
    const r = sanitizeWorkoutPlanItem({ ...base, exerciseId: 'legacy:supino' });
    expect(r.ok).toBe(false);
  });

  it('rejeita item marcado legacy:true', () => {
    const r = sanitizeWorkoutPlanItem({
      ...base,
      exerciseId: '8fbe1b4e-1b0d-4a9e-9a3c-2b7f0d4e5a61',
      legacy: true,
    });
    expect(r.ok).toBe(false);
  });

  it('aceita UUID v4 bem-formado (existência é checada contra o banco no save)', () => {
    const r = sanitizeWorkoutPlanItem({
      ...base,
      exerciseId: '8fbe1b4e-1b0d-4a9e-9a3c-2b7f0d4e5a61',
    });
    expect(r.ok).toBe(true);
  });
});

describe('P0-2 · transições de revisão não podem reusar $3 sem cast', () => {
  /**
   * `SET status = $3` (varchar) + `CASE WHEN $3 IN (...)` (text) faz o Postgres
   * recusar a query inteira com "inconsistent types deduced for parameter $3" —
   * approve/request-changes/archive respondiam 500. Como a suíte roda com o DB
   * mockado, o guard possível é sobre o SQL emitido.
   */
  it('o UPDATE carrega casts explícitos nos dois usos de $3', () => {
    const src = readFileSync(
      join(__dirname, '../services/workoutReviewsService.ts'),
      'utf-8'
    );

    const update = src.slice(src.indexOf('UPDATE workout_reviews'));
    expect(update).toContain('status = $3::varchar');
    expect(update).toContain("$3::text IN ('approved', 'changes_requested')");
  });
});

describe('QA 04/set/2026 · reconhecimento exige janela mínima de histórico', () => {
  /**
   * `adherencePct` usa denominador proporcional ao vínculo com piso de 7 dias
   * (resolveMonthlyTarget) — um aluno de 1 dia de carteira com 1-2 treinos já
   * bate >=100% contra esse piso. Sem o gate abaixo, a Máquina de
   * Reconhecimento anunciava "meta do mês batida" no primeiro dia.
   */
  const baseStudent: PersonalDashboardStudent = {
    id: '1',
    name: 'Aluno Teste',
    plan: 'basic',
    workouts7d: 2,
    workouts30d: 2,
    streakDays: 2,
    lastWorkoutISO: agoDays(1),
    adherencePct: 100,
    adherenceScore: 100,
    engagementScore: 60,
    riskScore: 20,
    riskFactors: [],
    risk: 'ok',
    goal: 'hipertrofia',
    notes: null,
    engagementStatus: 'on_track',
    lastCheckinISO: agoDays(1),
    checkins7d: 2,
    metabolismScore: null,
    metabolismBand: 'unknown',
    metabolismTrend: 'unknown',
    metabolismDelta7d: null,
    latestSleptWell: null,
    lastTechnicalNoteAt: null,
    assignedAtISO: agoDays(1),
  };

  it('NÃO reconhece "meta batida" com 1 dia de vínculo e volume baixo', () => {
    const milestones = computeRecognitionMilestones([baseStudent], new Set());
    expect(milestones.find((m) => m.milestoneKey.startsWith('full_adherence'))).toBeUndefined();
  });

  it('reconhece quando o vínculo já tem 14+ dias, mesmo com poucos treinos no mês', () => {
    const veteran: PersonalDashboardStudent = {
      ...baseStudent,
      assignedAtISO: agoDays(20),
      workouts30d: 4,
    };
    const milestones = computeRecognitionMilestones([veteran], new Set());
    expect(milestones.find((m) => m.milestoneKey.startsWith('full_adherence'))).toBeDefined();
  });

  it('reconhece com vínculo recente SE o volume absoluto já é real (>=8 treinos/30d)', () => {
    const highVolume: PersonalDashboardStudent = {
      ...baseStudent,
      assignedAtISO: agoDays(1),
      workouts30d: 8,
    };
    const milestones = computeRecognitionMilestones([highVolume], new Set());
    expect(milestones.find((m) => m.milestoneKey.startsWith('full_adherence'))).toBeDefined();
  });
});
