/**
 * Sinal financeiro no motor de risco (Onda F3).
 *
 * Duas regras de produto vivem aqui, e nenhuma delas é detalhe de
 * implementação: (1) atraso de pagamento pesa no risco em DEGRAU — atraso não é
 * dose, 20 dias não valem mais que 15; (2) nenhum risco é exibido sem motivo
 * legível ao lado, e o motivo financeiro nunca carrega valor em reais.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import {
  buildIntelligentAlerts,
  buildRiskFactors,
  computeRiskScore,
  type OverdueStudent,
  type RiskSignals,
} from '../services/personalDashboardService';
import type { PersonalDashboardStudent } from '../shared/types/personal-dashboard';

const DAY = 24 * 60 * 60 * 1000;
const agoDays = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** Aluno ativo e regular: sem os outros termos, o risco vem só do engajamento. */
const saudavel: RiskSignals = {
  engagementScore: 70,
  metabolismDelta7d: null,
  latestSleptWell: null,
  lastWorkoutISO: agoDays(1),
  lastCheckinISO: agoDays(1),
  assignedAtISO: agoDays(120),
};

describe('F3 · atraso de pagamento no computeRiskScore', () => {
  it('sem o sinal, o cálculo é o mesmo de antes do módulo Financeiro existir', () => {
    const semCampo = computeRiskScore(saudavel);
    expect(semCampo).toBe(30);
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: null })).toBe(semCampo);
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 0 })).toBe(semCampo);
  });

  it('atraso de 1 a 2 dias não move o risco — é esquecimento, não inadimplência', () => {
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 2 })).toBe(30);
  });

  it('a partir de 3 dias soma 10', () => {
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 3 })).toBe(40);
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 14 })).toBe(40);
  });

  it('a partir de 15 dias soma 15 — e não 25: é degrau, não soma', () => {
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 15 })).toBe(45);
    expect(computeRiskScore({ ...saudavel, paymentOverdueDays: 90 })).toBe(45);
  });

  it('o clamp de 0–100 continua valendo com o termo novo', () => {
    expect(
      computeRiskScore({
        engagementScore: 0,
        metabolismDelta7d: -40,
        latestSleptWell: false,
        lastWorkoutISO: agoDays(60),
        lastCheckinISO: agoDays(60),
        assignedAtISO: agoDays(200),
        paymentOverdueDays: 60,
      })
    ).toBe(100);
  });

  it('aluno em onboarding segue sem score, mesmo devendo', () => {
    expect(
      computeRiskScore({
        engagementScore: null,
        metabolismDelta7d: null,
        latestSleptWell: null,
        lastWorkoutISO: null,
        lastCheckinISO: null,
        assignedAtISO: agoDays(1),
        paymentOverdueDays: 30,
      })
    ).toBeNull();
  });
});

describe('F3 · riskFactors explicam o número', () => {
  it('o atraso vira motivo legível, sem valor em reais', () => {
    const factors = buildRiskFactors({ ...saudavel, paymentOverdueDays: 12 });
    const labels = factors.map((f) => f.label);
    expect(labels).toContain('pagamento vencido há 12 dias');
    expect(labels.join(' ')).not.toMatch(/R\$|cents|centavos/i);
  });

  it('o fator financeiro não depende de consent de saúde — scope null', () => {
    const financeiro = buildRiskFactors({ ...saudavel, paymentOverdueDays: 12 }).find((f) =>
      f.label.startsWith('pagamento vencido')
    );
    expect(financeiro?.scope).toBeNull();
  });

  it('mesmo corte do score: 2 dias de atraso não viram motivo', () => {
    const labels = buildRiskFactors({ ...saudavel, paymentOverdueDays: 2 }).map((f) => f.label);
    expect(labels.some((l) => l.startsWith('pagamento vencido'))).toBe(false);
  });

  it('cada termo que somou aparece uma vez, com o escopo que o sustenta', () => {
    const factors = buildRiskFactors({
      engagementScore: 20,
      metabolismDelta7d: -18,
      latestSleptWell: false,
      lastWorkoutISO: agoDays(12),
      lastCheckinISO: agoDays(12),
      assignedAtISO: agoDays(90),
      paymentOverdueDays: 20,
    });
    expect(factors).toEqual([
      { scope: null, label: 'engajamento baixo (20/100)' },
      { scope: 'metabolic', label: 'score metabólico caiu 18 pontos em 7 dias' },
      { scope: 'sleep', label: 'sono ruim no último check-in' },
      { scope: 'workouts', label: 'sem contato há 12 dias' },
      { scope: null, label: 'pagamento vencido há 20 dias' },
    ]);
  });

  it('o sentinela de "nunca aconteceu" não vira número em copy', () => {
    const labels = buildRiskFactors({
      engagementScore: 0,
      metabolismDelta7d: null,
      latestSleptWell: null,
      lastWorkoutISO: null,
      lastCheckinISO: null,
      assignedAtISO: null,
    }).map((f) => f.label);
    expect(labels).toContain('sem treino nem check-in registrado');
    expect(labels.join(' ')).not.toContain('999');
  });

  it('sem risco apurável não há o que explicar', () => {
    expect(buildRiskFactors({ ...saudavel, engagementScore: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Alerta no "Precisa da sua atenção"
// ---------------------------------------------------------------------------

function aluno(overrides: Partial<PersonalDashboardStudent> = {}): PersonalDashboardStudent {
  return {
    id: '1',
    name: 'Aluno',
    plan: 'basic',
    workouts7d: 3,
    workouts30d: 12,
    streakDays: 4,
    lastWorkoutISO: agoDays(1),
    adherencePct: 80,
    adherenceScore: 80,
    engagementScore: 70,
    riskScore: 30,
    riskFactors: [],
    risk: 'ok',
    goal: 'emagrecimento',
    notes: null,
    engagementStatus: 'on_track',
    lastCheckinISO: agoDays(1),
    checkins7d: 4,
    metabolismScore: 70,
    metabolismBand: 'high',
    metabolismTrend: 'stable',
    metabolismDelta7d: null,
    latestSleptWell: true,
    lastTechnicalNoteAt: null,
    assignedAtISO: agoDays(90),
    ...overrides,
  };
}

const vencidos: OverdueStudent[] = [
  { id: '7', name: 'João', days: 12 },
  { id: '8', name: 'Maria', days: 5 },
  { id: '9', name: 'Ana', days: 4 },
];

describe('F3 · alerta payment_overdue', () => {
  it('não existe alerta quando ninguém está vencido', () => {
    const alerts = buildIntelligentAlerts([aluno()], []);
    expect(alerts.some((a) => a.type === 'payment_overdue')).toBe(false);
  });

  it('agrega os vencidos num card só, apontando para o Financeiro', () => {
    const alerta = buildIntelligentAlerts([aluno()], vencidos).find(
      (a) => a.type === 'payment_overdue'
    );
    expect(alerta).toBeDefined();
    expect(alerta!.title).toBe('3 alunos com pagamento vencido');
    expect(alerta!.actionHref).toBe('/app/personal/finance');
    // Agregado não nomeia aluno: o CTA leva à lista, não à ficha de um deles.
    expect(alerta!.studentId).toBeNull();
  });

  it('com um único vencido, nomeia o aluno e mostra o atraso', () => {
    const alerta = buildIntelligentAlerts([aluno()], [vencidos[0]]).find(
      (a) => a.type === 'payment_overdue'
    );
    expect(alerta!.title).toBe('João com pagamento vencido há 12 dias');
    expect(alerta!.studentId).toBe('7');
  });

  it('nenhum alerta financeiro carrega valor em reais', () => {
    const alerta = buildIntelligentAlerts([aluno()], vencidos).find(
      (a) => a.type === 'payment_overdue'
    )!;
    expect(`${alerta.title} ${alerta.description}`).not.toMatch(/R\$/);
  });

  it('o teto de 6 alertas continua valendo', () => {
    // Carteira que dispara todos os sinais de uma vez.
    const carteira = [
      aluno({ id: '1', name: 'A', engagementStatus: 'at_risk', latestSleptWell: false, adherencePct: 100, workouts7d: 6, metabolismScore: 40, metabolismDelta7d: -20, lastWorkoutISO: agoDays(9), lastCheckinISO: agoDays(9) }),
      aluno({ id: '2', name: 'B', engagementStatus: 'fading', latestSleptWell: false, adherencePct: 100, workouts7d: 6, metabolismScore: 40, metabolismDelta7d: -20, lastWorkoutISO: agoDays(8), lastCheckinISO: agoDays(8) }),
      aluno({ id: '3', name: 'C', engagementStatus: 'attention', latestSleptWell: false, adherencePct: 100, workouts7d: 6, metabolismScore: 40, metabolismDelta7d: -20, lastWorkoutISO: agoDays(7), lastCheckinISO: agoDays(7) }),
    ];
    expect(buildIntelligentAlerts(carteira, vencidos)).toHaveLength(6);
  });
});
