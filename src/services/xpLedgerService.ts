/**
 * Ledger de XP — os valores e o teto vivem AQUI (Spec 034, Onda C0).
 *
 * ## A regra de ouro
 *
 * Nenhum valor de XP chega pelo corpo de requisição. O cliente relata FATOS
 * (treinei, corri); o servidor decide o que cada fato vale, consultando esta
 * tabela de regras — que é constante versionada, não configuração. Antes da C0
 * cada tela decidia o próprio prêmio, e um cliente modificado imprimia moeda.
 *
 * ## O que o desenho garante
 *
 * - **Idempotência** por `event_key` único: o mesmo fato pago uma vez só, por
 *   construção do banco, não por disciplina de código.
 * - **Cap por tipo e por dia** (`perDay`) e **cap diário global** (`DAILY_CAP`):
 *   treinar três vezes no dia não paga três vezes; o excedente simplesmente não
 *   entra no ledger. Sem mensagem de punição — o treino continua registrado,
 *   só a moeda satura.
 * - **Sem débito**: `amount > 0` é CHECK do banco. Ausência não retira XP, e
 *   não existe caminho de redução — é a regra de produto "sem punição" virando
 *   invariante.
 *
 * ## Concorrência
 *
 * `awardXpTx` roda dentro da transação do chamador e serializa por usuário com
 * `FOR UPDATE` na linha de stats (que o fluxo de check-in já garante existir).
 * Duas sessões simultâneas não estouram o cap: a segunda espera a primeira.
 */
import type { PoolClient } from 'pg';

/** Versão das regras. Recalibrar valores = nova versão, nunca edição muda. */
export const XP_RULES_VERSION = 1;

export type XpKind =
  | 'workout_session'
  | 'activity'
  | 'weekly_goal'
  | 'pr'
  | 'challenge_completed'
  | 'milestone';

interface XpRule {
  amount: number;
  /** Máximo de créditos deste tipo por dia do aluno. `null` = sem teto por tipo. */
  perDay: number | null;
  /**
   * Evento único na vida (marco, desafio): ou paga inteiro, ou não paga.
   *
   * Sem isto, um marco que desbloqueia num dia com 5 de folga receberia 5 dos
   * 10 XP e gravaria a chave — e como a chave é única, ele ficaria pago pela
   * metade para sempre. Recusar hoje deixa a repescagem do dia seguinte
   * funcionar, que é o que a documentação do módulo promete.
   */
  allOrNothing?: boolean;
}

/**
 * Teto diário global. Com sessão (30) + atividade (20) o dia normal fecha em
 * 50; o teto só morde quem acumula fatos extraordinários no mesmo dia — e é
 * para isso que ele existe.
 */
export const XP_DAILY_CAP = 60;

/**
 * Só `workout_session` e `activity` são pagos na C0. Os demais tipos já têm
 * regra para as ondas seguintes não redefinirem valores em outro lugar —
 * espalhar número de XP pelo código é a versão nova do bug que a C0 mata.
 */
export const XP_RULES: Readonly<Record<XpKind, XpRule>> = Object.freeze({
  workout_session: Object.freeze({ amount: 30, perDay: 1 }),
  activity: Object.freeze({ amount: 20, perDay: 1 }),
  weekly_goal: Object.freeze({ amount: 20, perDay: 1 }),
  pr: Object.freeze({ amount: 15, perDay: 2 }),
  challenge_completed: Object.freeze({ amount: 50, perDay: null, allOrNothing: true }),
  milestone: Object.freeze({ amount: 10, perDay: null, allOrNothing: true }),
});

/**
 * Quanto pagar, dado o que já foi pago hoje. Pura — é a aritmética do teto,
 * separada do I/O para ser testável sem banco.
 */
export function resolveAwardAmount(
  kind: XpKind,
  kindCountToday: number,
  totalAwardedToday: number,
): number {
  const rule = XP_RULES[kind];
  if (rule.perDay != null && kindCountToday >= rule.perDay) return 0;
  const remaining = XP_DAILY_CAP - totalAwardedToday;
  if (remaining <= 0) return 0;
  if (rule.allOrNothing) return remaining >= rule.amount ? rule.amount : 0;
  return Math.min(rule.amount, remaining);
}

export interface AwardXpInput {
  userId: number;
  kind: XpKind;
  /** Chave natural do fato: `session:{id}`, `workout-day:{userId}:{dia}`… */
  eventKey: string;
  /** Dia do ALUNO (`dayKey`), nunca UTC — é a base do cap diário. */
  dateKey: string;
}

/**
 * Credita o evento e devolve o valor pago (0 = duplicado ou teto atingido).
 *
 * NÃO abre transação nem atualiza o saldo agregado — o chamador é dono das
 * duas coisas, exatamente como em `applyGamificationCheckinTx`. Devolver 0 em
 * vez de lançar é decisão de produto: teto e duplicata não são erros do
 * usuário, são o sistema funcionando.
 */
export async function awardXpTx(client: PoolClient, input: AwardXpInput): Promise<number> {
  // Serializa por usuário: a linha de stats já existe (o check-in a garante) e
  // segurar o lock dela até o COMMIT impede duas concessões de estourar o cap.
  await client.query(`SELECT 1 FROM user_gamification_stats WHERE user_id = $1 FOR UPDATE`, [
    input.userId,
  ]);

  const { rows } = await client.query<{ kind_count: number; total: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE kind = $2)::int AS kind_count,
       COALESCE(SUM(amount), 0)::int AS total
     FROM xp_events
     WHERE user_id = $1 AND awarded_on = $3::date`,
    [input.userId, input.kind, input.dateKey],
  );

  const amount = resolveAwardAmount(
    input.kind,
    Number(rows[0]?.kind_count ?? 0),
    Number(rows[0]?.total ?? 0),
  );
  if (amount <= 0) return 0;

  // O UNIQUE em event_key decide a idempotência: replay não insere e paga 0.
  const inserted = await client.query(
    `INSERT INTO xp_events (user_id, kind, amount, event_key, awarded_on)
     VALUES ($1, $2, $3, $4, $5::date)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [input.userId, input.kind, amount, input.eventKey, input.dateKey],
  );
  return inserted.rows.length > 0 ? amount : 0;
}
