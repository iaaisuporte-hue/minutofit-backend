import {
  calcEstimatedLoad,
  calcFatigueLevel,
  type WorkoutType,
} from '../services/postWorkoutService';

describe('calcEstimatedLoad', () => {
  it('applies sparring factor 1.2', () => {
    // 8 RPE × (60min/60) × 1.2 = 9.6
    expect(calcEstimatedLoad(8, 60, 'sparring')).toBeCloseTo(9.6);
  });

  it('applies competition factor 1.5', () => {
    // 8 × (90/60) × 1.5 = 18
    expect(calcEstimatedLoad(8, 90, 'competition')).toBeCloseTo(18);
  });

  it('applies technical factor 0.8', () => {
    // 5 × (60/60) × 0.8 = 4
    expect(calcEstimatedLoad(5, 60, 'technical')).toBeCloseTo(4);
  });

  it('applies physical factor 1.0', () => {
    // 6 × (120/60) × 1.0 = 12
    expect(calcEstimatedLoad(6, 120, 'physical')).toBeCloseTo(12);
  });

  it('applies other factor 1.0', () => {
    // 7 × (60/60) × 1.0 = 7
    expect(calcEstimatedLoad(7, 60, 'other')).toBeCloseTo(7);
  });

  it('clamps to 100 for extreme inputs', () => {
    // 10 × (480/60) × 1.5 = 120 → clamped to 100
    expect(calcEstimatedLoad(10, 480, 'competition')).toBe(100);
  });

  it('clamps to 0 for zero RPE edge case', () => {
    expect(calcEstimatedLoad(0, 60, 'sparring')).toBe(0);
  });
});

describe('calcFatigueLevel', () => {
  it('returns low for fatigue < 60', () => {
    expect(calcFatigueLevel(0)).toBe('low');
    expect(calcFatigueLevel(30)).toBe('low');
    expect(calcFatigueLevel(59.9)).toBe('low');
  });

  it('returns moderate for fatigue 60-79', () => {
    expect(calcFatigueLevel(60)).toBe('moderate');
    expect(calcFatigueLevel(70)).toBe('moderate');
    expect(calcFatigueLevel(79.9)).toBe('moderate');
  });

  it('returns high for fatigue >= 80', () => {
    expect(calcFatigueLevel(80)).toBe('high');
    expect(calcFatigueLevel(100)).toBe('high');
  });
});
