import { deriveIntakeSignal, type DayAgg, type IntakeTarget } from '../services/nutritionIntake';
import { shiftDayKey } from '../utils/appDay';

const TODAY = '2026-09-16';
const TARGET: IntakeTarget = { energyKcal: 2100, proteinG: 150, carbohydrateG: 210, fatG: 70, mealsPerDay: 4, source: 'plan_items' };

/** Dia de alta cobertura por padrão: 4 refeições registradas, confiança 1.0, no target. */
function day(daysAgo: number, opts: Partial<DayAgg> = {}): DayAgg {
  return {
    dateKey: shiftDayKey(TODAY, -daysAgo),
    loggedMeals: opts.loggedMeals ?? 4,
    totalKcal: opts.totalKcal ?? 2100,
    weightedConfidence: opts.weightedConfidence ?? 1,
    proteinG: opts.proteinG ?? 150,
    carbohydrateG: opts.carbohydrateG ?? 210,
    fatG: opts.fatG ?? 70,
  };
}

describe('deriveIntakeSignal', () => {
  it('sem logs (persona E): state none, sem meta, sem exceção', () => {
    const result = deriveIntakeSignal({ days: [], todayKey: TODAY, target: null });
    expect(result.state).toBe('none');
    expect(result.target).toBeNull();
    expect(result.exception).toBeNull();
  });

  it('sem meta resolvida: insufficient mesmo com dias de alta cobertura de log (sem meta pra comparar)', () => {
    const days = Array.from({ length: 7 }, (_, i) => day(i));
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: null });
    expect(result.state).toBe('insufficient');
    expect(result.exception).toBeNull();
  });

  it('persona A — 7/7 dias de alta cobertura a ~100%: ready, sem exceção', () => {
    const days = Array.from({ length: 7 }, (_, i) => day(i, { totalKcal: 2050, proteinG: 148 }));
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.state).toBe('ready');
    expect(result.highCoverageDays7d).toBe(7);
    expect(result.exception).toBeNull();
  });

  it('persona B — proteína cai para 60% da meta em >=4 dos últimos 5 dias de alta cobertura: intake_protein_low', () => {
    const days = [
      day(0, { proteinG: 90 }), day(1, { proteinG: 90 }), day(2, { proteinG: 90 }), day(3, { proteinG: 90 }),
      day(4, { proteinG: 150 }),
    ];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.exception?.type).toBe('intake_protein_low');
  });

  it('proteína baixa em só 3 dias (abaixo do limiar de 4) não dispara', () => {
    const days = [
      day(0, { proteinG: 90 }), day(1, { proteinG: 90 }), day(2, { proteinG: 90 }),
      day(3, { proteinG: 150 }), day(4, { proteinG: 150 }),
    ];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.exception).toBeNull();
  });

  it('dias de cobertura PARCIAL nunca contam como "proteína baixa" (persona D)', () => {
    // 2 dias de alta cobertura (0 e 1) + 4 dias de cobertura baixa/parcial com proteína baixa —
    // não devem alimentar a regra porque só 2 dias de alta cobertura existem (< 4 exigidos).
    const days = [
      day(0), day(1),
      day(2, { loggedMeals: 1, totalKcal: 300, proteinG: 20 }),
      day(3, { loggedMeals: 1, totalKcal: 300, proteinG: 20 }),
      day(4, { loggedMeals: 1, totalKcal: 300, proteinG: 20 }),
      day(5, { loggedMeals: 2, weightedConfidence: 0.7, totalKcal: 1000, proteinG: 60 }),
    ];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.state).toBe('insufficient');
    expect(result.highCoverageDays7d).toBe(2);
    expect(result.daysLogged7d).toBe(6);
    expect(result.exception).toBeNull();
  });

  it('persona C — só 2 dias registrados: insufficient, sem exceção (nunca dispara pra quem quase não usa)', () => {
    const days = [day(0), day(1)];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.state).toBe('insufficient');
    expect(result.exception).toBeNull();
  });

  it('persona F — queda de kcal: média 7d = 60% da média dos 7 anteriores, ambas >=4 dias de alta cobertura', () => {
    const recent = Array.from({ length: 4 }, (_, i) => day(i, { totalKcal: 1260 }));
    const previous = Array.from({ length: 4 }, (_, i) => day(i + 7, { totalKcal: 2100 }));
    const result = deriveIntakeSignal({ days: [...recent, ...previous], todayKey: TODAY, target: TARGET });
    expect(result.exception?.type).toBe('intake_kcal_drop');
    expect(result.kcalTrend).toBe('down');
  });

  it('persona G — silêncio pós-uso: >=4 logs em d-14..d-6, 0 nos últimos 5 dias', () => {
    const days = [day(6), day(8), day(10), day(12)];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET });
    expect(result.exception?.type).toBe('intake_silent');
  });

  it('persona E-like — nunca usou o produto: silêncio NUNCA dispara (nada em d-14..d-6)', () => {
    const result = deriveIntakeSignal({ days: [], todayKey: TODAY, target: TARGET });
    expect(result.exception).toBeNull();
  });

  it('intake_over: kcal >= 120% da meta em >=5 dos 7 dias registrados, objetivo != ganho', () => {
    const days = Array.from({ length: 5 }, (_, i) => day(i, { totalKcal: 2600 }));
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET, objective: 'weight_loss' });
    expect(result.exception?.type).toBe('intake_over');
  });

  it('intake_over NUNCA dispara para objetivo de ganho de massa', () => {
    const days = Array.from({ length: 5 }, (_, i) => day(i, { totalKcal: 2600 }));
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: TARGET, objective: 'muscle_gain' });
    expect(result.exception).toBeNull();
  });

  it('persona H — meta é estimativa própria (não plano): sinais disparam igual, selo correto', () => {
    const selfTarget: IntakeTarget = { ...TARGET, source: 'self_estimate' };
    const days = [
      day(0, { proteinG: 90 }), day(1, { proteinG: 90 }), day(2, { proteinG: 90 }), day(3, { proteinG: 90 }),
    ];
    const result = deriveIntakeSignal({ days, todayKey: TODAY, target: selfTarget });
    expect(result.exception?.type).toBe('intake_protein_low');
    expect(result.target?.source).toBe('self_estimate');
  });

  it('severidade: kcal_drop vence protein_low quando os dois disparariam', () => {
    const recent = Array.from({ length: 4 }, (_, i) => day(i, { totalKcal: 1260, proteinG: 90 }));
    const previous = Array.from({ length: 4 }, (_, i) => day(i + 7, { totalKcal: 2100 }));
    const result = deriveIntakeSignal({ days: [...recent, ...previous], todayKey: TODAY, target: TARGET });
    expect(result.exception?.type).toBe('intake_kcal_drop');
  });

  it('máximo 1 exceção devolvida por chamada (o teto de 2 é responsabilidade do consumidor)', () => {
    const recent = Array.from({ length: 4 }, (_, i) => day(i, { totalKcal: 1260, proteinG: 90 }));
    const previous = Array.from({ length: 4 }, (_, i) => day(i + 7, { totalKcal: 2100 }));
    const result = deriveIntakeSignal({ days: [...recent, ...previous], todayKey: TODAY, target: TARGET });
    expect(result.exception).not.toBeNull();
    // PatientIntakeSummary.exception é um único objeto, não array — a
    // asserção de tipo já garante o teto; isto documenta a intenção.
  });
});
