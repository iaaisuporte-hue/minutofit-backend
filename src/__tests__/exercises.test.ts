/**
 * Smoke tests para /api/exercises.
 * Mocka pool para não precisar de banco real em CI.
 */

import request from 'supertest';
import express from 'express';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

const mockExerciseRow = {
  id: VALID_UUID,
  external_id: null,
  source: 'corefit',
  name: 'Supino Reto',
  normalized_name: 'supino reto',
  body_part: 'peito',
  target_muscle: 'Peitoral maior',
  secondary_muscles: ['Tríceps'],
  equipment: 'barra',
  tags: ['academia'],
  instructions: ['Deite no banco.'],
  tips: ['Mantenha o core.'],
  primary_media_url: null,
  primary_media_type: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: { query: jest.fn(), end: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pool = require('../config/database').default;

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import exercisesRouter from '../routes/exercises';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/exercises', exercisesRouter);
  return app;
}

function makeToken(role = 'admin') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateAccessToken } = require('../utils/jwt');
  return generateAccessToken({ id: 1, email: 'test@test.com', role, subscriptionTier: 'free' });
}

describe('GET /api/exercises', () => {
  it('returns exercises list with auth', async () => {
    pool.query.mockResolvedValueOnce({ rows: [mockExerciseRow] });

    const res = await request(buildApp())
      .get('/api/exercises')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.exercises)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/exercises');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/exercises/:id', () => {
  it('returns 400 for invalid UUID', async () => {
    const res = await request(buildApp())
      .get('/api/exercises/not-a-uuid')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown exercise', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/api/exercises/${VALID_UUID}`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('returns exercise data for known id', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [mockExerciseRow] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/api/exercises/${VALID_UUID}`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.exercise.id).toBe(VALID_UUID);
  });
});

describe('GET /api/exercises/batch', () => {
  it('returns empty for no ids', async () => {
    const res = await request(buildApp())
      .get('/api/exercises/batch')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.exercises).toEqual([]);
  });

  it('returns 400 for too many ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111`
    ).join(',');
    const res = await request(buildApp())
      .get(`/api/exercises/batch?ids=${ids}`)
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/exercises (admin)', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await request(buildApp())
      .post('/api/exercises')
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .send({ name: 'Teste' });
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp())
      .post('/api/exercises')
      .set('Authorization', `Bearer ${makeToken('user')}`)
      .send({ name: 'Teste', bodyPart: 'peito', targetMuscle: 'Peitoral', equipment: 'barra' });
    expect(res.status).toBe(403);
  });
});
