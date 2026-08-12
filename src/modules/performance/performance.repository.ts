/**
 * Acesso a dados do módulo Performance (Spec 033).
 *
 * ## O dia é o do ALUNO, não o do servidor
 *
 * O repositório do metabolismo usa `date_trunc('day', ts)`, que resolve no fuso
 * da sessão do Postgres (UTC na Render). Aqui isso não serve: um treino às 22h
 * de segunda em Brasília cairia na terça e o calendário mostraria o dia errado —
 * exatamente o defeito que `utils/appDay.ts` foi criado para corrigir.
 *
 * Por isso toda conversão passa por `(ts AT TIME ZONE $tz)::date`. Como essa
 * expressão não é sargable, cada query leva TAMBÉM um limite cru no timestamp
 * (`ts >= $rawSince`), com um dia de folga para cobrir qualquer offset: o índice
 * faz o range scan e o filtro exato do fuso trabalha só sobre o que sobrou.
 *
 * ## A armadilha do `timestamp` sem fuso
 *
 * As três fontes NÃO têm o mesmo tipo de coluna:
 *
 *   workout_sessions.performed_at    → timestamptz
 *   personal_session_logs.session_at → timestamptz
 *   user_workout_logs.completed_at   → timestamp SEM fuso  ← a exceção
 *
 * E `AT TIME ZONE` faz coisas OPOSTAS nos dois casos. Num `timestamptz` ele
 * converte o instante para a hora local do fuso pedido (o que queremos). Num
 * `timestamp` naive ele faz o inverso: interpreta o valor COMO SE já fosse
 * daquele fuso e devolve o instante UTC correspondente — empurrando a data três
 * horas para a FRENTE em vez de para trás.
 *
 * Na prática, o mesmo treino às 21h de Brasília era contado em dois dias
 * diferentes conforme a fonte, e o mesmo dia aparecia duas vezes no UNION —
 * inflando os dias ativos e o calendário. Por isso a coluna naive leva
 * `AT TIME ZONE 'UTC'` antes (ela é gravada em UTC por `CURRENT_TIMESTAMP` num
 * servidor UTC), promovendo-a a timestamptz, e só então a conversão para o fuso
 * do aluno. Ver `SOURCE_DAY_EXPR` abaixo — não inline essa expressão.
 *
 * ## As três fontes de "treinou nesse dia"
 *
 * `user_workout_logs` (log raso da gamificação), `workout_sessions` (execução
 * rica) e `personal_session_logs` (presença registrada pelo personal, Spec 009).
 * Contar só as duas primeiras faria o aluno acompanhado presencialmente parecer
 * ausente — foi por isso que a Spec 009 estabeleceu o UNION, e o dashboard do
 * personal já conta assim. Qualquer número de frequência que divergisse desse
 * conjunto criaria dois "dias ativos" diferentes no mesmo produto.
 */
import pool from '../../config/database';
import { APP_TIMEZONE, dayKey } from '../../utils/appDay';
import type { ActiveDay, ActiveDaySource } from './performance.types';

/** Folga aplicada ao limite cru para nenhum fuso cortar um dia de fronteira. */
const RAW_BOUND_SLACK_DAYS = 1;

/**
 * Dia do aluno a partir de uma coluna `timestamptz`.
 * `$2` é sempre o fuso do app nas queries deste arquivo.
 */
const dayFromTz = (col: string): string => `(${col} AT TIME ZONE $2)::date`;

/**
 * Dia do aluno a partir de uma coluna `timestamp` SEM fuso.
 * O `AT TIME ZONE 'UTC'` extra é obrigatório — ver a armadilha no topo.
 */
const dayFromNaive = (col: string): string => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE $2)::date`;

/** Expressão do dia para cada fonte, já com o tipo certo de cada coluna. */
const SOURCE_DAY_EXPR = {
  workoutLog: dayFromNaive('uwl.completed_at'),
  session: dayFromTz('ws.performed_at'),
  personalLog: dayFromTz('psl.session_at'),
  metrics: dayFromTz('m.performed_at'),
} as const;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * Dias distintos com atividade na janela, no fuso do aluno.
 * Um mesmo dia presente nas três fontes conta UMA vez (UNION, não UNION ALL).
 */
export async function countActiveDays(userId: number, windowDays: number): Promise<number> {
  const startKey = dayKey(new Date(Date.now() - (windowDays - 1) * 86_400_000));
  const rawSince = isoDaysAgo(windowDays + RAW_BOUND_SLACK_DAYS);

  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT d)::int AS n FROM (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl
        WHERE uwl.user_id = $1
          AND uwl.completed_at >= ($3::timestamptz AT TIME ZONE 'UTC')
          AND ${SOURCE_DAY_EXPR.workoutLog} >= $4::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND ws.performed_at >= $3::timestamptz
          AND ${SOURCE_DAY_EXPR.session} >= $4::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = $1
          AND psl.status IN ('present', 'partial')
          AND psl.session_at >= $3::timestamptz
          AND ${SOURCE_DAY_EXPR.personalLog} >= $4::date
     ) t`,
    [userId, APP_TIMEZONE, rawSince, startKey],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Prescrição vigente do aluno: o preset semanal da ficha ATIVA, e há quantos
 * dias o aluno está sob prescrição de forma geral.
 *
 * As duas coisas vêm de linhas diferentes de propósito.
 *
 * O preset tem que ser o da ficha ativa — é o que o personal prescreve hoje.
 * Mas a "idade" NÃO pode ser a dessa mesma linha: cada revisão de ficha cria uma
 * linha nova, e usar `created_at` dela zeraria o tempo de prescrição a cada
 * revisão. O efeito seria absurdo — o denominador dos 28 dias encolheria para o
 * de uma semana enquanto o numerador continua varrendo os 28 dias inteiros, e a
 * consistência saltaria para 100% no dia em que o personal revisou a ficha, sem
 * o aluno ter mudado nada. Revisar ficha é justamente o que o produto pede que
 * o personal faça com frequência.
 *
 * Por isso a idade sai da PRIMEIRA ficha que o aluno já teve (inclusive
 * abandonadas): é o marco de "desde quando existe prescrição para cobrar".
 * Mesmo espírito do `daysSinceAssigned` do `resolveMonthlyTarget`, que também
 * mede vínculo e não documento.
 */
export async function loadActivePlanTarget(
  userId: number,
): Promise<{ weekPreset: string | null; daysSinceStarted: number | null }> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT week_preset
          FROM personal_workout_plans
         WHERE student_id = $1 AND abandoned_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1) AS week_preset,
       (SELECT (EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 86400)::int
          FROM personal_workout_plans
         WHERE student_id = $1) AS days_since`,
    [userId],
  );
  return {
    weekPreset: rows[0]?.week_preset ?? null,
    daysSinceStarted: rows[0]?.days_since ?? null,
  };
}

/**
 * Sessões executadas na janela + sequência atual, numa ida só ao banco.
 *
 * As duas contas são baratas e independentes, mas cada `pool.query` ocupa uma
 * conexão, e o pool usa o default do `pg` (10). O overview é a tela de abertura
 * da Evolução: com uma query por métrica, poucas aberturas simultâneas já
 * enfileiravam requisição. Agrupar o que não depende de nada mantém o fan-out
 * do endpoint em duas conexões.
 *
 * A janela de sessões é contada em dias do ALUNO, para não descolar do
 * `activeDays28`, que é por dia do aluno — dois números vizinhos no mesmo
 * resumo não podem ter definições diferentes de "dia".
 */
export async function loadFreeSummaryCounters(
  userId: number,
  windowDays: number,
): Promise<{ sessionsInWindow: number; currentStreak: number }> {
  const startKey = dayKey(new Date(Date.now() - (windowDays - 1) * 86_400_000));
  const rawSince = isoDaysAgo(windowDays + RAW_BOUND_SLACK_DAYS);

  const { rows } = await pool.query<{ sessions: number; streak: number }>(
    `SELECT
       (SELECT COUNT(*)::int
          FROM workout_sessions ws
         WHERE ws.user_id = $1
           AND ws.status IN ('completed', 'partial')
           AND ws.performed_at >= $3::timestamptz
           AND ${SOURCE_DAY_EXPR.session} >= $4::date) AS sessions,
       (SELECT COALESCE(current_streak, 0)::int
          FROM user_gamification_stats
         WHERE user_id = $1) AS streak`,
    [userId, APP_TIMEZONE, rawSince, startKey],
  );
  return {
    sessionsInWindow: rows[0]?.sessions ?? 0,
    currentStreak: rows[0]?.streak ?? 0,
  };
}

/**
 * Calendário de um mês: um registro por dia com atividade, com as fontes que o
 * comprovam e as métricas do dia quando houver sessão executada.
 *
 * Só devolve dias ATIVOS — a grade completa do mês é montada no cliente, que já
 * sabe quantos dias o mês tem. Trafegar 30 linhas vazias seria desperdício.
 */
export async function loadMonthCalendar(
  userId: number,
  year: number,
  month: number,
): Promise<ActiveDay[]> {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;

  const { rows } = await pool.query<{
    d: string;
    sources: ActiveDaySource[];
    sets_done: string | null;
    tonnage_kg: string | null;
  }>(
    `WITH bounds AS (
       SELECT $3::date AS first_day, ($3::date + INTERVAL '1 month')::date AS next_month
     ),
     days AS (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d, 'log'::text AS src
         FROM user_workout_logs uwl, bounds b
        WHERE uwl.user_id = $1
          AND uwl.completed_at >= (b.first_day - INTERVAL '2 days')
          AND uwl.completed_at < (b.next_month + INTERVAL '2 days')
          AND ${SOURCE_DAY_EXPR.workoutLog} >= b.first_day
          AND ${SOURCE_DAY_EXPR.workoutLog} < b.next_month
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}, 'session'
         FROM workout_sessions ws, bounds b
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND ws.performed_at >= (b.first_day - INTERVAL '2 days')
          AND ws.performed_at < (b.next_month + INTERVAL '2 days')
          AND ${SOURCE_DAY_EXPR.session} >= b.first_day
          AND ${SOURCE_DAY_EXPR.session} < b.next_month
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}, 'personal'
         FROM personal_session_logs psl, bounds b
        WHERE psl.student_id = $1
          AND psl.status IN ('present', 'partial')
          AND psl.session_at >= (b.first_day - INTERVAL '2 days')
          AND psl.session_at < (b.next_month + INTERVAL '2 days')
          AND ${SOURCE_DAY_EXPR.personalLog} >= b.first_day
          AND ${SOURCE_DAY_EXPR.personalLog} < b.next_month
     ),
     metrics AS (
       SELECT ${SOURCE_DAY_EXPR.metrics} AS d,
              SUM(m.sets_done)::int AS sets_done,
              SUM(m.tonnage_kg) AS tonnage_kg
         FROM workout_session_metrics m, bounds b
        WHERE m.user_id = $1
          AND m.performed_at >= (b.first_day - INTERVAL '2 days')
          AND m.performed_at < (b.next_month + INTERVAL '2 days')
          AND ${SOURCE_DAY_EXPR.metrics} >= b.first_day
          AND ${SOURCE_DAY_EXPR.metrics} < b.next_month
        GROUP BY 1
     )
     SELECT d.d::text AS d,
            ARRAY_AGG(DISTINCT d.src) AS sources,
            MAX(mt.sets_done)::text AS sets_done,
            MAX(mt.tonnage_kg)::text AS tonnage_kg
       FROM days d
       LEFT JOIN metrics mt ON mt.d = d.d
      GROUP BY d.d
      ORDER BY d.d`,
    [userId, APP_TIMEZONE, first],
  );

  return rows.map((r) => ({
    date: r.d,
    active: true,
    sources: r.sources ?? [],
    setsDone: r.sets_done == null ? null : Number(r.sets_done),
    tonnageKg: r.tonnage_kg == null ? null : Number(r.tonnage_kg),
  }));
}
