import type { PoolClient } from 'pg';
import pool from '../config/database';
import { invalidateMetabolismSnapshot } from '../modules/metabolism/metabolic.service';
import { invalidatePersonalDashboardForStudent } from './personalDashboardService';
import { invalidateReadinessSnapshot } from '../modules/readiness/readiness.service';
import logger from '../lib/logger';
import { dayKey } from '../utils/appDay';

type CheckinSource = 'workout' | 'activity' | 'wellbeing';
export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'legs'
  | 'shoulders'
  | 'arms'
  | 'core'
  | 'full_body'
  | 'cardio'
  | 'mobility';

export type NutritionLevel = 'poor' | 'ok' | 'good';
export type MentalLoadLevel = 'low' | 'medium' | 'high';

export type WellbeingSignals = {
  /** API / DB: energized | neutral | tired */
  feeling?: 'tired' | 'neutral' | 'energized' | null;
  sleptWell?: boolean | null;
  inPain?: boolean | null;
  stressed?: boolean | null;
  /** Onda 4 MaaS — sinais secundários opt-in */
  hydrationOk?: boolean | null;
  nutritionLevel?: NutritionLevel | null;
  mentalLoadLevel?: MentalLoadLevel | null;
  notes?: string | null;
};

export type RecordCheckinInput = {
  userId: number;
  academyId?: number | null;
  source: CheckinSource;
  xp: number;
  /**
   * Dia do check-in (YYYY-MM-DD). Default = hoje. Registro retroativo (Spec 024)
   * passa a data real do treino para creditar streak/XP no dia correto.
   */
  dateKey?: string;
  /**
   * Timestamp gravado em user_workout_logs.completed_at (base de aderência).
   * Default = CURRENT_TIMESTAMP. Retroativo passa a data/hora real do treino.
   */
  completedAt?: Date | null;
  workout?: {
    workoutId: string;
    title: string;
    muscleGroups: MuscleGroup[];
  };
  activity?: {
    type: 'walk' | 'run' | 'cycling';
    durationSeconds: number;
    distanceKm: number;
    pace: number;
  };
  signals?: WellbeingSignals | null;
};

/**
 * Dia corrente no fuso do aluno. Era `toISOString()` (dia UTC), o que jogava
 * todo check-in/treino feito depois das 21h (BRT) para o dia seguinte e quebrava
 * a sequência. Ver `utils/appDay.ts`.
 */
function todayDateKey(date = new Date()) {
  return dayKey(date);
}

function normalizeLevel(xp: number) {
  return Math.max(1, Math.floor(xp / 100) + 1);
}

// ── Helpers de data/streak (puros — testáveis sem banco, Spec 024) ────────────

/** Normaliza um valor de data (Date do pg ou string) para 'YYYY-MM-DD'. */
export function toDateKey(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function keyToUtcMs(key: string): number {
  const [y, m, d] = key.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Próximo streak ao registrar `newDateKey` sobre `previousDateKey` (a última
 * data com check-in). Regra atual do produto: +1 só quando é exatamente o dia
 * seguinte; qualquer outro gap reinicia em 1; sem histórico começa em 1.
 * Usar SOMENTE quando newDateKey >= previousDateKey (avanço da âncora).
 */
export function computeNextStreak(
  previousDateKey: string | null,
  newDateKey: string,
  currentStreak: number,
): number {
  if (!previousDateKey) return 1;
  const diff = Math.floor((keyToUtcMs(newDateKey) - keyToUtcMs(previousDateKey)) / ONE_DAY_MS);
  return diff === 1 ? Math.max(0, currentStreak) + 1 : 1;
}

/**
 * Conta a corrida de dias consecutivos com check-in que TERMINA em `anchorKey`,
 * varrendo para trás enquanto houver o dia imediatamente anterior. Usado para
 * reparar o streak quando um registro retroativo emenda uma lacuna sem regredir
 * a âncora (last_checkin_date). `keys` = date_keys distintos (qualquer ordem).
 */
export function computeStreakRunEndingAt(keys: string[], anchorKey: string): number {
  const set = new Set(keys.map((k) => k.slice(0, 10)));
  const anchor = anchorKey.slice(0, 10);
  if (!set.has(anchor)) return 0;
  let run = 0;
  let cursorMs = keyToUtcMs(anchor);
  while (set.has(utcMsToKey(cursorMs))) {
    run += 1;
    cursorMs -= ONE_DAY_MS;
  }
  return run;
}

/**
 * Núcleo transacional do check-in de gamificação (logs + streak/XP), SEM abrir
 * transação nem disparar invalidações — o chamador é dono disso. Extraído para
 * ser reutilizado dentro de OUTRA transação (P0-1 da auditoria: write-through
 * da sessão de treino grava execução rica + este check-in atomicamente).
 */
export async function applyGamificationCheckinTx(
  client: PoolClient,
  input: RecordCheckinInput,
): Promise<{ hadRow: boolean; academyId: number | null }> {
  const academyId = input.academyId ?? null;
  const dateKey = input.dateKey ?? todayDateKey();
  const xpEarned = Math.max(0, Number(input.xp || 0));

  {
    await client.query(
      `INSERT INTO user_gamification_stats (user_id, academy_id, xp, current_streak)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId, academyId],
    );

    if (input.workout) {
      await client.query(
        `INSERT INTO user_workout_logs (user_id, academy_id, workout_id, title, muscle_groups, completed_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))`,
        [
          input.userId,
          academyId,
          input.workout.workoutId,
          input.workout.title,
          input.workout.muscleGroups,
          input.completedAt ?? null,
        ],
      );
    }

    if (input.activity) {
      await client.query(
        `INSERT INTO user_activity_logs (user_id, academy_id, activity_type, duration_seconds, distance_km, pace)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.userId,
          academyId,
          input.activity.type,
          input.activity.durationSeconds,
          input.activity.distanceKm,
          input.activity.pace,
        ],
      );
    }

    const existingCheckin = await client.query<{ id: number }>(
      `SELECT id FROM user_daily_checkins WHERE user_id = $1 AND date_key = $2`,
      [input.userId, dateKey],
    );
    const hadRow = existingCheckin.rows.length > 0;

    const sig = input.signals ?? null;
    const feelingVal = sig?.feeling ?? null;
    const sleptWell = sig?.sleptWell;
    const inPain = sig?.inPain;
    const stressed = sig?.stressed;
    const hydrationOk = sig?.hydrationOk;
    const nutritionLevel = sig?.nutritionLevel ?? null;
    const mentalLoadLevel = sig?.mentalLoadLevel ?? null;
    const notesVal = sig?.notes?.trim() ? sig.notes.trim() : null;

    const sourceForRow: CheckinSource =
      input.source === 'wellbeing' ? 'wellbeing' : input.source;

    const xpForThisEvent = input.source === 'wellbeing' ? 0 : xpEarned;

    await client.query(
      `INSERT INTO user_daily_checkins (
         user_id, academy_id, date_key, source, xp_awarded,
         feeling, slept_well, in_pain, stressed,
         hydration_ok, nutrition_level, mental_load_level,
         notes
       ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id, date_key) DO UPDATE SET
         xp_awarded = user_daily_checkins.xp_awarded + EXCLUDED.xp_awarded,
         source = CASE
           WHEN EXCLUDED.source IN ('workout', 'activity') THEN EXCLUDED.source::varchar
           ELSE user_daily_checkins.source::varchar
         END,
         feeling = COALESCE(EXCLUDED.feeling, user_daily_checkins.feeling),
         slept_well = CASE
           WHEN EXCLUDED.slept_well IS NOT NULL THEN EXCLUDED.slept_well
           ELSE user_daily_checkins.slept_well
         END,
         in_pain = CASE
           WHEN EXCLUDED.in_pain IS NOT NULL THEN EXCLUDED.in_pain
           ELSE user_daily_checkins.in_pain
         END,
         stressed = CASE
           WHEN EXCLUDED.stressed IS NOT NULL THEN EXCLUDED.stressed
           ELSE user_daily_checkins.stressed
         END,
         hydration_ok = CASE
           WHEN EXCLUDED.hydration_ok IS NOT NULL THEN EXCLUDED.hydration_ok
           ELSE user_daily_checkins.hydration_ok
         END,
         nutrition_level = COALESCE(EXCLUDED.nutrition_level, user_daily_checkins.nutrition_level),
         mental_load_level = COALESCE(EXCLUDED.mental_load_level, user_daily_checkins.mental_load_level),
         notes = COALESCE(EXCLUDED.notes, user_daily_checkins.notes)`,
      [
        input.userId,
        academyId,
        dateKey,
        sourceForRow,
        xpForThisEvent,
        feelingVal,
        sleptWell ?? null,
        inPain ?? null,
        stressed ?? null,
        hydrationOk ?? null,
        nutritionLevel,
        mentalLoadLevel,
        notesVal,
      ],
    );

    if (!hadRow) {
      const statsResult = await client.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1
         FOR UPDATE`,
        [input.userId],
      );

      const stats = statsResult.rows[0] || { xp: 0, current_streak: 0, last_checkin_date: null };
      const previousDateKey = toDateKey(stats.last_checkin_date);
      const nextXp = Number(stats.xp || 0) + xpForThisEvent;

      if (previousDateKey && dateKey < previousDateKey) {
        // Retroativo preenchendo lacuna no passado (Spec 024): NUNCA regride a
        // âncora last_checkin_date. Recalcula a corrida de dias consecutivos que
        // termina na última data conhecida — o check-in de `dateKey` já foi
        // UPSERTado acima, então entra na varredura e emenda a lacuna.
        const distinct = await client.query<{ date_key: Date | string }>(
          `SELECT DISTINCT date_key FROM user_daily_checkins
             WHERE user_id = $1 AND date_key <= $2::date
             ORDER BY date_key DESC
             LIMIT 366`,
          [input.userId, previousDateKey],
        );
        const keys = distinct.rows.map((r) => toDateKey(r.date_key)!).filter(Boolean);
        const recalculated = computeStreakRunEndingAt(keys, previousDateKey);
        await client.query(
          `UPDATE user_gamification_stats
           SET xp = $2, current_streak = $3, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1`,
          [input.userId, nextXp, recalculated],
        );
      } else {
        // Registro normal ou retro "à frente" da âncora → avança e move a âncora.
        const nextStreak = computeNextStreak(previousDateKey, dateKey, Number(stats.current_streak || 0));
        await client.query(
          `UPDATE user_gamification_stats
           SET xp = $2, current_streak = $3, last_checkin_date = $4::date, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1`,
          [input.userId, nextXp, nextStreak, dateKey],
        );
      }
    } else if (xpForThisEvent > 0) {
      await client.query(
        `UPDATE user_gamification_stats
         SET xp = xp + $2, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [input.userId, xpForThisEvent],
      );
    }

    return { hadRow, academyId };
  }
}

/**
 * Invalida os caches/snapshots afetados por um novo check-in (metabolismo,
 * dashboard de qualquer personal que acompanhe o aluno, readiness). Chamado
 * SEMPRE após o COMMIT — nunca dentro da transação.
 */
export function invalidateAfterCheckin(userId: number): void {
  void invalidateMetabolismSnapshot(userId).catch((err) =>
    logger.error({ err }, '[metabolism] invalidate snapshot error'),
  );
  // workout/checkin novos mudam métricas refletidas no dashboard do personal
  // (workouts_7d, last_workout_at, current_streak, score de engajamento).
  void invalidatePersonalDashboardForStudent(userId).catch((err) =>
    logger.error({ err }, '[personal_dashboard] invalidate cache error'),
  );
  void invalidateReadinessSnapshot(userId).catch((err) =>
    logger.error({ err }, '[readiness] invalidate snapshot error'),
  );
}

export async function recordGamificationCheckin(input: RecordCheckinInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { hadRow, academyId } = await applyGamificationCheckinTx(client, input);
    await client.query('COMMIT');
    invalidateAfterCheckin(input.userId);
    return await getGamificationSummary(input.userId, hadRow, academyId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getGamificationSummary(userId: number, alreadyCheckedIn = false, academyId: number | null = null) {
  const statsResult = academyId
    ? await pool.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1 AND academy_id = $2`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT xp, current_streak, last_checkin_date
         FROM user_gamification_stats
         WHERE user_id = $1`,
        [userId],
      );

  const stats = statsResult.rows[0] || { xp: 0, current_streak: 0, last_checkin_date: null };

  const checkinResult = academyId
    ? await pool.query(
        `SELECT date_key FROM user_daily_checkins
         WHERE user_id = $1 AND academy_id = $2
         ORDER BY date_key DESC
         LIMIT 7`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT date_key FROM user_daily_checkins
         WHERE user_id = $1
         ORDER BY date_key DESC
         LIMIT 7`,
        [userId],
      );

  const lastWorkoutResult = academyId
    ? await pool.query(
        `SELECT workout_id, title, muscle_groups, completed_at
         FROM user_workout_logs
         WHERE user_id = $1 AND academy_id = $2
         ORDER BY completed_at DESC
         LIMIT 1`,
        [userId, academyId],
      )
    : await pool.query(
        `SELECT workout_id, title, muscle_groups, completed_at
         FROM user_workout_logs
         WHERE user_id = $1
         ORDER BY completed_at DESC
         LIMIT 1`,
        [userId],
      );

  // Contagem de treinos no mês corrente — para microcopy "Xº treino do mês"
  const monthWorkoutsResult = academyId
    ? await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_workout_logs
         WHERE user_id = $1
           AND academy_id = $2
           AND completed_at >= date_trunc('month', CURRENT_DATE)`,
        [userId, academyId],
      )
    : await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_workout_logs
         WHERE user_id = $1
           AND completed_at >= date_trunc('month', CURRENT_DATE)`,
        [userId],
      );
  const workoutsThisMonth = Number(monthWorkoutsResult.rows[0]?.count || 0);

  const streak = Number(stats.current_streak || 0);
  const rewardMicrocopy = buildRewardMicrocopy(streak, workoutsThisMonth);

  return {
    xp: Number(stats.xp || 0),
    level: normalizeLevel(Number(stats.xp || 0)),
    streak,
    // `date_key` é coluna `date`: o driver devolve meia-noite LOCAL. Passar por
    // toISOString() aqui deslocava o dia em servidor fora de UTC — `toDateKey`
    // usa os getters locais e é o leitor correto para esse tipo.
    todayCheckedIn: checkinResult.rows.some(
      (row: { date_key?: Date }) => toDateKey(row.date_key) === todayDateKey(),
    ),
    alreadyCheckedIn,
    heatmap: checkinResult.rows
      .map((row: { date_key?: Date }) => toDateKey(row.date_key))
      .filter(Boolean),
    lastWorkout: lastWorkoutResult.rows[0]
      ? {
          workoutId: lastWorkoutResult.rows[0].workout_id,
          title: lastWorkoutResult.rows[0].title,
          muscleGroups: lastWorkoutResult.rows[0].muscle_groups || [],
          completedAt: lastWorkoutResult.rows[0].completed_at,
        }
      : null,
    rewardMicrocopy,
  };
}

function buildRewardMicrocopy(streak: number, workoutsThisMonth: number): string | null {
  // Marcos de sequência — prioridade máxima
  const streakMilestones = [90, 60, 30, 21, 14, 7];
  for (const m of streakMilestones) {
    if (streak === m) return `${m} dias em sequência — parabéns pela consistência!`;
  }

  // Marco de treinos mensais
  const monthMilestones = [20, 15, 10, 8, 5];
  for (const m of monthMilestones) {
    if (workoutsThisMonth === m) return `${m}º treino do mês — continue assim!`;
  }

  // Microcopy genérica para treinos acima de 1
  if (workoutsThisMonth > 1) {
    return `${workoutsThisMonth}º treino do mês registrado.`;
  }

  // Primeiro treino do mês
  if (workoutsThisMonth === 1) {
    return 'Primeiro treino do mês — ótimo começo!';
  }

  return null;
}
