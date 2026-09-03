import pool from '../../../config/database';
import { APP_TIMEZONE, dayKey } from '../../../utils/appDay';
import {
  BASELINE_MIN_SAMPLES, BASELINE_WINDOW_DAYS, COLD_START, MUSCLE_MAP, TRAINING_LOAD,
} from './config';
import type {
  Baseline, MuscleLoadEntry, ReadinessInput, SubjectiveInput,
} from './types';

/**
 * Leitura dos dados que alimentam o motor (SPEC Mobile P3 §7).
 *
 * Separado do motor de propósito: o motor é puro e determinístico (§61), e um
 * motor que consulta banco não é testável como tal. Aqui mora todo o SQL; lá,
 * toda a regra.
 *
 * ## O que não existe, e por quê isso aparece no código
 *
 * `hrv` e `restingHr` são devolvidos SEMPRE como `null`. Não é esquecimento: a
 * auditoria de 02/set não encontrou fonte para nenhum dos dois — dependem da
 * integração de saúde que a P2 deixou pendente por falta de toolchain nativa. O
 * caminho está construído e testado justamente para o dia em que houver dado.
 */

/** Mediana — robusta a outlier, ao contrário da média (§10). */
function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const s = [...valores].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Baseline pessoal e progressivo (§10, §11, §63).
 *
 * O modo sai dos DIAS DE HISTÓRICO da conta, não da quantidade de dados: uma
 * pessoa que criou a conta há dois meses e só agora começou a treinar tem
 * baseline curto de carga, mas não é "cold start" — e tratá-la assim seria
 * esconder um score que ela já pode ver.
 */
export async function carregarBaseline(userId: number, hoje: string): Promise<Baseline | null> {
  const { rows: contaRows } = await pool.query(
    `SELECT (CURRENT_DATE - created_at::date)::int AS dias FROM users WHERE id = $1`,
    [userId],
  );
  if (contaRows.length === 0) return null;
  const dias = Math.max(0, Number(contaRows[0].dias ?? 0));

  const mode: Baseline['mode'] =
    dias <= COLD_START.coldStartMaxDays ? 'cold_start'
      : dias <= COLD_START.buildingMaxDays ? 'building'
        : 'established';

  // ── Sono: proporção de noites boas nos check-ins da janela
  const { rows: sonoRows } = await pool.query(
    `SELECT slept_well FROM user_daily_checkins
      WHERE user_id = $1 AND slept_well IS NOT NULL
        AND date_key > ($2::date - $3::int) AND date_key < $2::date`,
    [userId, hoje, BASELINE_WINDOW_DAYS],
  );
  const sleepGoodRatio =
    sonoRows.length >= BASELINE_MIN_SAMPLES.sleep
      ? sonoRows.filter((r) => r.slept_well === true).length / sonoRows.length
      : null;

  // ── Carga semanal média da janela (musculação + atividade)
  const { rows: cargaRows } = await pool.query(
    `SELECT COALESCE(SUM(carga), 0)::float AS total,
            COUNT(DISTINCT dia)::int      AS dias_com_treino
       FROM (
         SELECT (ws.performed_at AT TIME ZONE $4)::date AS dia,
                COALESCE(SUM(sl.reps_done * sl.load_done_kg), 0) / 1000.0 AS carga
           FROM workout_sessions ws
           JOIN workout_set_logs sl ON sl.session_id = ws.id AND sl.status = 'done'
          WHERE ws.user_id = $1 AND ws.status IN ('completed','partial')
            AND (ws.performed_at AT TIME ZONE $4)::date > ($2::date - $3::int)
            AND (ws.performed_at AT TIME ZONE $4)::date < $2::date
          GROUP BY 1
         UNION ALL
         SELECT (a.started_at AT TIME ZONE $4)::date AS dia,
                (a.duration_seconds / 60.0) * COALESCE((
                  CASE a.activity_type WHEN 'walk' THEN $5::float WHEN 'run' THEN $6::float
                       WHEN 'cycling' THEN $7::float ELSE $8::float END), 5) / 10.0 AS carga
           FROM activity_sessions a
          WHERE a.user_id = $1
            AND (a.started_at AT TIME ZONE $4)::date > ($2::date - $3::int)
            AND (a.started_at AT TIME ZONE $4)::date < $2::date
       ) t`,
    [userId, hoje, BASELINE_WINDOW_DAYS, APP_TIMEZONE,
      TRAINING_LOAD.activityMet.walk, TRAINING_LOAD.activityMet.run,
      TRAINING_LOAD.activityMet.cycling, TRAINING_LOAD.activityMet.cardio],
  );
  const semanas = BASELINE_WINDOW_DAYS / 7;
  const totalCarga = Number(cargaRows[0]?.total ?? 0);
  const diasComTreino = Number(cargaRows[0]?.dias_com_treino ?? 0);
  // Menos de 2 semanas de sinal: sem baseline de carga (§63 — nunca de um dia só).
  const weeklyLoadAvg =
    diasComTreino >= BASELINE_MIN_SAMPLES.trainingLoadWeeks * 2 && totalCarga > 0
      ? totalCarga / semanas
      : null;

  // ── Pico de carga por grupo muscular na janela — normaliza a recuperação
  const { rows: picoRows } = await pool.query(
    `SELECT e.body_part,
            MAX(dia_carga) AS pico
       FROM (
         SELECT sl.exercise_id,
                (ws.performed_at AT TIME ZONE $4)::date AS dia,
                SUM(sl.reps_done * sl.load_done_kg) / 1000.0 AS dia_carga
           FROM workout_sessions ws
           JOIN workout_set_logs sl ON sl.session_id = ws.id AND sl.status = 'done'
          WHERE ws.user_id = $1 AND ws.status IN ('completed','partial')
            AND sl.exercise_id IS NOT NULL
            AND (ws.performed_at AT TIME ZONE $4)::date > ($2::date - $3::int)
          GROUP BY 1, 2
       ) d
       JOIN exercises e ON e.id = d.exercise_id
      GROUP BY e.body_part`,
    [userId, hoje, BASELINE_WINDOW_DAYS, APP_TIMEZONE],
  );

  const muscleLoadPeak: Record<string, number> = {};
  for (const r of picoRows) {
    const mapa = MUSCLE_MAP[String(r.body_part)] ?? {};
    for (const [grupo, coef] of Object.entries(mapa)) {
      const v = Number(r.pico ?? 0) * coef;
      if (v > (muscleLoadPeak[grupo] ?? 0)) muscleLoadPeak[grupo] = v;
    }
  }

  return {
    mode,
    daysOfHistory: dias,
    sleepGoodRatio,
    // Sem fonte hoje — ver o cabeçalho deste arquivo.
    hrvMedian: mediana([]),
    restingHrMedian: mediana([]),
    weeklyLoadAvg,
    muscleLoadPeak,
  };
}

/** Check-in do dia traduzido para a entrada do motor. */
export async function carregarCheckin(userId: number, hoje: string): Promise<SubjectiveInput | null> {
  const { rows } = await pool.query(
    `SELECT feeling, slept_well, in_pain, stressed, mental_load_level, created_at
       FROM user_daily_checkins WHERE user_id = $1 AND date_key = $2::date LIMIT 1`,
    [userId, hoje],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  // Tradução do vocabulário do check-in existente para o do motor. Deliberada e
  // conservadora: `in_pain` é booleano e vira `moderate`, nunca `high` — não há
  // como um booleano afirmar intensidade, e presumir a pior leitura aplicaria o
  // veto mais severo com base num dado que não o sustenta.
  const energy =
    r.feeling === 'energized' ? 'high' : r.feeling === 'tired' ? 'low' : r.feeling === 'neutral' ? 'normal' : null;
  const sleepQuality = r.slept_well === true ? 'good' : r.slept_well === false ? 'poor' : null;
  const soreness = r.in_pain === true ? 'moderate' : r.in_pain === false ? 'none' : null;
  const stress =
    r.stressed === true ? (r.mental_load_level === 'high' ? 'high' : 'moderate')
      : r.stressed === false ? 'low' : null;

  return {
    energy: energy as SubjectiveInput['energy'],
    sleepQuality: sleepQuality as SubjectiveInput['sleepQuality'],
    soreness: soreness as SubjectiveInput['soreness'],
    stress: stress as SubjectiveInput['stress'],
    painArea: null,
    measuredAt: `${hoje}T${new Date(r.created_at).toISOString().slice(11)}`,
  };
}

/** Carga por grupo muscular na janela, já irradiada para sinergistas (§17). */
export async function carregarCargaMuscular(userId: number, janelaHoras: number): Promise<MuscleLoadEntry[]> {
  const { rows } = await pool.query(
    `SELECT e.body_part,
            ws.performed_at,
            ws.session_rpe,
            SUM(sl.reps_done * sl.load_done_kg) / 1000.0        AS carga,
            BOOL_OR(sl.discomfort IS NOT NULL AND sl.discomfort <> '') AS desconforto
       FROM workout_sessions ws
       JOIN workout_set_logs sl ON sl.session_id = ws.id AND sl.status = 'done'
       JOIN exercises e ON e.id = sl.exercise_id
      WHERE ws.user_id = $1
        AND ws.status IN ('completed','partial')
        AND ws.performed_at > NOW() - make_interval(hours => $2)
      GROUP BY e.body_part, ws.id, ws.performed_at, ws.session_rpe`,
    [userId, janelaHoras],
  );

  const entradas: MuscleLoadEntry[] = [];
  for (const r of rows) {
    const mapa = MUSCLE_MAP[String(r.body_part)] ?? {};
    for (const [grupo, coef] of Object.entries(mapa)) {
      const carga = Number(r.carga ?? 0) * coef;
      if (carga <= 0) continue;
      entradas.push({
        group: grupo,
        load: carga,
        occurredAt: new Date(r.performed_at).toISOString(),
        sessionRpe: r.session_rpe == null ? null : Number(r.session_rpe),
        discomfort: r.desconforto === true,
      });
    }
  }
  return entradas;
}

/** Carga dos últimos 7 dias e dias consecutivos com treino (§15). */
export async function carregarCargaDeTreino(
  userId: number, hoje: string,
): Promise<{ last7dLoad: number; consecutiveDays: number } | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(carga), 0)::float AS total FROM (
       SELECT COALESCE(SUM(sl.reps_done * sl.load_done_kg), 0) / 1000.0 AS carga
         FROM workout_sessions ws
         JOIN workout_set_logs sl ON sl.session_id = ws.id AND sl.status = 'done'
        WHERE ws.user_id = $1 AND ws.status IN ('completed','partial')
          AND (ws.performed_at AT TIME ZONE $3)::date > ($2::date - 7)
        GROUP BY ws.id
       UNION ALL
       SELECT (a.duration_seconds / 60.0) * 6.0 / 10.0
         FROM activity_sessions a
        WHERE a.user_id = $1
          AND (a.started_at AT TIME ZONE $3)::date > ($2::date - 7)
     ) t`,
    [userId, hoje, APP_TIMEZONE],
  );

  const { rows: diasRows } = await pool.query(
    `SELECT DISTINCT (performed_at AT TIME ZONE $3)::date AS dia
       FROM workout_sessions
      WHERE user_id = $1 AND status IN ('completed','partial')
        AND (performed_at AT TIME ZONE $3)::date > ($2::date - 14)
      ORDER BY dia DESC`,
    [userId, hoje, APP_TIMEZONE],
  );

  // Dias consecutivos contados a partir de hoje/ontem para trás.
  let consecutivos = 0;
  const dias = diasRows.map((r) => dayKey(new Date(r.dia)));
  const cursor = new Date(`${hoje}T12:00:00Z`);
  for (let i = 0; i < 14; i++) {
    const chave = dayKey(cursor);
    if (dias.includes(chave)) {
      consecutivos += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else if (i === 0) {
      // Ainda não treinou hoje: começa a contar por ontem.
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else break;
  }

  const total = Number(rows[0]?.total ?? 0);
  if (total === 0 && consecutivos === 0) return null;
  return { last7dLoad: total, consecutiveDays: consecutivos };
}

/** Monta a entrada completa do motor para um usuário e um dia. */
export async function montarEntrada(
  userId: number,
  hoje: string,
  janelaMuscularHoras: number,
  plannedMuscleGroups?: string[],
): Promise<ReadinessInput> {
  const [baseline, subjective, muscleLoad, trainingLoad] = await Promise.all([
    carregarBaseline(userId, hoje),
    carregarCheckin(userId, hoje),
    carregarCargaMuscular(userId, janelaMuscularHoras),
    carregarCargaDeTreino(userId, hoje),
  ]);

  return {
    userId,
    date: hoje,
    subjective,
    sleep: subjective
      ? { sleptWell: subjective.sleepQuality === 'good' ? true : subjective.sleepQuality === 'poor' ? false : null,
          measuredAt: subjective.measuredAt }
      : null,
    // Sem fonte hoje. O motor trata como ausente e a confiança reflete (§38).
    hrv: null,
    restingHr: null,
    trainingLoad,
    muscleLoad,
    baseline,
    metabolicScore: null,
    plannedMuscleGroups,
  };
}
