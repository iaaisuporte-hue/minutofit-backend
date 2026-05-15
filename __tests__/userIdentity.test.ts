/**
 * Smoke tests for userIdentityService — dedup by email/cpf/phone.
 *
 * These tests use jest mocks for `pool` to avoid real DB connections.
 * Run with: npm test -- --testPathPattern=userIdentity
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

const mockPool = pool as jest.Mocked<typeof pool>;

const mockUser = {
  id: 42,
  email: 'joao@example.com',
  role: 'user',
  name: 'João Silva',
  cpf: '12345678909',
  phone: '11987654321',
  profile_completed: false,
  has_password: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findUserByIdentity', () => {
  test('matches by email (highest priority)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [mockUser] }); // email match

    const result = await findUserByIdentity({ email: 'joao@example.com', cpf: '99999999999' });
    expect(result).not.toBeNull();
    expect(result!.matchedBy).toBe('email');
    expect(result!.user.id).toBe(42);
    // Should only query email — not CPF
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('falls through to cpf when email not found', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })     // email miss
      .mockResolvedValueOnce({ rows: [mockUser] }); // cpf match

    const result = await findUserByIdentity({ email: 'unknown@example.com', cpf: '12345678909' });
    expect(result).not.toBeNull();
    expect(result!.matchedBy).toBe('cpf');
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('falls through to phone when email and cpf not found', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })     // email miss
      .mockResolvedValueOnce({ rows: [] })     // cpf miss
      .mockResolvedValueOnce({ rows: [mockUser] }); // phone match (exactly 1)

    const result = await findUserByIdentity({ phone: '11987654321' });
    expect(result).not.toBeNull();
    expect(result!.matchedBy).toBe('phone');
  });

  test('returns null when phone is ambiguous (multiple results)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [mockUser, { ...mockUser, id: 99 }] }); // 2 results

    const result = await findUserByIdentity({ phone: '11987654321' });
    expect(result).toBeNull();
  });

  test('returns null when nothing matches', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await findUserByIdentity({ email: 'nobody@example.com', cpf: '99999999999', phone: '00000000000' });
    expect(result).toBeNull();
  });

  test('ignores invalid CPF (skips cpf query)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }); // only email query runs

    const result = await findUserByIdentity({ email: 'x@example.com', cpf: '00000000000' }); // invalid cpf
    expect(result).toBeNull();
    // 1 query for email; CPF skipped because invalid; phone not provided
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

describe('findOrCreateUserFromContext', () => {
  test('returns existing user with isNew=false when email found', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [mockUser] }); // email match in findUserByIdentity

    const result = await findOrCreateUserFromContext({
      email: 'joao@example.com',
      name: 'João Silva',
      password: 'SenhaForte@123',
    });

    expect(result.isNew).toBe(false);
    expect(result.matchedBy).toBe('email');
    expect(result.user.id).toBe(42);
  });

  test('creates new user with isNew=true when no match found', async () => {
    const newUser = { ...mockUser, id: 99, email: 'new@example.com' };
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })     // email miss
      .mockResolvedValueOnce({ rows: [] })     // cpf miss
      .mockResolvedValueOnce({ rows: [newUser] }); // INSERT RETURNING

    const result = await findOrCreateUserFromContext({
      email: 'new@example.com',
      name: 'Novo Usuário',
      password: 'SenhaForte@123',
    });

    expect(result.isNew).toBe(true);
    expect(result.matchedBy).toBe('none');
    expect(result.user.id).toBe(99);
  });

  test('throws when password missing for new user', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // email miss
      .mockResolvedValueOnce({ rows: [] }); // cpf miss

    await expect(
      findOrCreateUserFromContext({ email: 'new@example.com', name: 'Test' })
    ).rejects.toThrow('Senha obrigatória');
  });
});
