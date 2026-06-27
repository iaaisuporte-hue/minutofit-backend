/**
 * Testes privacy-críticos do módulo Academia (sem atingir DB).
 * Fecha as lacunas da auditoria de jun/2026:
 *   1. professor/personal NÃO vê dado sensível do aluno sem vínculo (getStudent restricted);
 *   2. com vínculo, vê o bloco sensível;
 *   3. detalhe de aluno de OUTRA academia não vaza (cross-tenant → erro);
 *   4. recepção vê operação, não fisiologia; personal/nutri só leitura (matriz de papéis).
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));

import pool from '../config/database';
import { getStudent } from '../services/academyStudentService';
import { SYSTEM_ROLES } from '../db/academyRoles';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;

const studentRow = {
  user_id: 5, name: 'Aluno', email: 'aluno@x.com', phone: null, cpf: null,
  birth_date: null, avatar_url: null, student_status: 'active', academy_unit_id: null,
  is_active: true, joined_at: null, payment_method: null, main_goal: null,
  medical_restrictions: null, emergency_contact_name: null, emergency_contact_phone: null,
  accepted_terms_at: null, accepted_lgpd_at: null,
  plan_id: null, plan_name: null, monthly_price: null, enrollment_start: null,
};
const activityRow = {
  last_workout: new Date('2026-06-20T00:00:00Z'),
  last_checkin: new Date('2026-06-21T00:00:00Z'),
  last_physical_presence: new Date('2026-06-25T00:00:00Z'),
  workouts_30d: 8, checkins_30d: 10, checkins_7d: 3,
};
const membershipRow = { has_app: 1, has_personal: 0, has_nutri: 0 };

/** Mocka as 5 queries paralelas do getStudent + (opcional) a do hasProfessionalLink. */
function mockGetStudent(linked: boolean | null) {
  mockedQuery
    .mockResolvedValueOnce({ rows: [studentRow], rowCount: 1 }) // studentRes
    .mockResolvedValueOnce({ rows: [] })                        // enrollRes
    .mockResolvedValueOnce({ rows: [] })                        // auditRes
    .mockResolvedValueOnce({ rows: [activityRow] })             // activityRes
    .mockResolvedValueOnce({ rows: [membershipRow] });          // membershipsRes
  if (linked !== null) {
    mockedQuery.mockResolvedValueOnce({ rows: linked ? [{ '?column?': 1 }] : [], rowCount: linked ? 1 : 0 });
  }
}

beforeEach(() => mockedQuery.mockReset());

describe('getStudent — blinda fisiologia sem vínculo (LGPD)', () => {
  it('sem vínculo profissional → activity.restricted, sensível nulo, presença operacional visível', async () => {
    mockGetStudent(false);
    const s = await getStudent(1, 5, { id: 99 });
    expect(s.activity.restricted).toBe(true);
    expect(s.activity.lastWorkout).toBeNull();
    expect(s.activity.lastCheckin).toBeNull();
    expect(s.activity.workouts30d).toBeNull();
    expect(s.activity.checkins30d).toBeNull();
    expect(s.activity.adherence30dPct).toBeNull();
    expect(s.activity.adherence7dPct).toBeNull();
    // operacional (presença) segue visível
    expect(s.activity.lastPhysicalPresence).not.toBeNull();
  });

  it('com vínculo (personal/nutri atribuído) → bloco sensível liberado', async () => {
    mockGetStudent(true);
    const s = await getStudent(1, 5, { id: 99 });
    expect(s.activity.restricted).toBe(false);
    expect(s.activity.lastWorkout).not.toBeNull();
    expect(s.activity.workouts30d).toBe(8);
  });

  it('aluno de OUTRA academia → não vaza (lança "não encontrada")', async () => {
    // studentRes vazio (WHERE academy_id=$1 AND user_id=$2 não casa) → throw antes do link
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activityRow] })
      .mockResolvedValueOnce({ rows: [membershipRow] });
    await expect(getStudent(1, 999, { id: 10 })).rejects.toThrow(/encontrad/i);
  });
});

describe('Matriz de papéis — recepção vê operação, não fisiologia', () => {
  const perms = (slug: string) => SYSTEM_ROLES.find((r) => r.slug === slug)!.permissions;

  it('recepção: sem dados metabólicos; lê unidades mas não escreve', () => {
    const p = perms('academy_reception');
    expect(p).not.toContain('academy.students.metabolic');
    expect(p).toContain('academy.units.read');
    expect(p).not.toContain('academy.units.write');
    expect(p.some((x) => x.startsWith('academy.finance'))).toBe(false);
  });

  it('personal/nutri: só leitura + metabólico; sem escrita/finance/units/plans', () => {
    for (const slug of ['academy_personal', 'academy_nutri']) {
      const p = perms(slug);
      expect(p).toContain('academy.students.read');
      expect(p).toContain('academy.students.metabolic');
      expect(p).not.toContain('academy.students.write');
      expect(p.some((x) => x.startsWith('academy.finance'))).toBe(false);
      expect(p.some((x) => x.startsWith('academy.units'))).toBe(false);
      expect(p.some((x) => x.startsWith('academy.plans'))).toBe(false);
    }
  });

  it('aluno: nenhuma permissão de academia', () => {
    expect(perms('academy_student')).toHaveLength(0);
  });
});
