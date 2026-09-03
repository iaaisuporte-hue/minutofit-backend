/**
 * Modelo canônico de Atividade e deduplicação (SPEC Mobile P2 §4/§5/§6).
 *
 * Só o Postgres pega o que interessa aqui: a semântica de NULL nos índices
 * únicos parciais (é ela que permite mil atividades do S2Core sem
 * `source_external_id` convivendo com unicidade real para as importadas), o
 * CHECK do enum de origem, e a atomicidade do advisory lock que serializa dois
 * envios simultâneos. Com pool mockado nada disso é exercitado.
 */
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

jest.setTimeout(120_000);

const TAG = 'itest-p2-activity';

describeWithDb('Atividade · modelo canônico e deduplicação', () => {
  let c: Client;
  let userId: number;
  let outroUserId: number;
  let svc: typeof import('../services/activityService');

  const base = (over: Partial<import('../services/activityService').ActivityInput> = {}) => ({
    userId,
    academyId: null,
    activityType: 'run' as const,
    durationSeconds: 1800,
    distanceKm: 5,
    caloriesEstimated: 300,
    avgPace: 6,
    intensity: 'moderate',
    score: 70,
    routeCoordinates: null,
    validationFlag: false,
    startedAt: new Date('2026-09-01T10:00:00Z'),
    endedAt: new Date('2026-09-01T10:30:00Z'),
    ...over,
  });

  beforeAll(async () => {
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);
    userId = await createUser(c, TAG, 'atleta');
    outroUserId = await createUser(c, TAG, 'outro');
    svc = await import('../services/activityService');
  });

  afterAll(async () => {
    await cleanFixtures(c, TAG);
    await finishSuite(c);
  });

  describe('procedência (§6)', () => {
    it('atividade sem origem declarada nasce como s2core', async () => {
      const r = await svc.createActivity(base());
      const { rows } = await c.query('SELECT source, calories_source FROM activity_sessions WHERE id = $1', [r.id]);
      expect(rows[0].source).toBe('s2core');
      expect(rows[0].calories_source).toBe('estimated');
    });

    it('calorias medidas pela fonte não se disfarçam de estimativa (§55)', async () => {
      const r = await svc.createActivity(base({ calories: 412, startedAt: new Date('2026-09-02T10:00:00Z'), endedAt: new Date('2026-09-02T10:30:00Z') }));
      const { rows } = await c.query('SELECT calories, calories_estimated, calories_source FROM activity_sessions WHERE id = $1', [r.id]);
      expect(rows[0].calories).toBe(412);
      expect(rows[0].calories_source).toBe('device');
      // A nossa conta continua lá, ao lado, sem ter sido sobrescrita.
      expect(rows[0].calories_estimated).toBe(300);
    });

    it('o banco recusa origem fora do enum', async () => {
      await expect(
        c.query(
          `INSERT INTO activity_sessions (user_id, activity_type, started_at, ended_at, source)
           VALUES ($1,'run',NOW(),NOW(),'fitbit_inventado')`,
          [userId],
        ),
      ).rejects.toThrow(/activity_sessions_source_chk/);
    });
  });

  describe('defesa 1 — client_key (§38)', () => {
    it('reenvio com a mesma chave devolve a atividade existente, não cria outra', async () => {
      const a = await svc.createActivity(base({ clientKey: 'ck-1', startedAt: new Date('2026-09-03T10:00:00Z'), endedAt: new Date('2026-09-03T10:30:00Z') }));
      const b = await svc.createActivity(base({ clientKey: 'ck-1', startedAt: new Date('2026-09-03T10:00:00Z'), endedAt: new Date('2026-09-03T10:30:00Z') }));
      expect(b.id).toBe(a.id);
      expect(b.deduplicated).toBe(true);
      expect(b.dedupReason).toBe('client_key');
      const { rows } = await c.query('SELECT count(*)::int n FROM activity_sessions WHERE user_id = $1 AND client_key = $2', [userId, 'ck-1']);
      expect(rows[0].n).toBe(1);
    });

    it('a chave é por usuário — dois atletas podem gerar a mesma', async () => {
      await svc.createActivity(base({ clientKey: 'ck-compartilhada', startedAt: new Date('2026-09-04T10:00:00Z'), endedAt: new Date('2026-09-04T10:30:00Z') }));
      const outro = await svc.createActivity(base({ userId: outroUserId, clientKey: 'ck-compartilhada', startedAt: new Date('2026-09-04T10:00:00Z'), endedAt: new Date('2026-09-04T10:30:00Z') }));
      expect(outro.deduplicated).toBe(false);
    });

    it('atividades SEM chave convivem — o índice é parcial', async () => {
      const a = await svc.createActivity(base({ startedAt: new Date('2026-06-01T10:00:00Z'), endedAt: new Date('2026-06-01T10:30:00Z') }));
      const b = await svc.createActivity(base({ startedAt: new Date('2026-06-02T10:00:00Z'), endedAt: new Date('2026-06-02T10:30:00Z') }));
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('defesa 2 — source_external_id (§5)', () => {
    it('a mesma corrida importada duas vezes é UMA atividade', async () => {
      const p = { source: 'health_connect' as const, sourceExternalId: 'hc-abc-123', sourceApp: 'Garmin Connect' };
      const a = await svc.createActivity(base({ ...p, startedAt: new Date('2026-09-05T10:00:00Z'), endedAt: new Date('2026-09-05T10:30:00Z') }));
      const b = await svc.createActivity(base({ ...p, startedAt: new Date('2026-09-05T10:00:00Z'), endedAt: new Date('2026-09-05T10:30:00Z') }));
      expect(b.id).toBe(a.id);
      expect(b.dedupReason).toBe('source_external_id');
    });

    it('o MESMO id vindo de origens diferentes são atividades diferentes', async () => {
      // Health Connect e Garmin direto podem usar espaços de id independentes;
      // colidir por acidente não pode fundir duas atividades.
      const a = await svc.createActivity(base({ source: 'health_connect', sourceExternalId: 'id-colidente', startedAt: new Date('2026-09-06T10:00:00Z'), endedAt: new Date('2026-09-06T10:30:00Z') }));
      const b = await svc.createActivity(base({ source: 'garmin', sourceExternalId: 'id-colidente', startedAt: new Date('2026-09-06T10:00:00Z'), endedAt: new Date('2026-09-06T10:30:00Z') }));
      expect(b.id).not.toBe(a.id);
    });

    it('a origem preserva o app real por trás dela (§51)', async () => {
      const r = await svc.createActivity(base({ source: 'health_connect', sourceExternalId: 'hc-proc', sourceApp: 'Garmin Connect', startedAt: new Date('2026-09-07T10:00:00Z'), endedAt: new Date('2026-09-07T10:30:00Z') }));
      const { rows } = await c.query('SELECT source, source_app FROM activity_sessions WHERE id = $1', [r.id]);
      expect(rows[0]).toEqual({ source: 'health_connect', source_app: 'Garmin Connect' });
    });
  });

  describe('defesa 3 — janela temporal NÃO é destrutiva (§5)', () => {
    it('atividade parecida é GRAVADA e apenas marcada como possível duplicata', async () => {
      const inicio = new Date('2026-09-08T06:00:00Z');
      const a = await svc.createActivity(base({ startedAt: inicio, endedAt: new Date('2026-09-08T06:30:00Z') }));
      // 90 segundos depois, mesma duração: quase certamente a mesma corrida.
      const b = await svc.createActivity(base({
        startedAt: new Date(inicio.getTime() + 90_000),
        endedAt: new Date(inicio.getTime() + 90_000 + 1_800_000),
        source: 'health_connect',
        sourceExternalId: 'hc-parecida',
      }));
      expect(b.id).not.toBe(a.id);                 // nada foi descartado
      expect(b.possibleDuplicateOf).toBe(a.id);    // mas a suspeita ficou registrada
      const { rows } = await c.query('SELECT possible_duplicate_of FROM activity_sessions WHERE id = $1', [b.id]);
      expect(rows[0].possible_duplicate_of).toBe(a.id);
    });

    it('fora da janela de 3 min não há suspeita', async () => {
      const inicio = new Date('2026-09-09T06:00:00Z');
      await svc.createActivity(base({ startedAt: inicio, endedAt: new Date(inicio.getTime() + 1_800_000) }));
      const b = await svc.createActivity(base({
        startedAt: new Date(inicio.getTime() + 10 * 60_000),
        endedAt: new Date(inicio.getTime() + 10 * 60_000 + 1_800_000),
      }));
      expect(b.possibleDuplicateOf).toBeUndefined();
    });

    it('mesmo horário, TIPO diferente: caminhada e corrida não se confundem', async () => {
      const inicio = new Date('2026-09-10T06:00:00Z');
      await svc.createActivity(base({ activityType: 'run', startedAt: inicio, endedAt: new Date(inicio.getTime() + 1_800_000) }));
      const b = await svc.createActivity(base({ activityType: 'walk', startedAt: inicio, endedAt: new Date(inicio.getTime() + 1_800_000) }));
      expect(b.possibleDuplicateOf).toBeUndefined();
    });

    it('durações muito diferentes não são a mesma atividade', async () => {
      const inicio = new Date('2026-09-11T06:00:00Z');
      await svc.createActivity(base({ durationSeconds: 1800, startedAt: inicio, endedAt: new Date(inicio.getTime() + 1_800_000) }));
      const b = await svc.createActivity(base({ durationSeconds: 5400, startedAt: inicio, endedAt: new Date(inicio.getTime() + 5_400_000) }));
      expect(b.possibleDuplicateOf).toBeUndefined();
    });
  });

  describe('tolerância de duração', () => {
    it('aceita 10% ou 60s, o que for maior', () => {
      expect(svc.duracoesCompativeis(1800, 1860)).toBe(true);   // 1 min em 30
      expect(svc.duracoesCompativeis(1800, 2100)).toBe(false);  // 5 min em 30
      expect(svc.duracoesCompativeis(60, 110)).toBe(true);      // piso de 60s
      expect(svc.duracoesCompativeis(3600, 3900)).toBe(true);   // 10% de 1h
    });
  });

  describe('exclusão (§67)', () => {
    it('apaga a atividade e a rota junto', async () => {
      const r = await svc.createActivity(base({
        routeCoordinates: [{ lat: -23.5, lng: -46.6 }, { lat: -23.51, lng: -46.61 }],
        startedAt: new Date('2026-09-12T10:00:00Z'), endedAt: new Date('2026-09-12T10:30:00Z'),
      }));
      expect(await svc.deleteActivity(userId, r.id)).toBe(true);
      const { rows } = await c.query('SELECT count(*)::int n FROM activity_sessions WHERE id = $1', [r.id]);
      expect(rows[0].n).toBe(0);
    });

    it('não apaga atividade de outra pessoa', async () => {
      const r = await svc.createActivity(base({ startedAt: new Date('2026-09-13T10:00:00Z'), endedAt: new Date('2026-09-13T10:30:00Z') }));
      expect(await svc.deleteActivity(outroUserId, r.id)).toBe(false);
      const { rows } = await c.query('SELECT count(*)::int n FROM activity_sessions WHERE id = $1', [r.id]);
      expect(rows[0].n).toBe(1);
    });
  });
});
