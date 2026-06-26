/**
 * Spec 015 — gate Free/Pro do plano SaaS da academia (sem atingir DB).
 * Cobre os critérios de aceite 1 e 2: sem Pro → inteligência travada;
 * só honra Pro quando a assinatura está active/trial.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));

import pool from '../config/database';
import { getAcademySubscription } from '../services/academySubscriptionService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    plan: 'pro',
    status: 'active',
    intelligence_enabled: true,
    student_cap: null,
    current_period_end: null,
    trial_until: null,
    ...over,
  };
}

beforeEach(() => mockedQuery.mockReset());

describe('getAcademySubscription — gate Free/Pro', () => {
  it('sem linha → Free (inteligência travada)', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const sub = await getAcademySubscription(1);
    expect(sub.plan).toBe('free');
    expect(sub.intelligenceEnabled).toBe(false);
  });

  it("status 'pending' (checkout aberto, ainda não pagou) → Free", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'pending' })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.plan).toBe('free');
    expect(sub.intelligenceEnabled).toBe(false);
  });

  it("status 'active' + intelligence_enabled → Pro (inteligência liberada)", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'active' })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.plan).toBe('pro');
    expect(sub.intelligenceEnabled).toBe(true);
  });

  it("status 'trial' → Pro (honra durante trial)", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'trial' })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.intelligenceEnabled).toBe(true);
  });

  it("status 'cancelled' → Free (volta a travar)", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'cancelled' })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.intelligenceEnabled).toBe(false);
  });
});
