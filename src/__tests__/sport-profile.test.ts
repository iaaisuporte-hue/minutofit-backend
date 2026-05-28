jest.mock('../config/database', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('../services/sportsEngine', () => ({
  isValidSportKey: jest.fn((key: string) => key === 'jiu_jitsu'),
  getSportConfig: jest.fn(),
  getRegisteredSports: jest.fn(() => []),
}));

import pool from '../config/database';
import { getSportProfile, upsertSportProfile, deactivateSportProfile } from '../services/sportProfileService';
import { listPreWorkoutCheckins } from '../services/sportCheckinService';

const mockedQuery = (pool as unknown as { query: jest.Mock }).query;
const JWT_SECRET = process.env.JWT_SECRET!;

const mockProfile = {
  user_id: 1,
  primary_sport: 'jiu_jitsu',
  sport_level: 'intermediate',
  graduation_rank: 'azul',
  weekly_frequency: 4,
  competes: true,
  primary_goal: 'performance',
  current_weight_kg: 78.5,
  target_weight_kg: 76.0,
  coach_name: null,
  nutri_name: null,
  active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getSportProfile', () => {
  it('returns profile when found', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [mockProfile] });
    const result = await getSportProfile(1);
    expect(result).toEqual(mockProfile);
    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining('user_sport_profile'), [1]);
  });

  it('returns null when not found', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getSportProfile(99);
    expect(result).toBeNull();
  });
});

describe('upsertSportProfile', () => {
  it('creates new profile and returns it', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [mockProfile] });
    const result = await upsertSportProfile(1, { primary_sport: 'jiu_jitsu' });
    expect(result).toEqual(mockProfile);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_sport_profile'),
      expect.arrayContaining([1, 'jiu_jitsu']),
    );
  });

  it('rejects unregistered sport key', async () => {
    await expect(upsertSportProfile(1, { primary_sport: 'unknown_sport' as any }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('not registered') });
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});

describe('deactivateSportProfile', () => {
  it('sets active = false and preserves the record', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await deactivateSportProfile(1);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('active = false'),
      [1],
    );
    // Does NOT delete the row
    expect(mockedQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      expect.anything(),
    );
  });
});

describe('cross-user isolation (service layer)', () => {
  it('getSportProfile for user B returns null when only user A has data', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getSportProfile(2);
    expect(result).toBeNull();
    // Query must filter by user_id = 2, never exposes user 1 data
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('user_sport_profile'),
      [2],
    );
  });

  it('listPreWorkoutCheckins for user B returns empty list (user A data invisible)', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    const result = await listPreWorkoutCheckins(2);
    expect(result).toEqual([]);
    // Query must filter by user_id = 2
    const call = mockedQuery.mock.calls[0];
    expect(call[1]).toContain(2);
    expect(call[0]).toContain('athlete_pre_workout_checkin');
  });

  it('upsertSportProfile always scopes INSERT to the requesting userId', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ ...mockProfile, user_id: 2 }] });
    const result = await upsertSportProfile(2, { primary_sport: 'jiu_jitsu' });
    expect(result.user_id).toBe(2);
    const call = mockedQuery.mock.calls[0];
    expect(call[1][0]).toBe(2); // first param is always userId
  });
});
