/**
 * Spec 027 — reset de senha: invariantes de segurança do service, sem tocar DB.
 * - token guardado só como SHA-256 (nunca cru)
 * - token não encontrado/expirado/usado → InvalidResetTokenError
 * - senha fraca é rejeitada ANTES de abrir conexão
 * - findResettableUserByEmail ignora OAuth-only (password IS NULL fica na query)
 */
import crypto from 'crypto';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

import pool from '../config/database';
import {
  createResetToken,
  resetPasswordWithToken,
  findResettableUserByEmail,
  InvalidResetTokenError,
} from '../services/passwordResetService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;
const mockedConnect = (pool as unknown as { connect: jest.Mock }).connect;

function fakeClient(queryImpl: (sql: string) => { rows: unknown[] }) {
  return {
    query: jest.fn(async (sql: string, _params?: unknown[]) => queryImpl(sql)),
    release: jest.fn(),
  };
}

beforeEach(() => {
  mockedQuery.mockReset();
  mockedConnect.mockReset();
});

describe('createResetToken', () => {
  it('devolve token cru e persiste só o SHA-256 dele', async () => {
    const client = fakeClient(() => ({ rows: [] }));
    mockedConnect.mockResolvedValueOnce(client);

    const token = await createResetToken(42, '1.2.3.4');

    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    const insertCall = client.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO password_reset_tokens'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // params: [userId, tokenHash, ttlMinutes, ip]
    expect(params[0]).toBe(42);
    expect(params[1]).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(params[1]).not.toBe(token); // nunca o cru
  });
});

describe('resetPasswordWithToken', () => {
  it('token inexistente/expirado/usado → InvalidResetTokenError', async () => {
    const client = fakeClient((sql) =>
      sql.includes('FOR UPDATE') ? { rows: [] } : { rows: [] },
    );
    mockedConnect.mockResolvedValueOnce(client);

    await expect(resetPasswordWithToken('deadbeef', 'Abcdef1!')).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    );
  });

  it('senha fraca é rejeitada antes de abrir conexão', async () => {
    await expect(resetPasswordWithToken('anytoken', 'weak')).rejects.toBeTruthy();
    expect(mockedConnect).not.toHaveBeenCalled();
  });
});

describe('findResettableUserByEmail', () => {
  it('sem linha → null', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findResettableUserByEmail('x@y.com')).toBeNull();
  });

  it('com linha → { id }', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    expect(await findResettableUserByEmail('x@y.com')).toEqual({ id: 7 });
    // a query filtra password IS NOT NULL (exclui OAuth-only)
    expect(String(mockedQuery.mock.calls[0][0])).toContain('password IS NOT NULL');
  });
});
