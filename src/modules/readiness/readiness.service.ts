import pool from '../../config/database';
import logger from '../../lib/logger';
import { computeLoadReading } from '../performance/trainingLoad.engine';
import { loadScoreAggregates } from '../performance/performance.repository';
import { SCORE_WINDOW_DAYS } from '../performance/performance.constants';
import { computeReadinessLens } from './readiness.engine';
import type { ReadinessLens } from './readiness.engine';

interface TodayCheckinRow {
  feeling: string | null;
  slept_well: boolean | null;
  in_pain: boolean | null;
  stressed: boolean | null;
  hydration_ok: boolean | null;
  nutrition_level: string | null;
  mental_load_level: string | null;
}

async function getTodayCheckinSignals(userId: number): Promise<TodayCheckinRow | null> {
  const { rows } = await pool.query(
    `SELECT feeling, slept_well, in_pain, stressed, hydration_ok, nutrition_level, mental_load_level
     FROM user_daily_checkins
     WHERE user_id = $1 AND date_key = CURRENT_DATE
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

async function getMetabolicSnapshot(userId: number): Promise<{ score: number; delta7d: number | null }> {
  const { rows } = await pool.query(
    `SELECT score, snapshot_date FROM user_metabolism_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC LIMIT 8`,
    [userId],
  );
  const score = rows[0]?.score ?? 50;
  let delta7d: number | null = null;
  if (rows.length >= 2) {
    // Find a snapshot ~7 days ago
    const now = new Date();
    const old = rows.find(r => {
      const d = new Date(r.snapshot_date);
      const diff = (now.getTime() - d.getTime()) / 86400000;
      return diff >= 5;
    });
    if (old) delta7d = rows[0].score - old.score;
  }
  return { score, delta7d };
}

async function upsertLens(userId: number, lens: ReadinessLens): Promise<void> {
  await pool.query(
    `INSERT INTO user_readiness_snapshot (user_id, snapshot_date, level, factors)
     VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (user_id, snapshot_date)
     DO UPDATE SET level = EXCLUDED.level, factors = EXCLUDED.factors`,
    [userId, lens.level, JSON.stringify(lens.factors)],
  );
}

export async function invalidateReadinessSnapshot(userId: number): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM user_readiness_snapshot WHERE user_id = $1 AND snapshot_date = CURRENT_DATE`,
      [userId],
    );
  } catch (err) {
    logger.error({ err }, '[readiness] invalidate snapshot error');
  }
}

/**
 * Ritmo de carga da P3, como sinal do readiness (Onda P6).
 *
 * A P3 criou o campo opcional `trainingLoadRatio` no `ReadinessInput` e o
 * gatilho `load.spike`, mas NADA nunca alimentou o campo — o fator era código
 * morto, e o teste de regressão daquela onda ("sem o campo, saída idêntica")
 * passava justamente porque o campo nunca chegava. Esta função fecha o circuito.
 *
 * Falha aqui não derruba o readiness: o ritmo é UM sinal entre doze, e ficar
 * sem prontidão porque uma consulta de carga falhou seria trocar o essencial
 * pelo acessório. `null` faz o fator não participar, que é o comportamento
 * correto para "não sei".
 */
async function getTrainingLoadRatio(userId: number): Promise<number | null> {
  try {
    const { loadSum7d, loadSum28d, sessionsWithLoad28d } = await loadScoreAggregates(
      userId,
      SCORE_WINDOW_DAYS,
    );
    return computeLoadReading({
      sum7d: loadSum7d,
      sum28d: loadSum28d,
      sessionsWithLoad28d,
    }).ratio;
  } catch (err) {
    logger.warn({ err, userId }, '[readiness] falha ao ler o ritmo de carga');
    return null;
  }
}

/**
 * Monta o input do Lens.
 *
 * Existia duas vezes, copiado — e a cópia do caminho com cache passou a
 * divergir no instante em que a P6 acrescentou o ritmo de carga a um só dos
 * lados. Dois inputs para o mesmo aluno produziriam duas prontidões diferentes
 * dependendo de qual ramo executou, que é o pior tipo de bug: intermitente e
 * invisível.
 */
async function buildReadinessInput(
  userId: number,
  checkin: Awaited<ReturnType<typeof getTodayCheckinSignals>>,
) {
  const [{ score, delta7d }, trainingLoadRatio] = await Promise.all([
    getMetabolicSnapshot(userId),
    getTrainingLoadRatio(userId),
  ]);
  return {
    metabolicScore: score,
    metabolismDelta7d: delta7d,
    feeling: normalizeFeeling(checkin!.feeling),
    sleptWell: checkin!.slept_well,
    inPain: checkin!.in_pain,
    stressed: checkin!.stressed,
    nutritionLevel: normalizeNutrition(checkin!.nutrition_level),
    mentalLoadLevel: normalizeMentalLoad(checkin!.mental_load_level),
    trainingLoadRatio,
  };
}

export async function getReadinessLensToday(userId: number): Promise<ReadinessLens | null> {
  const checkin = await getTodayCheckinSignals(userId);
  // Sem check-in do dia não há prontidão: o Lens depende do que o aluno
  // relatou, e inventar um estado sem esse relato seria afirmar sobre o corpo
  // de alguém sem ter perguntado.
  if (!checkin) return null;

  const input = await buildReadinessInput(userId, checkin);
  const lens = computeReadinessLens(input);

  // O snapshot é memória do dia, não atalho de cálculo: o Lens é recomputado
  // de qualquer forma (é função pura e barata) e o upsert só mantém a linha
  // para quem lê histórico. Gravar sempre custa menos que servir um estado
  // velho depois de um check-in novo.
  void upsertLens(userId, lens).catch(err =>
    logger.error({ err }, '[readiness] upsert snapshot error'),
  );

  return lens;
}

function normalizeFeeling(f: string | null): 'energized' | 'neutral' | 'tired' | null {
  if (f === 'energized' || f === 'neutral' || f === 'tired') return f;
  return null;
}

function normalizeNutrition(n: string | null): 'poor' | 'ok' | 'good' | null {
  if (n === 'poor' || n === 'ok' || n === 'good') return n;
  return null;
}

function normalizeMentalLoad(m: string | null): 'low' | 'medium' | 'high' | null {
  if (m === 'low' || m === 'medium' || m === 'high') return m;
  return null;
}
