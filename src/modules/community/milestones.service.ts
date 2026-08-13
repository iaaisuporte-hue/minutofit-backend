/**
 * Marcos — leitura dos fatos, concessão e pagamento (Spec 034, Onda C1).
 *
 * ## O pipeline
 *
 * ```
 * fato real → evaluateMilestoneFacts (puro) → INSERT ... ON CONFLICT DO NOTHING
 *           → awardXpTx (ledger da C0)      → aba Marcos
 * ```
 *
 * ## Duas portas, nenhum cron
 *
 * A avaliação acontece **depois do COMMIT** da sessão (padrão da P4) e
 * **também** na leitura da aba. A segunda não é redundância: se o hook falhar —
 * banco indisponível, deploy no meio, exceção nova —, o marco não pode ficar
 * perdido para sempre. A próxima vez que o aluno abrir a aba, a conta é refeita
 * e o estado se corrige sozinho. É consistência eventual com recuperação por
 * pull, que é o que este repositório usa no lugar de um event bus.
 *
 * Isso só é seguro porque a concessão é idempotente por construção: o engine é
 * puro e o `UNIQUE(user_id, code)` recusa a segunda linha. Reprocessar dez vezes
 * produz um marco, um evento de XP e nenhuma duplicata.
 *
 * ## Por que o XP é liquidado à parte
 *
 * Um marco pode desbloquear num dia em que o teto de XP já estourou (treino 30
 * + atividade 20 + outro marco 10 = 60). Se o pagamento acontecesse só no
 * instante do desbloqueio, esse marco ficaria **para sempre sem XP**, em
 * silêncio. Então toda avaliação liquida os marcos ainda não pagos: no dia
 * seguinte há teto, e o `event_key` determinístico garante que a liquidação
 * atrasada não vira pagamento dobrado.
 */
import type { PoolClient } from 'pg';

import pool from '../../config/database';
import logger from '../../lib/logger';
import { dayKey, dayKeyToInstant } from '../../utils/appDay';
import { awardXpTx } from '../../services/xpLedgerService';
import {
  findFirstActiveDay,
  findLastActiveDayBefore,
  listActiveDays,
  loadWeeklyFrequencyTarget,
} from '../performance/performance.repository';
import { findMilestone, type MilestoneCode, MILESTONE_CATALOG } from './milestones.catalog';
import {
  MILESTONE_WINDOW_DAYS,
  evaluateMilestoneFacts,
  type MilestoneFacts,
} from './milestones.engine';

/**
 * Espaço de chaves do advisory lock. Metas usam `2`; marcos usam `3`; desafios
 * ficarão com `4` (§Arquitetura de eventos da spec). Espaços distintos deixam
 * as três avaliações rodarem em paralelo sem se bloquearem.
 */
const LOCK_NAMESPACE_MILESTONES = 3;

export interface MilestoneDto {
  code: string;
  title: string;
  description: string;
  criterion: string;
  unlockedAt: string | null;
  evidence: Record<string, unknown> | null;
  shared: boolean;
  /**
   * `false` quando o marco não tem como ser conquistado no estado atual da
   * conta — hoje, os três que dependem de frequência prevista para um aluno
   * sem ficha, e o de desafio, que não existe até a C2.
   *
   * Exibir critério de algo inalcançável é prometer caminho que não há. A
   * regra `null` = "não afirmo" vale para o dado; para a tela, a obrigação é
   * dizer o que falta destravar.
   */
  available: boolean;
  /** Por que está indisponível. `null` quando `available`. */
  unavailableReason: string | null;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Fatos
 * ------------------------------------------------------------------ */

async function loadFacts(userId: number): Promise<MilestoneFacts> {
  const today = dayKey();
  const windowStart = addDays(today, -(MILESTONE_WINDOW_DAYS - 1));

  const [firstSessionRes, firstPrRes, goalsRes, activeDays, previousActiveDay, plan, firstActiveDay] =
    await Promise.all([
      pool.query<{ id: number; performed_at: Date }>(
        `SELECT id, performed_at
           FROM workout_sessions
          WHERE user_id = $1 AND status IN ('completed', 'partial')
          ORDER BY performed_at ASC, id ASC
          LIMIT 1`,
        [userId],
      ),
      // `is_first = false` é o coração do marco: o primeiro registro de um
      // exercício não é recorde, é a linha de base. Ver o engine.
      pool.query<{ id: number; exercise_id: string | null; kind: string; achieved_at: Date }>(
        `SELECT id, exercise_id, kind, achieved_at
           FROM user_pr_events
          WHERE user_id = $1 AND is_first = false
          ORDER BY achieved_at ASC, id ASC
          LIMIT 1`,
        [userId],
      ),
      pool.query<{ n: number; last_at: Date | null }>(
        `SELECT COUNT(*)::int AS n, MAX(achieved_at) AS last_at
           FROM user_performance_goals
          WHERE user_id = $1 AND status = 'achieved'`,
        [userId],
      ),
      listActiveDays(userId, windowStart, today),
      findLastActiveDayBefore(userId, windowStart),
      // O alvo semanal vem do resolvedor canônico do módulo Performance — os
      // marcos CONSOMEM a métrica, nunca a recalculam. Foi assim que o aluno
      // B2C, sem ficha, passou a poder conquistar os marcos de semana: a regra
      // mudou em um lugar só.
      loadWeeklyFrequencyTarget(userId),
      findFirstActiveDay(userId),
    ]);

  const firstSession = firstSessionRes.rows[0]
    ? {
        sessionId: Number(firstSessionRes.rows[0].id),
        performedAt: new Date(firstSessionRes.rows[0].performed_at).toISOString(),
      }
    : null;

  const firstRealPr = firstPrRes.rows[0]
    ? {
        prEventId: Number(firstPrRes.rows[0].id),
        exerciseId: firstPrRes.rows[0].exercise_id ?? null,
        kind: firstPrRes.rows[0].kind,
        achievedAt: new Date(firstPrRes.rows[0].achieved_at).toISOString(),
      }
    : null;

  return {
    today,
    firstSession,
    firstRealPr,
    goalsAchieved: Number(goalsRes.rows[0]?.n ?? 0),
    goalsLastAchievedAt: goalsRes.rows[0]?.last_at
      ? new Date(goalsRes.rows[0].last_at).toISOString()
      : null,
    firstActiveDay,
    activeDays,
    previousActiveDay,
    weeklyTarget: plan.weeklyTarget,
    planActiveSince: plan.since,
  };
}

/**
 * O `unlockedAt` do engine é ou um instante ISO (veio de um fato com hora) ou
 * um dia de calendário. Dia vira o MEIO-DIA do fuso do aluno — jamais
 * `::timestamptz` cru, que o Postgres lê como meia-noite UTC e carimbaria o
 * marco de hoje com a data de ontem.
 */
function toInstant(unlockedAt: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(unlockedAt)) return dayKeyToInstant(unlockedAt);
  const d = new Date(unlockedAt);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/* ------------------------------------------------------------------ *
 * Concessão
 * ------------------------------------------------------------------ */

/**
 * A chave natural do pagamento. Determinística e única por pessoa e marco —
 * é o que torna a liquidação atrasada segura.
 */
export function milestoneEventKey(userId: number, code: string): string {
  return `milestone:${userId}:${code}`;
}

/**
 * Paga os marcos do usuário que ainda não têm crédito no ledger.
 *
 * Roda dentro da transação da avaliação. O `LEFT JOIN` sobre `xp_events` é o
 * que transforma "pagar no desbloqueio" em "pagar quando couber": marco preso
 * pelo teto do dia é repescado na próxima avaliação, sem risco de dobra porque
 * o `event_key` é o mesmo.
 */
async function settleMilestoneXp(client: PoolClient, userId: number): Promise<number> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT m.code
       FROM user_milestones m
       LEFT JOIN xp_events x
              ON x.event_key = $2 || m.code
             -- Predicado, nao convencao de string: hoje a chave embute o id e
             -- o codigo e whitelistado, entao nao ha colisao possivel. Mas o
             -- UNIQUE de xp_events e global, e se um dia o formato da chave
             -- mudar o defeito seria silencioso. Isolamento nao deve depender
             -- de formato de string.
             AND x.user_id = m.user_id
      WHERE m.user_id = $1 AND x.id IS NULL`,
    [userId, `milestone:${userId}:`],
  );
  if (rows.length === 0) return 0;

  // A linha de stats precisa existir: `awardXpTx` a trava com FOR UPDATE, e um
  // aluno pode ganhar o primeiro marco antes de qualquer check-in.
  await client.query(
    `INSERT INTO user_gamification_stats (user_id, xp, current_streak)
     VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const today = dayKey();
  let paid = 0;
  for (const row of rows) {
    const amount = await awardXpTx(client, {
      userId,
      kind: 'milestone',
      eventKey: milestoneEventKey(userId, row.code),
      dateKey: today,
    });
    if (amount > 0) {
      await client.query(
        `UPDATE user_gamification_stats SET xp = COALESCE(xp, 0) + $2 WHERE user_id = $1`,
        [userId, amount],
      );
      paid += amount;
    }
  }
  return paid;
}

/** Liquida o XP pendente em transação própria; falha aqui não custa marco. */
async function settleMilestoneXpSafely(userId: number): Promise<void> {
  const client = await pool.connect().catch(() => null);
  if (!client) return;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      LOCK_NAMESPACE_MILESTONES,
      userId,
    ]);
    await settleMilestoneXp(client, userId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.warn({ err, userId }, '[community] falha ao liquidar XP de marcos');
  } finally {
    client.release();
  }
}

export interface MilestoneAward {
  code: MilestoneCode;
  title: string;
}

/**
 * Avalia, concede e paga. Nunca lança: quem chama é o registro de treino, e
 * **falha aqui não pode derrubar o treino** — a recompensa é acessória, o fato
 * é essencial. Um erro vira log, e a próxima leitura reavalia.
 */
export async function evaluateMilestones(userId: number): Promise<MilestoneAward[]> {
  const awards: MilestoneAward[] = [];
  let client: PoolClient | null = null;

  try {
    const facts = await loadFacts(userId);
    const unlocks = evaluateMilestoneFacts(facts);

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      LOCK_NAMESPACE_MILESTONES,
      userId,
    ]);

    for (const unlock of unlocks) {
      // A idempotência é do banco. Duas avaliações simultâneas serializam no
      // advisory lock, e mesmo sem ele o UNIQUE recusaria a segunda linha.
      const inserted = await client.query<{ code: string }>(
        `INSERT INTO user_milestones (user_id, code, unlocked_at, evidence_json)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb)
         ON CONFLICT (user_id, code) DO NOTHING
         RETURNING code`,
        [userId, unlock.code, toInstant(unlock.unlockedAt), JSON.stringify(unlock.evidence)],
      );
      if (inserted.rows.length > 0) {
        const def = findMilestone(unlock.code);
        awards.push({ code: unlock.code, title: def?.title ?? unlock.code });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    logger.warn({ err, userId }, '[community] falha ao avaliar marcos');
    return [];
  } finally {
    client?.release();
  }

  // O XP é liquidado FORA da transação das concessões, e de propósito. Na
  // mesma transação, qualquer falha no pagamento — que toca `xp_events` e
  // `user_gamification_stats`, tabelas de outro assunto — desfaria também os
  // marcos, e uma falha determinística deixaria o aluno sem a conquista para
  // sempre, com um log dizendo só "falha ao avaliar marcos". O texto deste
  // módulo diz que o fato é essencial e a recompensa é acessória; separar as
  // transações é o que faz o código dizer o mesmo. A repescagem por LEFT JOIN
  // já existe justamente para tolerar um pagamento que não aconteceu hoje.
  await settleMilestoneXpSafely(userId);

  if (awards.length > 0) {
    logger.info(
      { userId, codes: awards.map((a) => a.code) },
      '[community] marcos desbloqueados',
    );
  }
  return awards;
}

/* ------------------------------------------------------------------ *
 * Leitura
 * ------------------------------------------------------------------ */

/**
 * A aba Marcos: o catálogo inteiro, com o que já foi conquistado preenchido.
 *
 * Devolver os bloqueados também é decisão de produto: a aba é sobre a
 * trajetória, e ver o critério do próximo marco é informação útil — diferente
 * de uma vitrine de cadeados, que seria coleção infantil. A avaliação roda
 * antes (recuperação por pull) para que abrir a aba **corrija** o estado.
 */
/** Marcos que só existem quando há frequência prevista para comparar. */
const REQUIRE_WEEKLY_TARGET = new Set(['first_full_week', 'four_consistent_weeks', 'comeback']);

export async function listMilestonesForUser(userId: number): Promise<MilestoneDto[]> {
  await evaluateMilestones(userId);

  const [{ rows }, plan] = await Promise.all([
    pool.query<{
      code: string;
      unlocked_at: Date;
      evidence_json: Record<string, unknown>;
      shared_at: Date | null;
    }>(
      `SELECT code, unlocked_at, evidence_json, shared_at
         FROM user_milestones
        WHERE user_id = $1`,
      [userId],
    ),
    loadWeeklyFrequencyTarget(userId),
  ]);

  const byCode = new Map(rows.map((r) => [r.code, r]));
  const temAlvoSemanal = plan.weeklyTarget != null;

  return MILESTONE_CATALOG.map((def) => {
    const row = byCode.get(def.code);
    let available = true;
    let unavailableReason: string | null = null;

    if (!row) {
      if (!def.evaluated) {
        available = false;
        unavailableReason = 'Chega com os desafios.';
      } else if (REQUIRE_WEEKLY_TARGET.has(def.code) && !temAlvoSemanal) {
        available = false;
        // Duas saídas, não uma: quem não tem personal destrava criando a
        // própria meta de frequência.
        unavailableReason = 'Precisa de uma ficha ou de uma meta de frequência semanal.';
      }
    }

    return {
      code: def.code,
      title: def.title,
      description: def.description,
      criterion: def.criterion,
      unlockedAt: row ? new Date(row.unlocked_at).toISOString() : null,
      evidence: row ? row.evidence_json : null,
      shared: row ? row.shared_at != null : false,
      available,
      unavailableReason,
    };
  });
}

/**
 * Registra a intenção explícita do titular sobre compartilhar um marco.
 *
 * Na C1 não existe superfície que leia `shared_at` — e está certo assim. O
 * consentimento precisa existir **antes** de qualquer consumidor, nunca depois:
 * modelar a intenção primeiro é o que impede que a C2 precise inferir vontade a
 * partir de dado que ninguém pediu.
 *
 * `userId` vem SEMPRE do token. Nenhuma rota aceita dono por parâmetro.
 */
export async function setMilestoneShared(
  userId: number,
  code: string,
  shared: boolean,
): Promise<MilestoneDto | null> {
  const def = findMilestone(code);
  if (!def) return null;

  const { rows } = await pool.query<{
    code: string;
    unlocked_at: Date;
    evidence_json: Record<string, unknown>;
    shared_at: Date | null;
  }>(
    `UPDATE user_milestones
        SET shared_at = CASE WHEN $3 THEN COALESCE(shared_at, now()) ELSE NULL END
      WHERE user_id = $1 AND code = $2
      RETURNING code, unlocked_at, evidence_json, shared_at`,
    [userId, code, shared],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    code: def.code,
    title: def.title,
    description: def.description,
    criterion: def.criterion,
    unlockedAt: new Date(row.unlocked_at).toISOString(),
    evidence: row.evidence_json,
    shared: row.shared_at != null,
    available: true,
    unavailableReason: null,
  };
}
