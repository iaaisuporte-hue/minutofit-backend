import pool from '../config/database';
import logger from '../lib/logger';

/**
 * Domínio canônico de Atividade (SPEC Mobile P2 §4/§5/§6).
 *
 * Uma atividade é qualquer exercício com duração no tempo que NÃO é a execução
 * de uma ficha: caminhada, corrida, ciclismo. Musculação continua em
 * `workout_sessions` com o motor próprio — a §40 é explícita sobre não
 * fragmentar a UX, mas os dois domínios têm formas diferentes e forçá-los na
 * mesma tabela custaria mais do que resolve.
 *
 * O que este módulo garante, e que a rota sozinha não garantia:
 *
 *  - **idempotência de ingestão**: o mesmo POST reenviado não vira uma segunda
 *    corrida no histórico;
 *  - **deduplicação entre fontes**: a corrida que chega do relógio pelo Health
 *    Connect e, amanhã, pela API do fornecedor, é UMA atividade;
 *  - **procedência**: de onde o dado veio e quem o mediu, para que a P3 possa
 *    pesar a qualidade do sinal por fabricante.
 */

export type ActivitySource =
  | 's2core'
  | 'health_connect'
  | 'apple_health'
  | 'garmin'
  | 'strava'
  | 'manual'
  | 'import';

export type ActivityType = 'walk' | 'run' | 'cycling' | 'cardio';

export const VALID_ACTIVITY_SOURCES = new Set<string>([
  's2core', 'health_connect', 'apple_health', 'garmin', 'strava', 'manual', 'import',
]);

export const VALID_ACTIVITY_TYPES = new Set<string>(['walk', 'run', 'cycling', 'cardio']);

/**
 * Janela da terceira defesa de dedup.
 *
 * Quando NENHUM identificador existe (nem da origem, nem do cliente), duas
 * atividades do mesmo tipo que começam a menos de 3 minutos uma da outra e têm
 * duração parecida são quase certamente a mesma coisa vista por dois caminhos.
 * Três minutos porque relógio de aparelho e relógio de serviço divergem, e o
 * instante de início raramente bate ao segundo entre fontes.
 */
export const DEDUP_START_WINDOW_MS = 3 * 60 * 1000;

/** Diferença de duração tolerada na heurística: 10% ou 60s, o que for maior. */
export function duracoesCompativeis(a: number, b: number): boolean {
  const tolerancia = Math.max(60, Math.max(a, b) * 0.1);
  return Math.abs(a - b) <= tolerancia;
}

export interface ActivityInput {
  userId: number;
  academyId: number | null;
  activityType: ActivityType;
  durationSeconds: number;
  distanceKm: number;
  caloriesEstimated: number;
  avgPace: number;
  intensity: string | null;
  score: number | null;
  routeCoordinates: unknown | null;
  validationFlag: boolean;
  startedAt: Date;
  endedAt: Date;
  /** Procedência. Default `s2core` — o que o próprio app gravou. */
  source?: ActivitySource;
  sourceExternalId?: string | null;
  sourceApp?: string | null;
  /** Idempotência do cliente. Ver `uniq_activity_client_key`. */
  clientKey?: string | null;
  avgHeartRate?: number | null;
  maxHeartRate?: number | null;
  /** Calorias MEDIDAS pela fonte. Não confundir com `caloriesEstimated`. */
  calories?: number | null;
  elevationGainM?: number | null;
}

export interface ActivityResult {
  id: number;
  createdAt: string;
  /** true quando a atividade já existia e foi devolvida como replay. */
  deduplicated: boolean;
  /** Como a duplicata foi identificada — para log e para o relatório. */
  dedupReason?: 'client_key' | 'source_external_id' | 'time_window';
  /** Preenchido só na heurística: a atividade suspeita NÃO foi descartada. */
  possibleDuplicateOf?: number;
}

/**
 * Grava uma atividade, deduplicando.
 *
 * A ordem das defesas é a ordem da confiança:
 *
 * 1. `client_key` — o cliente afirma "isto é o mesmo envio". Certeza total.
 * 2. `source_external_id` — a origem afirma "esta é a atividade X". Certeza da
 *    origem, que é o melhor que existe para dado importado.
 * 3. janela temporal — ninguém afirma nada e nós SUSPEITAMOS. Aqui a atividade
 *    é gravada mesmo assim, com `possible_duplicate_of` apontando para a outra.
 *    A SPEC §5 proíbe heurística destrutiva, e apagar por semelhança seria
 *    exatamente isso: o custo de errar é perder um treino que aconteceu.
 */
export async function createActivity(input: ActivityInput): Promise<ActivityResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serializa envios concorrentes do mesmo usuário: sem isto, dois POSTs
    // simultâneos passam limpos pelos SELECTs e ambos inserem. Mesmo padrão do
    // `workoutSessionService`.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`activity:${input.userId}`]);

    // ── Defesa 1: chave de idempotência do cliente
    if (input.clientKey) {
      const existente = await client.query(
        `SELECT id, created_at FROM activity_sessions WHERE user_id = $1 AND client_key = $2`,
        [input.userId, input.clientKey],
      );
      if (existente.rows.length > 0) {
        await client.query('COMMIT');
        logger.info(
          { userId: input.userId, activityId: existente.rows[0].id },
          '[activity] reenvio com a mesma client_key — devolvendo a atividade existente',
        );
        return {
          id: existente.rows[0].id,
          createdAt: String(existente.rows[0].created_at),
          deduplicated: true,
          dedupReason: 'client_key',
        };
      }
    }

    // ── Defesa 2: identificador da própria origem
    if (input.sourceExternalId && input.source) {
      const existente = await client.query(
        `SELECT id, created_at FROM activity_sessions
          WHERE user_id = $1 AND source = $2 AND source_external_id = $3`,
        [input.userId, input.source, input.sourceExternalId],
      );
      if (existente.rows.length > 0) {
        await client.query('COMMIT');
        return {
          id: existente.rows[0].id,
          createdAt: String(existente.rows[0].created_at),
          deduplicated: true,
          dedupReason: 'source_external_id',
        };
      }
    }

    // ── Defesa 3: suspeita por janela temporal (NUNCA descarta)
    const candidatos = await client.query(
      `SELECT id, duration_seconds FROM activity_sessions
        WHERE user_id = $1
          AND activity_type = $2
          AND started_at BETWEEN $3::timestamptz - make_interval(secs => $4)
                             AND $3::timestamptz + make_interval(secs => $4)
        ORDER BY abs(EXTRACT(EPOCH FROM (started_at - $3::timestamptz)))
        LIMIT 5`,
      [input.userId, input.activityType, input.startedAt, DEDUP_START_WINDOW_MS / 1000],
    );

    const parecido = candidatos.rows.find((r) =>
      duracoesCompativeis(Number(r.duration_seconds), input.durationSeconds),
    );

    const inserido = await client.query(
      `INSERT INTO activity_sessions
         (user_id, academy_id, activity_type, duration_seconds, distance_km, calories_estimated,
          avg_pace, intensity, score, route_coordinates, validation_flag, started_at, ended_at,
          source, source_external_id, source_app, client_key,
          avg_heart_rate, max_heart_rate, calories, calories_source, elevation_gain_m,
          possible_duplicate_of, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
       RETURNING id, created_at`,
      [
        input.userId,
        input.academyId,
        input.activityType,
        input.durationSeconds,
        input.distanceKm,
        input.caloriesEstimated,
        input.avgPace,
        input.intensity,
        input.score,
        input.routeCoordinates ? JSON.stringify(input.routeCoordinates) : null,
        input.validationFlag,
        input.startedAt,
        input.endedAt,
        input.source ?? 's2core',
        input.sourceExternalId ?? null,
        input.sourceApp ?? null,
        input.clientKey ?? null,
        input.avgHeartRate ?? null,
        input.maxHeartRate ?? null,
        input.calories ?? null,
        // §55: calorias medidas pela fonte nunca são apresentadas como
        // estimativa nossa, e a nossa estimativa nunca se disfarça de medição.
        input.calories != null ? 'device' : 'estimated',
        input.elevationGainM ?? null,
        parecido ? Number(parecido.id) : null,
      ],
    );

    await client.query('COMMIT');

    if (parecido) {
      logger.info(
        { userId: input.userId, novaId: inserido.rows[0].id, semelhanteA: parecido.id },
        '[activity] possível duplicata por janela temporal — gravada e marcada, não descartada',
      );
    }

    return {
      id: inserido.rows[0].id,
      createdAt: String(inserido.rows[0].created_at),
      deduplicated: false,
      ...(parecido ? { possibleDuplicateOf: Number(parecido.id), dedupReason: 'time_window' as const } : {}),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Exclui uma atividade do S2Core (§67).
 *
 * **Decisão documentada:** a exclusão remove APENAS do S2Core. Não tentamos
 * apagar da fonte externa, e o motivo é assimétrico: apagar aqui algo que o
 * usuário quis apagar é reversível para ele (ele reimporta); apagar do Health
 * Connect ou do Garmin é destruir o dado de outra aplicação a partir de um
 * gesto feito aqui — e ele pode nem imaginar que isso aconteceria.
 *
 * A consequência honesta: uma atividade importada e excluída aqui pode voltar
 * na próxima sincronização. Por isso o `deleted_external` fica registrado —
 * ver o backlog do reimporte suprimido em ACTIVITY_DEVICE_ARCHITECTURE.md.
 */
export async function deleteActivity(userId: number, activityId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM activity_sessions WHERE id = $1 AND user_id = $2`,
    [activityId, userId],
  );
  return (rowCount ?? 0) > 0;
}
