/**
 * Spec 017 — guarda de tenant + regras de unidade (sem atingir DB).
 * Cobre: vínculo aluno→unidade respeita academy_id (cross-tenant bloqueado),
 * unidade inativa rejeitada, listagem escopada, e a principal não pode ser inativada.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn(), connect: jest.fn() } }));

import pool from '../config/database';
import { assertUnitInAcademy, setUnitStatus, listUnits } from '../services/academyUnitService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => mockedQuery.mockReset());

describe('assertUnitInAcademy — tenant guard do vínculo aluno→unidade', () => {
  it('null/undefined → sem vínculo, passa', async () => {
    await expect(assertUnitInAcademy(1, null)).resolves.toBeUndefined();
    await expect(assertUnitInAcademy(1, undefined)).resolves.toBeUndefined();
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('unidade de OUTRA academia (sem linha) → UNIT_NOT_IN_ACADEMY', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(assertUnitInAcademy(1, 999)).rejects.toMatchObject({ code: 'UNIT_NOT_IN_ACADEMY' });
    // a query é escopada por id + academy_id
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('academy_id = $2');
    expect(params).toEqual([999, 1]);
  });

  it('unidade inativa → UNIT_INACTIVE', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ status: 'inactive' }], rowCount: 1 });
    await expect(assertUnitInAcademy(1, 5)).rejects.toMatchObject({ code: 'UNIT_INACTIVE' });
  });

  it('unidade ativa da própria academia → passa', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 });
    await expect(assertUnitInAcademy(1, 5)).resolves.toBeUndefined();
  });
});

describe('setUnitStatus — não inativa a unidade principal', () => {
  it('inativar a principal → UNIT_IS_PRIMARY', async () => {
    // getUnit retorna a principal ativa
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 5, academy_id: 1, name: 'Sede', address: null, status: 'active', is_primary: true, created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    });
    await expect(setUnitStatus(1, 10, 5, 'inactive')).rejects.toMatchObject({ code: 'UNIT_IS_PRIMARY' });
  });
});

describe('listUnits — escopo por tenant', () => {
  it('filtra por academy_id', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await listUnits(7);
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('academy_id = $1');
    expect(params).toEqual([7]);
  });
});
