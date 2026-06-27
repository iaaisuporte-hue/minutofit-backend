/**
 * Spec 015 — gate Free/Pro do plano SaaS da academia (sem atingir DB).
 * Cobre os critérios de aceite 1 e 2: sem Pro → inteligência travada;
 * só honra Pro quando a assinatura está active/trial.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn(), connect: jest.fn() } }));

import pool from '../config/database';
import { getAcademySubscription, expireOverdueAcademySubs } from '../services/academySubscriptionService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;
const mockedConnect = (pool as unknown as { connect: jest.Mock }).connect;

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

describe('getAcademySubscription — pastDue (Spec 018)', () => {
  it('active com vencimento futuro → pastDue false, Pro on', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'active', current_period_end: future })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.intelligenceEnabled).toBe(true);
    expect(sub.pastDue).toBe(false);
  });

  it('active vencida (dentro da graça) → pastDue true, Pro ainda on', async () => {
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'active', current_period_end: past })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.intelligenceEnabled).toBe(true);
    expect(sub.pastDue).toBe(true);
  });

  it('trial vencida → pastDue true', async () => {
    const past = new Date(Date.now() - 1 * 86400000).toISOString();
    mockedQuery.mockResolvedValueOnce({ rows: [row({ status: 'trial', trial_until: past })], rowCount: 1 });
    const sub = await getAcademySubscription(1);
    expect(sub.pastDue).toBe(true);
  });
});

describe('expireOverdueAcademySubs — auto-expire (Spec 018)', () => {
  it('expira vencidas além da graça, audita auto_expired e retorna contagens', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({})                                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ c: 3 }] })                                // evaluated
      .mockResolvedValueOnce({ rows: [{ academy_id: 7, mp_preapproval_id: null }], rowCount: 1 }) // UPDATE RETURNING
      .mockResolvedValueOnce({})                                                  // INSERT billing event
      .mockResolvedValueOnce({});                                                 // COMMIT
    const release = jest.fn();
    mockedConnect.mockResolvedValueOnce({ query: clientQuery, release });

    const result = await expireOverdueAcademySubs();

    expect(result).toEqual({ evaluated: 3, expired: 1 });
    // candidatas só active/trial → idempotência estrutural (expired não re-entra)
    const updSql = clientQuery.mock.calls[2][0];
    expect(updSql).toContain("status IN ('active','trial')");
    expect(updSql).toContain('make_interval');
    // auditoria do auto_expired
    const insSql = clientQuery.mock.calls[3][0];
    expect(insSql).toContain('auto_expired');
    expect(release).toHaveBeenCalled();
  });
});
