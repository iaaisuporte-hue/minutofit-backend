/**
 * Smoke tests for membershipService — grant/pause/cancel invariants.
 *
 * Invariant: operations on product X never affect product Y for the same user.
 */

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../src/lib/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import pool from '../src/config/database';
import { grantMembership, cancelMembership, pauseMembership, getActiveMemberships } from '../src/services/membershipService';

// `pg.Pool.query` tem overloads que confundem `jest.Mocked` (parâmetro vira `never`).
const mockPool = pool as unknown as { query: jest.Mock };

beforeEach(() => {
  jest.resetAllMocks();
});

describe('grantMembership', () => {
  test('executes UPSERT with correct product_key', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await grantMembership(1, 'app', { metadata: { source: 'self_signup' } });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const sql = (mockPool.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('user_product_memberships');
    expect(sql).toContain('ON CONFLICT');
    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('app'); // product_key
  });

  test('grant APP does not mention PERSONAL or ACADEMIA product_key', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await grantMembership(1, 'app');

    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('app');
    // product_key param is index 1; should never be 'personal' or 'academia' in this call
    expect(params[1]).not.toBe('personal');
    expect(params[1]).not.toBe('academia');
  });
});

describe('cancelMembership', () => {
  test('only cancels the specified product_key', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await cancelMembership(1, 'app', { revokedByUserId: 99, reason: 'test' });

    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(1);    // user_id
    expect(params[1]).toBe('app'); // product_key — only APP is cancelled
  });

  test('returns false when no active membership found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await cancelMembership(1, 'personal');
    expect(result).toBe(false);
  });

  test('only touches own product + App-bonus grace hook (no cascade to siblings)', async () => {
    // Cancelar Academia/Personal/Nutri dispara `enterGraceForAppBonus` →
    // 2 queries esperadas: (1) UPDATE para cancelar; (2) UPDATE no App como
    // bônus para período de graça. NUNCA cancela o App nem outros produtos.
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // cancel academia
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // enterGraceForAppBonus

    await cancelMembership(5, 'academia');

    expect(mockPool.query).toHaveBeenCalledTimes(2);

    const calls = (mockPool.query as jest.Mock).mock.calls;
    const sql0 = calls[0][0] as string;
    expect(sql0).toContain('UPDATE user_product_memberships');
    expect(sql0).toContain("status             = 'cancelled'");

    const sql1 = calls[1][0] as string;
    expect(sql1).toContain('UPDATE user_product_memberships');
    expect(sql1).toContain("source                = 'grace_period'");
    // O hook só ESTENDE acesso ao App — NUNCA cancela o App nem outros produtos.
    expect(sql1).not.toContain("status = 'cancelled'");
  });
});

describe('pauseMembership', () => {
  test('sets status to paused for the specified product only', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await pauseMembership(2, 'nutri');
    expect(result).toBe(true);

    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('nutri');
  });
});

describe('getActiveMemberships', () => {
  test('returns rows from user_product_memberships', async () => {
    const rows = [
      { product_key: 'app', status: 'active', source: 'corefit', granted_at: new Date().toISOString(), expires_at: null, ended_at: null, academy_id: null, professional_id: null, plan_id: null, metadata: {} },
      { product_key: 'personal', status: 'active', source: 'corefit', granted_at: new Date().toISOString(), expires_at: null, ended_at: null, academy_id: null, professional_id: 7, plan_id: null, metadata: {} },
    ];
    mockPool.query.mockResolvedValueOnce({ rows });

    const memberships = await getActiveMemberships(3);
    expect(memberships).toHaveLength(2);
    expect(memberships[0].product_key).toBe('app');
    expect(memberships[1].product_key).toBe('personal');
  });

  test('returns empty array on DB error (defensive)', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('DB error'));

    const memberships = await getActiveMemberships(3);
    expect(memberships).toEqual([]);
  });
});
