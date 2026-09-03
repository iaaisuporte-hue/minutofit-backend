import pool from '../../../config/database';
import logger from '../../../lib/logger';
import { dayKey } from '../../../utils/appDay';
import { ALGORITHM_VERSION, MUSCLE_RECOVERY } from './config';
import { computeReadiness, HEADLINES, MICROCOPIES, microcopyDeDor } from './engine';
import { montarEntrada } from './readinessRepository';
import type { ReadinessResult } from './types';

/**
 * Serviço do S2CORE Readiness (SPEC Mobile P3 §35, §57, §58, §59).
 *
 * Responsabilidades: montar a entrada, chamar o motor, persistir o snapshot e
 * servir o resultado do dia com cache.
 *
 * ## Cache e recálculo (§58, §59)
 *
 * O snapshot do dia É o cache. Ele é recalculado quando uma entrada relevante
 * muda — check-in respondido, treino concluído, atividade registrada — e não a
 * cada render, que é o que a §58 proíbe. `invalidarReadiness` é o gancho que os
 * fluxos chamam; ele apaga o snapshot do dia e o próximo GET reconstrói.
 *
 * ## Imutabilidade do histórico (§36)
 *
 * O UPSERT só toca o snapshot de HOJE. Dias anteriores nunca são reescritos,
 * mesmo depois de uma mudança de algoritmo — um snapshot de `1.0` continua
 * sendo `1.0`, e é isso que permite comparar previsão e realidade sem
 * contaminar a série com uma fórmula que ainda não existia.
 */

export interface ReadinessTodayResult extends ReadinessResult {
  date: string;
  /** true quando veio do snapshot gravado, false quando foi calculado agora. */
  cached: boolean;
}

/**
 * Prontidão de hoje. Usa o snapshot quando ele já existe e é da versão corrente.
 *
 * Snapshot de versão ANTIGA é recalculado (o algoritmo mudou; o de hoje deve
 * refletir a versão em uso) mas **não sobrescreve os dias anteriores** — o
 * UPSERT é por `(user_id, snapshot_date)` e só o de hoje está em jogo.
 */
export async function obterReadinessDeHoje(
  userId: number,
  opts: { plannedMuscleGroups?: string[]; forcarRecalculo?: boolean } = {},
): Promise<ReadinessTodayResult> {
  const hoje = dayKey();

  if (!opts.forcarRecalculo) {
    const { rows } = await pool.query(
      `SELECT * FROM readiness_snapshot
        WHERE user_id = $1 AND snapshot_date = $2::date AND algorithm_version = $3`,
      [userId, hoje, ALGORITHM_VERSION],
    );
    if (rows.length > 0) return { ...deLinha(rows[0]), cached: true };
  }

  const entrada = await montarEntrada(userId, hoje, MUSCLE_RECOVERY.windowHours, opts.plannedMuscleGroups);
  const resultado = computeReadiness(entrada, new Date());
  await gravarSnapshot(userId, hoje, resultado);
  return { ...resultado, date: hoje, cached: false };
}

/** Grava (ou atualiza) o snapshot do dia. */
async function gravarSnapshot(userId: number, dia: string, r: ReadinessResult): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO readiness_snapshot
         (user_id, snapshot_date, score, state, recommendation, confidence,
          data_completeness, mode, components, factors, muscle_recovery,
          algorithm_version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,NOW())
       ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
         score = EXCLUDED.score, state = EXCLUDED.state,
         recommendation = EXCLUDED.recommendation, confidence = EXCLUDED.confidence,
         data_completeness = EXCLUDED.data_completeness, mode = EXCLUDED.mode,
         components = EXCLUDED.components, factors = EXCLUDED.factors,
         muscle_recovery = EXCLUDED.muscle_recovery,
         algorithm_version = EXCLUDED.algorithm_version, updated_at = NOW()`,
      [
        userId, dia, r.score, r.state, r.recommendation, r.confidence,
        r.dataCompleteness, r.mode,
        JSON.stringify(r.components), JSON.stringify(r.factors),
        JSON.stringify(r.muscleRecovery), r.algorithmVersion,
      ],
    );
  } catch (err) {
    // Snapshot é cache e trilha de auditoria, não o produto. Falhar aqui não
    // pode custar a resposta ao usuário — mas precisa aparecer no log.
    logger.error({ err, userId, dia }, '[readiness] falha ao gravar snapshot');
  }
}

function deLinha(row: Record<string, unknown>): ReadinessTodayResult {
  const state = row.state as ReadinessResult['state'];
  const factors = (row.factors as ReadinessResult['factors']) ?? [];
  // Dor tem precedência sobre o estado também no caminho de cache — senão a
  // pessoa que relatou desconforto veria "Pegue leve hoje" sem a orientação de
  // procurar o profissional, que é justamente a parte que a §21 exige.
  const temDor = factors.some((f) => f.id === 'pain.high' || f.id === 'pain.moderate');
  return {
    date: String(row.snapshot_date instanceof Date
      ? dayKey(row.snapshot_date as Date)
      : row.snapshot_date),
    score: row.score == null ? null : Number(row.score),
    state,
    recommendation: row.recommendation as ReadinessResult['recommendation'],
    confidence: row.confidence as ReadinessResult['confidence'],
    dataCompleteness: Number(row.data_completeness),
    mode: row.mode as ReadinessResult['mode'],
    components: (row.components as ReadinessResult['components']) ?? [],
    factors,
    muscleRecovery: (row.muscle_recovery as ReadinessResult['muscleRecovery']) ?? [],
    // Derivados do estado, não lidos do banco — ver o comentário em `engine.ts`.
    // Sem isto o caminho de CACHE devolvia manchete e microcopy vazias, e a
    // tela ficava sem título a partir da segunda visita do dia (QA P3).
    headline: HEADLINES[state] ?? '',
    microcopy: temDor ? microcopyDeDor(null) : (MICROCOPIES[state] ?? ''),
    algorithmVersion: String(row.algorithm_version),
    cached: true,
  };
}

/**
 * Invalida o snapshot de hoje (§58).
 *
 * Chamado quando uma entrada relevante muda. Apaga em vez de recalcular na
 * hora: recalcular dentro da transação de um treino concluído acoplaria a
 * gravação da sessão ao motor de prontidão, e uma falha aqui derrubaria aquela.
 * O próximo GET reconstrói.
 */
export async function invalidarReadiness(userId: number): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM readiness_snapshot WHERE user_id = $1 AND snapshot_date = $2::date`,
      [userId, dayKey()],
    );
  } catch (err) {
    logger.warn({ err, userId }, '[readiness] falha ao invalidar snapshot do dia');
  }
}

/**
 * Registra o feedback de esforço pós-treino (§46) com a previsão congelada.
 *
 * A previsão é gravada JUNTO porque a §47 quer comparar previsão × realidade, e
 * buscar o snapshot depois traria o valor recalculado, não o que a pessoa viu
 * quando decidiu treinar. **Nada aqui altera o modelo** — a §47 é explícita
 * sobre não ajustar automaticamente nesta fase.
 */
export async function registrarFeedbackDeEsforco(
  userId: number,
  sessionId: number | null,
  perceived: 'very_light' | 'light' | 'adequate' | 'hard' | 'very_hard',
): Promise<void> {
  const hoje = dayKey();
  const { rows } = await pool.query(
    `SELECT score, recommendation, algorithm_version
       FROM readiness_snapshot WHERE user_id = $1 AND snapshot_date = $2::date`,
    [userId, hoje],
  );
  const prev = rows[0];
  await pool.query(
    `INSERT INTO workout_effort_feedback
       (user_id, session_id, perceived, predicted_score, predicted_recommendation, algorithm_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sessionId, perceived, prev?.score ?? null, prev?.recommendation ?? null, prev?.algorithm_version ?? null],
  );
}

/**
 * Resumo para o Personal (§27, §28).
 *
 * Devolve **apenas** score, estado, confiança, motivos e recuperação por grupo.
 * NÃO devolve componentes brutos, check-in, sono nem qualquer registro de
 * saúde: a §28 pede minimização, e o que ajuda o Personal a decidir é o
 * resumo, não o prontuário. A rota que chama isto aplica `requireActiveConsent`.
 */
export async function obterResumoParaPersonal(
  studentId: number,
): Promise<{
  score: number | null; state: string; confidence: string;
  reasons: string[]; muscleRecovery: ReadinessResult['muscleRecovery']; date: string;
} | null> {
  const hoje = dayKey();
  const { rows } = await pool.query(
    `SELECT score, state, confidence, factors, muscle_recovery, snapshot_date
       FROM readiness_snapshot WHERE user_id = $1 AND snapshot_date = $2::date`,
    [studentId, hoje],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const factors = (r.factors as ReadinessResult['factors']) ?? [];
  return {
    score: r.score == null ? null : Number(r.score),
    state: String(r.state),
    confidence: String(r.confidence),
    // Só os rótulos negativos: são os que informam a decisão do Personal.
    reasons: factors.filter((f) => f.direction === 'negative').map((f) => f.label),
    muscleRecovery: (r.muscle_recovery as ReadinessResult['muscleRecovery']) ?? [],
    date: dayKey(new Date(r.snapshot_date)),
  };
}
