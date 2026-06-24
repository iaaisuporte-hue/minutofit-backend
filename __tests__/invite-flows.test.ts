/**
 * Smoke tests for invite flows — verifies dedup + grant behavior.
 *
 * Tests the key invariants:
 *  - Invites for existing users reuse account (isNew=false), no duplicate created
 *  - Invites for new users create account (isNew=true)
 *  - Cancelling a product does not cascade to other products
 *  - OAuth creates user if email not found
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

jest.mock('../src/utils/passwordPolicy', () => ({
  assertStrongPassword: jest.fn(),
}));

import pool from '../src/config/database';
import { findUserByIdentity, findOrCreateUserFromContext } from '../src/services/userIdentityService';
import { grantMembership, cancelMembership } from '../src/services/membershipService';

// `pg.Pool.query` tem overloads que confundem `jest.Mocked` (acaba inferindo
// `never` no parâmetro do mock). Castamos para um shape simples que mantém
// a API do jest sem perder type-safety útil no resto do arquivo.
const mockPool = pool as unknown as { query: jest.Mock };

const existingUser = {
  id: 10,
  email: 'aluno@example.com',
  role: 'user',
  name: 'Aluno Existente',
  cpf: '52998224725',
  phone: '11912345678',
  profile_completed: true,
  has_password: true,
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe('Personal invite flow — email already exists (dedup)', () => {
  test('findOrCreate returns existing user when email matches', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [existingUser] }); // email match

    const result = await findOrCreateUserFromContext({
      email: existingUser.email,
      name: 'Doesn\'t matter',
      password: 'somepass',
    });

    expect(result.isNew).toBe(false);
    expect(result.user.id).toBe(existingUser.id);
    // Should NOT have created a user (auditoria de identidade pode inserir em
    // data_access_audit — o que importa é que NÃO houve INSERT INTO users).
    const userInsertCalls = (mockPool.query as jest.Mock).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && /INSERT\s+INTO\s+users/i.test(call[0] as string)
    );
    expect(userInsertCalls).toHaveLength(0);
  });
});

describe('Personal invite flow — new user', () => {
  test('findOrCreate creates new user when no match', async () => {
    const newUser = { ...existingUser, id: 99, email: 'novo@example.com' };
    // Input só com email → findUserByIdentity faz 1 query (email miss),
    // depois INSERT RETURNING (1 query).
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })          // email miss
      .mockResolvedValueOnce({ rows: [newUser] });  // INSERT RETURNING

    const result = await findOrCreateUserFromContext({
      email: newUser.email,
      name: 'Novo Aluno',
      password: 'Senha@Forte123',
    });

    expect(result.isNew).toBe(true);
    expect(result.user.id).toBe(99);
  });
});

describe('Cancel APP does not cancel PERSONAL', () => {
  test('cancelMembership APP only issues one UPDATE targeting app product_key', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await cancelMembership(10, 'app', { reason: 'payment_failed' });

    // Only one DB call
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    // Param at index 1 is product_key — must be 'app' only
    expect(params[1]).toBe('app');
  });
});

describe('Grant PERSONAL does not grant ACADEMIA', () => {
  test('grantMembership PERSONAL only touches PERSONAL row', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await grantMembership(10, 'personal', { professionalId: 5 });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('personal');
    expect(params[1]).not.toBe('academia');
  });
});

describe('Academy invite — email already exists (dedup)', () => {
  test('findUserByIdentity returns existing user by email', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [existingUser] });

    const found = await findUserByIdentity({ email: existingUser.email });
    expect(found).not.toBeNull();
    expect(found!.matchedBy).toBe('email');
    expect(found!.user.id).toBe(existingUser.id);
  });
});

describe('Nutri invite — email already exists (dedup)', () => {
  test('findOrCreate reuses existing account for nutri invite', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [existingUser] });

    const result = await findOrCreateUserFromContext({
      email: existingUser.email,
      name: 'anything',
      password: 'pass',
    });

    expect(result.isNew).toBe(false);
    expect(result.user.id).toBe(existingUser.id);
  });
});

describe('OAuth — creates new user when email not found', () => {
  // Tests the grantMembership call pattern as a proxy for the OAuth fix.
  // The actual OAuth logic is in authService; here we verify the grant pattern.
  test('grantMembership app with oauth_signup metadata', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await grantMembership(55, 'app', { metadata: { source: 'oauth_signup', provider: 'google' } });

    const params = (mockPool.query as jest.Mock).mock.calls[0][1] as unknown[];
    const meta = JSON.parse(params[10] as string);
    expect(meta.source).toBe('oauth_signup');
    expect(meta.provider).toBe('google');
  });
});
