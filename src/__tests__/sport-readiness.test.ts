import { computeSportReadiness } from '../services/sportsEngine/readiness';
import type { SportConfig, PreWorkoutCheckinData } from '../types/sport';

const mockConfig: SportConfig = {
  key: 'jiu_jitsu',
  labelPt: 'Jiu-Jitsu',
  graduationOptions: ['branca', 'azul'],
  categoryOptions: ['-76kg'],
  factorWeights: {
    joint_soreness: 25,
    muscle_soreness: 15,
    stress_level: 10,
    motivation: 10,
    camp_proximity: 10,
    weekly_load_threshold: 5,
    weekly_load_penalty: 8,
  },
  microcopy: {
    readinessHigh: 'Condição ideal.',
    readinessModerate: 'Prefira técnica leve.',
    readinessLow: 'Priorize recuperação.',
  },
};

const goodCheckin: PreWorkoutCheckinData = {
  sleep_quality: 5,
  energy_level: 5,
  muscle_soreness: 1,
  joint_soreness: 1,
  stress_level: 1,
  hydration_ok: true,
  motivation: 5,
  perceived_readiness: 5,
};

const badCheckin: PreWorkoutCheckinData = {
  sleep_quality: 1,
  energy_level: 1,
  muscle_soreness: 5,
  joint_soreness: 5,
  stress_level: 5,
  hydration_ok: false,
  motivation: 1,
  perceived_readiness: 1,
};

describe('computeSportReadiness', () => {
  it('returns low risk and positive recommendation for all-positive signals', () => {
    const result = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: goodCheckin,
      weeklyLoadCount: 3,
      campDaysRemaining: null,
    });
    expect(result.risk_level).toBe('low');
    expect(result.modifier).toBeGreaterThanOrEqual(0);
    expect(result.recommendation).toBe(mockConfig.microcopy.readinessHigh);
  });

  it('returns high risk when joint soreness is max', () => {
    const result = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: badCheckin,
      weeklyLoadCount: 0,
      campDaysRemaining: null,
    });
    expect(result.risk_level).toBe('high');
    expect(result.modifier).toBeLessThanOrEqual(-30);
    expect(result.factors.some((f) => f.id === 'joint_soreness')).toBe(true);
  });

  it('applies camp proximity boost when camp is within 21 days', () => {
    const nocamp = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: goodCheckin,
      weeklyLoadCount: 3,
      campDaysRemaining: null,
    });
    const withcamp = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: goodCheckin,
      weeklyLoadCount: 3,
      campDaysRemaining: 14,
    });
    expect(withcamp.modifier).toBeGreaterThan(nocamp.modifier);
    expect(withcamp.factors.some((f) => f.id === 'camp_proximity')).toBe(true);
  });

  it('clamps modifier to [-60, +40]', () => {
    const veryBad = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: badCheckin,
      weeklyLoadCount: 10,
      campDaysRemaining: null,
    });
    expect(veryBad.modifier).toBeGreaterThanOrEqual(-60);

    const veryGood = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: goodCheckin,
      weeklyLoadCount: 3,
      campDaysRemaining: 14,
    });
    expect(veryGood.modifier).toBeLessThanOrEqual(40);
  });

  it('penalizes dehydration', () => {
    const hydrated = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: { ...goodCheckin, hydration_ok: true },
      weeklyLoadCount: 3,
      campDaysRemaining: null,
    });
    const dehydrated = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: { ...goodCheckin, hydration_ok: false },
      weeklyLoadCount: 3,
      campDaysRemaining: null,
    });
    expect(dehydrated.modifier).toBeLessThan(hydrated.modifier);
    expect(dehydrated.factors.some((f) => f.id === 'hydration')).toBe(true);
  });

  it('penalizes high weekly load (> 5 sessions)', () => {
    const result = computeSportReadiness({
      sportConfig: mockConfig,
      checkin: goodCheckin,
      weeklyLoadCount: 6,
      campDaysRemaining: null,
    });
    expect(result.factors.some((f) => f.id === 'weekly_load' && f.delta < 0)).toBe(true);
  });
});
