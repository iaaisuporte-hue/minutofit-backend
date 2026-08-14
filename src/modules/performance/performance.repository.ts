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
import type { PoolClient } from 'pg';

import { weeklyTargetFromPreset } from '../../services/personalDashboardService';
import { pickWeeklyTarget, type WeeklyFrequencyTarget } from './consistency.engine';

import pool from '../../config/database';
import { APP_TIMEZONE, dayKey } from '../../utils/appDay';
import {
  FORMULA_VERSION,
  PROGRESSION_MIN_POINTS_PER_WINDOW,
  SCORE_SESSION_LOOKBACK_DAYS,
} from './performance.constants';
import { bestKey, type CurrentBests, type PrDetection, type PrKind } from './pr.engine';
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
 * Dias ativos DENTRO de um período fechado (Onda P4).
 *
 * Gêmea de `countActiveDays`, com a mesma UNION das três fontes — o que muda é
 * a fronteira: aqui o período tem início E fim, porque metas de frequência
 * medem semana ou mês de calendário, não "os últimos N dias". Uma meta de "4
 * treinos por semana" avaliada por janela deslizante nunca zeraria na segunda,
 * e o aluno veria a semana passada empurrando a atual.
 *
 * Reaproveitar a UNION não é economia de linhas: é a garantia de que a meta e a
 * aba Consistência concordam sobre o que é um dia treinado. Duas definições
 * criariam um produto onde a meta diz 3 e o calendário mostra 4.
 */
export async function countActiveDaysBetween(
  userId: number,
  fromDay: string,
  toDay: string,
): Promise<number> {
  const rawSince = `${fromDay}T00:00:00Z`;

  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT d)::int AS n FROM (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl
        WHERE uwl.user_id = $1
          AND uwl.completed_at >= ($3::timestamptz AT TIME ZONE 'UTC') - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.workoutLog} BETWEEN $4::date AND $5::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND ws.performed_at >= $3::timestamptz - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.session} BETWEEN $4::date AND $5::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = $1
          AND psl.status IN ('present', 'partial')
          AND psl.session_at >= $3::timestamptz - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.personalLog} BETWEEN $4::date AND $5::date
     ) t`,
    [userId, APP_TIMEZONE, rawSince, fromDay, toDay],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Os DIAS em si, não a contagem (Spec 034, C1).
 *
 * Os marcos precisam da forma da presença — onde estão os buracos, quais
 * semanas fecharam, quando começou a pausa —, e isso não cabe num inteiro. A
 * UNION é a mesma de `countActiveDays`: reusar a expressão é o que garante que
 * um marco de "semana completa" e a aba Consistência nunca discordem sobre o
 * que é um dia treinado.
 */
export async function listActiveDays(
  userId: number,
  fromDay: string,
  toDay: string,
): Promise<string[]> {
  const rawSince = `${fromDay}T00:00:00Z`;

  const { rows } = await pool.query<{ d: string }>(
    // `to_char` em vez de confiar no driver: o `pg` desserializa DATE como
    // objeto Date, e formatá-lo no JS reintroduz fuso numa string que é, por
    // definição, um dia de calendário sem hora.
    `SELECT to_char(d, 'YYYY-MM-DD') AS d FROM (SELECT DISTINCT d FROM (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl
        WHERE uwl.user_id = $1
          AND uwl.completed_at >= ($3::timestamptz AT TIME ZONE 'UTC') - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.workoutLog} BETWEEN $4::date AND $5::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND ws.performed_at >= $3::timestamptz - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.session} BETWEEN $4::date AND $5::date
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = $1
          AND psl.status IN ('present', 'partial')
          AND psl.session_at >= $3::timestamptz - INTERVAL '2 days'
          AND ${SOURCE_DAY_EXPR.personalLog} BETWEEN $4::date AND $5::date
     ) t) u
     ORDER BY d`,
    [userId, APP_TIMEZONE, rawSince, fromDay, toDay],
  );
  return rows.map((r) => r.d);
}

/**
 * Último dia treinado ANTES de uma data (Spec 034, C1).
 *
 * Existe por causa do marco de retomada: uma pausa de 21 dias pode ter começado
 * fora da janela de avaliação, e sem esta âncora o primeiro treino da janela
 * pareceria não ter passado nenhum. Sem limite inferior de propósito — a
 * pergunta é "quando foi a última vez". O teto de um ano existe para a query
 * não varrer o histórico inteiro nas três tabelas a cada leitura: uma pausa
 * maior que isso é indistinguível de uma pausa de um ano para o marco.
 */
export async function findLastActiveDayBefore(
  userId: number,
  day: string,
  lookbackDays = 365,
): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    `SELECT to_char(MAX(d), 'YYYY-MM-DD') AS d FROM (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl
        WHERE uwl.user_id = $1
          AND ${SOURCE_DAY_EXPR.workoutLog} < $3::date
          AND ${SOURCE_DAY_EXPR.workoutLog} >= $3::date - $4::int
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND ${SOURCE_DAY_EXPR.session} < $3::date
          AND ${SOURCE_DAY_EXPR.session} >= $3::date - $4::int
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = $1
          AND psl.status IN ('present', 'partial')
          AND ${SOURCE_DAY_EXPR.personalLog} < $3::date
          AND ${SOURCE_DAY_EXPR.personalLog} >= $3::date - $4::int
     ) t`,
    [userId, APP_TIMEZONE, day, lookbackDays],
  );
  return rows[0]?.d ?? null;
}

/**
 * Dias ativos por USUÁRIO e por SEMANA ISO, numa query só (Spec 034, C2).
 *
 * As faixas de um desafio precisam do progresso de todos os participantes. Com
 * uma consulta por pessoa e por semana, um desafio de 20 pessoas × 4 semanas
 * custaria ~120 idas ao banco num endpoint de LEITURA — sobre um pool de 10
 * conexões, isso não é lentidão, é indisponibilidade.
 *
 * A UNIÃO é a mesma de `countActiveDaysBetween`; o que muda é o agrupamento.
 * A segunda-feira sai de ARITMÉTICA sobre a data já convertida
 * (`d - (ISODOW - 1)`), não de `date_trunc`: a invariante deste módulo proíbe
 * `date_trunc` nas queries de consistência porque, sobre um timestamp, ele
 * resolveria no fuso do SERVIDOR. Aritmética sobre `date` não tem fuso — e o
 * resultado bate com `startOfIsoWeek` do TypeScript.
 */
export async function loadActiveDaysByUserWeek(
  userIds: number[],
  fromDay: string,
  toDay: string,
): Promise<Map<number, Map<string, number>>> {
  const saida = new Map<number, Map<string, number>>();
  if (userIds.length === 0) return saida;

  const rawSince = `${fromDay}T00:00:00Z`;
  const { rows } = await pool.query<{ user_id: number; week: string; n: number }>(
    `SELECT user_id,
            to_char(d - (EXTRACT(ISODOW FROM d)::int - 1), 'YYYY-MM-DD') AS week,
            COUNT(*)::int AS n
       FROM (
         SELECT DISTINCT user_id, d FROM (
           SELECT uwl.user_id AS user_id, ${SOURCE_DAY_EXPR.workoutLog} AS d
             FROM user_workout_logs uwl
            WHERE uwl.user_id = ANY($1::int[])
              AND uwl.completed_at >= ($3::timestamptz AT TIME ZONE 'UTC') - INTERVAL '2 days'
              AND ${SOURCE_DAY_EXPR.workoutLog} BETWEEN $4::date AND $5::date
           UNION
           SELECT ws.user_id, ${SOURCE_DAY_EXPR.session}
             FROM workout_sessions ws
            WHERE ws.user_id = ANY($1::int[])
              AND ws.status IN ('completed', 'partial')
              AND ws.performed_at >= $3::timestamptz - INTERVAL '2 days'
              AND ${SOURCE_DAY_EXPR.session} BETWEEN $4::date AND $5::date
           UNION
           SELECT psl.student_id, ${SOURCE_DAY_EXPR.personalLog}
             FROM personal_session_logs psl
            WHERE psl.student_id = ANY($1::int[])
              AND psl.status IN ('present', 'partial')
              AND psl.session_at >= $3::timestamptz - INTERVAL '2 days'
              AND ${SOURCE_DAY_EXPR.personalLog} BETWEEN $4::date AND $5::date
         ) t
       ) u
      GROUP BY user_id, d - (EXTRACT(ISODOW FROM d)::int - 1)`,
    // $2 é SEMPRE o fuso neste arquivo — é o que `SOURCE_DAY_EXPR` assume.
    [userIds, APP_TIMEZONE, rawSince, fromDay, toDay],
  );

  for (const r of rows) {
    if (!saida.has(r.user_id)) saida.set(r.user_id, new Map());
    saida.get(r.user_id)!.set(r.week, Number(r.n));
  }
  return saida;
}

/**
 * Último dia treinado antes de uma data, para VÁRIOS usuários (Spec 034, C3).
 *
 * Existe para o painel institucional de um desafio de RETOMADA: sem a pausa de
 * cada participante, o engine devolve `null` para todos e o gestor vê a turma
 * inteira como "sem atividade" — um painel que mede errado é pior que um painel
 * ausente. Uma query para o grupo, no lugar de uma por pessoa.
 */
export async function loadLastActiveDayBeforeForUsers(
  userIds: number[],
  day: string,
  lookbackDays = 365,
): Promise<Map<number, string>> {
  const saida = new Map<number, string>();
  if (userIds.length === 0) return saida;

  const { rows } = await pool.query<{ user_id: number; d: string | null }>(
    `SELECT user_id, to_char(MAX(d), 'YYYY-MM-DD') AS d FROM (
       SELECT uwl.user_id AS user_id, ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl
        WHERE uwl.user_id = ANY($1::int[])
          AND ${SOURCE_DAY_EXPR.workoutLog} < $3::date
          AND ${SOURCE_DAY_EXPR.workoutLog} >= $3::date - $4::int
       UNION
       SELECT ws.user_id, ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = ANY($1::int[])
          AND ws.status IN ('completed', 'partial')
          AND ${SOURCE_DAY_EXPR.session} < $3::date
          AND ${SOURCE_DAY_EXPR.session} >= $3::date - $4::int
       UNION
       SELECT psl.student_id, ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = ANY($1::int[])
          AND psl.status IN ('present', 'partial')
          AND ${SOURCE_DAY_EXPR.personalLog} < $3::date
          AND ${SOURCE_DAY_EXPR.personalLog} >= $3::date - $4::int
     ) t
     GROUP BY user_id`,
    [userIds, APP_TIMEZONE, day, lookbackDays],
  );

  for (const r of rows) if (r.d) saida.set(r.user_id, r.d);
  return saida;
}

/**
 * Alvo semanal de VÁRIOS usuários — duas queries, não duas por pessoa.
 *
 * Mesma precedência de `loadWeeklyFrequencyTarget` (ficha → meta → null), pela
 * mesma função pura: a regra continua num lugar só, o que muda é o número de
 * viagens ao banco.
 */
export async function loadWeeklyTargetsForUsers(
  userIds: number[],
): Promise<Map<number, WeeklyFrequencyTarget>> {
  const saida = new Map<number, WeeklyFrequencyTarget>();
  if (userIds.length === 0) return saida;

  const [planos, metas] = await Promise.all([
    pool.query<{ student_id: number; week_preset: string | null; active_since: string | null; days_since: number | null }>(
      `SELECT DISTINCT ON (student_id)
              student_id, week_preset,
              to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS active_since,
              (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::int AS days_since
         FROM personal_workout_plans
        WHERE student_id = ANY($1::int[]) AND abandoned_at IS NULL
        ORDER BY student_id, created_at DESC`,
      [userIds, APP_TIMEZONE],
    ),
    pool.query<{ user_id: number; target: string | null; since: string | null; days_since: number | null }>(
      `SELECT user_id, MAX(target_value)::text AS target,
              to_char(MIN(starts_on), 'YYYY-MM-DD') AS since,
              (CURRENT_DATE - MIN(starts_on))::int AS days_since
         FROM user_performance_goals
        WHERE user_id = ANY($1::int[]) AND kind = 'weekly_frequency' AND status = 'active'
        GROUP BY user_id`,
      [userIds],
    ),
  ]);

  const porPlano = new Map(planos.rows.map((r) => [r.student_id, r]));
  const porMeta = new Map(metas.rows.map((r) => [r.user_id, r]));

  for (const id of userIds) {
    const p = porPlano.get(id);
    const m = porMeta.get(id);
    saida.set(
      id,
      pickWeeklyTarget(
        {
          weeklyTarget: weeklyTargetFromPreset(p?.week_preset ?? null),
          since: p?.active_since ?? null,
          daysSinceStarted: p?.days_since ?? null,
        },
        {
          weeklyTarget: m?.target != null ? Number(m.target) : null,
          since: m?.since ?? null,
          daysSinceStarted: m?.days_since ?? null,
        },
      ),
    );
  }
  return saida;
}

/**
 * PRIMEIRO dia com treino, de todos os tempos (Spec 034, C1).
 *
 * Usa a mesma UNION das três fontes. Sem isto, o marco de primeiro treino
 * olharia só `workout_sessions` enquanto os marcos de semana olham a união — e
 * o aluno acompanhado presencialmente (Spec 009, a cunha de entrada do produto)
 * ganharia "primeira semana completa" continuando sem "primeiro treino". A
 * conquista avançada apareceria antes da inicial.
 */
export async function findFirstActiveDay(userId: number): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    `SELECT to_char(MIN(d), 'YYYY-MM-DD') AS d FROM (
       SELECT ${SOURCE_DAY_EXPR.workoutLog} AS d
         FROM user_workout_logs uwl WHERE uwl.user_id = $1
       UNION
       SELECT ${SOURCE_DAY_EXPR.session}
         FROM workout_sessions ws
        WHERE ws.user_id = $1 AND ws.status IN ('completed', 'partial')
       UNION
       SELECT ${SOURCE_DAY_EXPR.personalLog}
         FROM personal_session_logs psl
        WHERE psl.student_id = $1 AND psl.status IN ('present', 'partial')
     ) t`,
    [userId, APP_TIMEZONE],
  );
  return rows[0]?.d ?? null;
}

/**
 * Melhor série já feita no exercício, com carga mínima exigida.
 *
 * Serve a meta "30 kg × 12 reps", que é o único tipo com dois alvos: a query
 * filtra as séries que bateram a CARGA e devolve o maior número de repetições
 * entre elas. É por isso que 35 kg × 8 não cumpre a meta — 8 nunca chega a 12,
 * por mais que o e1RM seja superior. A meta pedia repetições naquela carga, e
 * essa é literalmente a pergunta que a query faz.
 */
export async function loadBestRepsAtLoad(
  userId: number,
  exerciseId: string,
  minLoadKg: number,
): Promise<number | null> {
  const { rows } = await pool.query<{ best: number | null }>(
    `SELECT MAX(sl.reps_done)::int AS best
       FROM workout_set_logs sl
       JOIN workout_sessions ws ON ws.id = sl.session_id
      WHERE ws.user_id = $1
        AND ws.status IN ('completed', 'partial')
        AND sl.exercise_id = $2::uuid
        AND sl.status = 'done'
        AND sl.reps_done IS NOT NULL
        AND sl.load_done_kg IS NOT NULL
        AND sl.load_done_kg >= $3::numeric`,
    [userId, exerciseId, minLoadKg],
  );
  return rows[0]?.best ?? null;
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
): Promise<{ weekPreset: string | null; daysSinceStarted: number | null; activeSince: string | null }> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT week_preset
          FROM personal_workout_plans
         WHERE student_id = $1 AND abandoned_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1) AS week_preset,
       -- Desde quando a ficha ATIVA vale (Spec 034, C1). Sem isso, o alvo de
       -- hoje seria aplicado a meses de passado: trocar a ficha de 5x para 3x
       -- concederia marcos retroativos sob um alvo que nunca vigorou naquelas
       -- semanas — evidência internamente coerente e factualmente errada.
       (SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD')
          FROM personal_workout_plans
         WHERE student_id = $1 AND abandoned_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1) AS active_since,
       (SELECT (EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 86400)::int
          FROM personal_workout_plans
         WHERE student_id = $1) AS days_since`,
    [userId, APP_TIMEZONE],
  );
  return {
    weekPreset: rows[0]?.week_preset ?? null,
    daysSinceStarted: rows[0]?.days_since ?? null,
    activeSince: rows[0]?.active_since ?? null,
  };
}

/**
 * O alvo semanal VIGENTE — a fonte única (Spec 033 + hardening pré-C2).
 *
 * Antes, cada consumidor combinava `loadActivePlanTarget` com
 * `weeklyTargetFromPreset` por conta própria: a aba Consistência, o Progress
 * Score e os marcos repetiam a mesma composição em cinco lugares. Bastava um
 * deles ganhar o fallback de meta pessoal para o produto passar a exibir dois
 * denominadores diferentes para o mesmo aluno — o defeito recorrente deste
 * repositório. Agora quem precisa do alvo chama ISTO, e a precedência vive num
 * lugar só (`pickWeeklyTarget`).
 *
 * Entre metas de frequência ativas, vale a MAIOR: com várias declaradas, usar a
 * menor deixaria a consistência subir só por existir uma meta modesta ao lado
 * de uma ambiciosa.
 */
export async function loadWeeklyFrequencyTarget(
  userId: number,
): Promise<WeeklyFrequencyTarget> {
  const [plan, goalRes] = await Promise.all([
    loadActivePlanTarget(userId),
    pool.query<{ target: string | null; since: string | null; days_since: number | null }>(
      `SELECT MAX(target_value)::text AS target,
              to_char(MIN(starts_on), 'YYYY-MM-DD') AS since,
              (CURRENT_DATE - MIN(starts_on))::int AS days_since
         FROM user_performance_goals
        WHERE user_id = $1 AND kind = 'weekly_frequency' AND status = 'active'`,
      [userId],
    ),
  ]);

  const meta = goalRes.rows[0];
  const metaAlvo = meta?.target != null ? Number(meta.target) : null;

  return pickWeeklyTarget(
    {
      weeklyTarget: weeklyTargetFromPreset(plan.weekPreset),
      since: plan.activeSince,
      daysSinceStarted: plan.daysSinceStarted,
    },
    {
      weeklyTarget: metaAlvo != null && Number.isFinite(metaAlvo) ? metaAlvo : null,
      since: meta?.since ?? null,
      daysSinceStarted: meta?.days_since ?? null,
    },
  );
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

// ── Recordes (P2) ──────────────────────────────────────────────────────────

/**
 * Melhor valor já registrado por `(exercício, categoria)` para os exercícios
 * informados. Uma query só — nada de laço por exercício.
 *
 * Linhas órfãs (`exercise_id IS NULL`, exercício removido do catálogo) nunca
 * casam com `= ANY(...)` e por isso não interferem: o histórico do exercício
 * apagado repousa, e um exercício novo com o mesmo nome começa do zero.
 */
export async function loadCurrentPrBests(
  client: PoolClient,
  userId: number,
  exerciseIds: string[],
): Promise<CurrentBests> {
  const bests: CurrentBests = new Map();
  if (exerciseIds.length === 0) return bests;

  const { rows } = await client.query<{ exercise_id: string; kind: PrKind; best: string }>(
    `SELECT exercise_id, kind, MAX(value) AS best
       FROM user_pr_events
      WHERE user_id = $1 AND exercise_id = ANY($2::uuid[])
      GROUP BY exercise_id, kind`,
    [userId, exerciseIds],
  );
  for (const r of rows) bests.set(bestKey(r.exercise_id, r.kind), Number(r.best));
  return bests;
}

/**
 * Serializa a detecção de recordes de UM usuário dentro da transação corrente.
 *
 * Sem isto, duas sessões do mesmo aluno processadas ao mesmo tempo leriam o
 * mesmo "melhor atual" e ambas se achariam recorde: a segunda gravaria
 * `previous_value` desatualizado, descrevendo uma progressão que não aconteceu
 * (70 → 80 e 70 → 75, em vez de 70 → 75 → 80). O `UNIQUE` do banco impede a
 * duplicata exata, mas não conserta a narrativa.
 *
 * Escolhi advisory lock transacional em vez de `SELECT ... FOR UPDATE` porque
 * não há linha para travar quando o recorde é o primeiro do exercício — travar
 * ausência exigiria bloqueio de faixa, que no Postgres significa nível de
 * isolamento serializável e retry no chamador. O lock é liberado no
 * COMMIT/ROLLBACK, é o mesmo mecanismo que a idempotência de conclusão já usa
 * (`workout-session:`), e o escopo por usuário é estreito: sessões simultâneas
 * do MESMO aluno são raras, e de alunos diferentes não se encontram.
 */
export async function lockPrDetection(client: PoolClient, userId: number): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pr-detect:${userId}`]);
}

/** Grava os recordes detectados. `ON CONFLICT` é rede de segurança, não a regra. */
export async function insertPrEvents(
  client: PoolClient,
  userId: number,
  sessionId: number,
  achievedAt: Date | string,
  detections: PrDetection[],
): Promise<number> {
  let inserted = 0;
  for (const d of detections) {
    const res = await client.query(
      `INSERT INTO user_pr_events
         (user_id, exercise_id, exercise_name, kind, value, reps, load_kg,
          previous_value, is_first, session_id, achieved_at, formula_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, exercise_id, kind, value) DO NOTHING`,
      [
        userId,
        d.exerciseId,
        d.exerciseName,
        d.kind,
        d.value,
        d.reps,
        d.loadKg,
        d.previousValue,
        d.isFirst,
        sessionId,
        achievedAt,
        FORMULA_VERSION,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** Uma linha de recorde, já no formato que o serviço entrega. */
export interface PrRecordRow {
  exerciseId: string | null;
  exerciseName: string;
  kind: PrKind;
  value: number;
  reps: number | null;
  loadKg: number | null;
  previousValue: number | null;
  isFirst: boolean;
  achievedAt: string;
  sessionId: number | null;
  /** false quando o exercício saiu do catálogo — o recorde continua valendo. */
  exerciseInCatalog: boolean;
}

/**
 * Recorde ATUAL de cada `(exercício, categoria)` — o topo do ledger.
 *
 * `DISTINCT ON` resolve em uma passada: ordena por valor decrescente dentro do
 * grupo e fica com a primeira linha. Uma query, sem laço por exercício.
 *
 * O agrupamento é por `(exercise_id, exercise_name)` e não só por `exercise_id`:
 * exercícios removidos ficam todos com `NULL`, e agrupar só pelo id fundiria
 * recordes de exercícios diferentes num único bloco sem nome.
 *
 * `LEFT JOIN exercises` é contrato, não preferência: com `INNER JOIN` sumiriam
 * exatamente os recordes órfãos — os que mais importam preservar, porque não há
 * como reconstruí-los.
 */
export async function loadCurrentPrRecords(
  userId: number,
  opts: { exerciseId?: string | null; kind?: PrKind | null } = {},
): Promise<PrRecordRow[]> {
  const params: unknown[] = [userId];
  let filters = '';
  if (opts.exerciseId) {
    params.push(opts.exerciseId);
    filters += ` AND p.exercise_id = $${params.length}::uuid`;
  }
  if (opts.kind) {
    params.push(opts.kind);
    filters += ` AND p.kind = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (p.exercise_id, p.exercise_name, p.kind)
            p.exercise_id, p.exercise_name, p.kind, p.value, p.reps, p.load_kg,
            p.previous_value, p.is_first, p.achieved_at, p.session_id,
            (e.id IS NOT NULL) AS exercise_in_catalog
       FROM user_pr_events p
       LEFT JOIN exercises e ON e.id = p.exercise_id
      WHERE p.user_id = $1${filters}
      ORDER BY p.exercise_id, p.exercise_name, p.kind, p.value DESC, p.achieved_at DESC`,
    params,
  );
  return rows.map(mapPrRow);
}

/** Linha do tempo de conquistas, da mais recente para trás. */
export async function loadRecentPrEvents(
  userId: number,
  limit: number,
  opts: { sinceDays?: number | null } = {},
): Promise<PrRecordRow[]> {
  const params: unknown[] = [userId];
  let sinceFilter = '';
  if (opts.sinceDays != null) {
    params.push(isoDaysAgo(opts.sinceDays));
    sinceFilter = ` AND p.achieved_at >= $${params.length}::timestamptz`;
  }
  params.push(Math.min(100, Math.max(1, limit)));

  const { rows } = await pool.query(
    `SELECT p.exercise_id, p.exercise_name, p.kind, p.value, p.reps, p.load_kg,
            p.previous_value, p.is_first, p.achieved_at, p.session_id,
            (e.id IS NOT NULL) AS exercise_in_catalog
       FROM user_pr_events p
       LEFT JOIN exercises e ON e.id = p.exercise_id
      WHERE p.user_id = $1${sinceFilter}
      ORDER BY p.achieved_at DESC, p.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapPrRow);
}

function mapPrRow(r: Record<string, unknown>): PrRecordRow {
  return {
    exerciseId: (r.exercise_id as string | null) ?? null,
    exerciseName: String(r.exercise_name),
    kind: r.kind as PrKind,
    value: Number(r.value),
    reps: r.reps == null ? null : Number(r.reps),
    loadKg: r.load_kg == null ? null : Number(r.load_kg),
    previousValue: r.previous_value == null ? null : Number(r.previous_value),
    isFirst: r.is_first === true,
    achievedAt: new Date(r.achieved_at as string).toISOString(),
    sessionId: r.session_id == null ? null : Number(r.session_id),
    exerciseInCatalog: r.exercise_in_catalog === true,
  };
}

/** Ponto diário da progressão de um exercício. */
export interface ProgressionPoint {
  date: string;
  maxLoadKg: number | null;
  bestE1rm: number | null;
  tonnageKg: number | null;
  topSetReps: number | null;
}

export interface ProgressionSeries {
  exerciseId: string;
  name: string;
  points: ProgressionPoint[];
}

/**
 * Série temporal por exercício, agregada POR DIA no fuso do aluno.
 *
 * Uma query para todos os exercícios da janela — o cliente escolhe qual exibir
 * sem nova ida ao servidor, e não existe laço por exercício em lugar nenhum.
 *
 * Agrega no banco de propósito: mandar log de série cru para o navegador seria
 * ordens de grandeza mais tráfego para desenhar exatamente a mesma linha, e o
 * cálculo de e1RM precisa ser o mesmo dos recordes — backend é a autoridade.
 *
 * O e1RM usa a mesma fórmula (Epley, guarda de 1..12 repetições) do
 * `e1rm.engine.ts` e do backfill. São três implementações da mesma regra por
 * necessidade — TS puro, SQL de agregação e SQL de backfill — e o teste de
 * integração compara as três sobre os mesmos dados.
 */
export async function loadProgressionSeries(
  userId: number,
  windowDays: number,
  exerciseId?: string | null,
): Promise<ProgressionSeries[]> {
  const params: unknown[] = [userId, APP_TIMEZONE, isoDaysAgo(windowDays)];
  let exerciseFilter = '';
  if (exerciseId) {
    params.push(exerciseId);
    exerciseFilter = ` AND sl.exercise_id = $${params.length}::uuid`;
  }

  const { rows } = await pool.query(
    `SELECT sl.exercise_id,
            MIN(sl.exercise_name) AS exercise_name,
            ${SOURCE_DAY_EXPR.session}::text AS d,
            MAX(sl.load_done_kg) FILTER (WHERE sl.load_done_kg > 0) AS max_load,
            MAX(ROUND((sl.load_done_kg * (1 + sl.reps_done / 30.0)) * 2) / 2)
              FILTER (WHERE sl.load_done_kg > 0 AND sl.reps_done BETWEEN 1 AND 12) AS best_e1rm,
            SUM(sl.reps_done * sl.load_done_kg)
              FILTER (WHERE sl.load_done_kg > 0 AND sl.reps_done IS NOT NULL) AS tonnage,
            MAX(sl.reps_done) AS top_reps
       FROM workout_set_logs sl
       JOIN workout_sessions ws ON ws.id = sl.session_id
      WHERE ws.user_id = $1
        AND ws.status IN ('completed', 'partial')
        AND ws.performed_at >= $3::timestamptz
        AND sl.status = 'done'
        AND sl.exercise_id IS NOT NULL${exerciseFilter}
      GROUP BY sl.exercise_id, ${SOURCE_DAY_EXPR.session}
      ORDER BY sl.exercise_id, d`,
    params,
  );

  const byExercise = new Map<string, ProgressionSeries>();
  for (const r of rows) {
    const id = String(r.exercise_id);
    let series = byExercise.get(id);
    if (!series) {
      series = { exerciseId: id, name: String(r.exercise_name), points: [] };
      byExercise.set(id, series);
    }
    series.points.push({
      date: String(r.d),
      maxLoadKg: r.max_load == null ? null : Number(r.max_load),
      bestE1rm: r.best_e1rm == null ? null : Number(r.best_e1rm),
      tonnageKg: r.tonnage == null ? null : Number(r.tonnage),
      topSetReps: r.top_reps == null ? null : Number(r.top_reps),
    });
  }
  return Array.from(byExercise.values());
}

// ── Progress Score e carga (P3) ────────────────────────────────────────────

/** Tudo que o Progress Score precisa do banco, em UMA viagem. */
export interface ScoreWindowAggregates {
  accountAgeDays: number | null;
  sessionsInLookback: number;
  daysSinceLastSession: number | null;
  tonnageCurrent: number | null;
  tonnagePrevious: number | null;
  prCount: number;
  loadSum7d: number | null;
  loadSum28d: number | null;
  sessionsWithLoad28d: number;
}

/**
 * Agregados das duas janelas do score numa query só.
 *
 * São nove números vindos de cinco tabelas. Como subconsultas escalares
 * independentes, o Postgres resolve tudo num plano e o endpoint gasta UMA
 * conexão — a alternativa (uma query por número) multiplicaria por nove o
 * fan-out da tela de abertura da Evolução.
 *
 * Todas as janelas usam `performed_at` (data canônica da execução) e o teto
 * cru em timestamptz, que é sargable e usa `idx_wsm_user_performed`.
 *
 * NULL é preservado de ponta a ponta: `SUM` sobre zero linhas devolve NULL, e
 * é isso que o engine precisa receber para não confundir "sem tonelagem" com
 * "tonelagem zero".
 */
export async function loadScoreAggregates(
  userId: number,
  windowDays: number,
): Promise<ScoreWindowAggregates> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::int
          FROM users WHERE id = $1) AS account_age_days,

       (SELECT COUNT(*)::int
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - ($3::int || ' days')::interval) AS sessions_lookback,

       (SELECT (EXTRACT(EPOCH FROM (NOW() - MAX(m.performed_at))) / 86400)::int
          FROM workout_session_metrics m WHERE m.user_id = $1) AS days_since_last,

       (SELECT SUM(m.tonnage_kg)
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - ($2::int || ' days')::interval) AS tonnage_current,

       (SELECT SUM(m.tonnage_kg)
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - (($2::int * 2) || ' days')::interval
           AND m.performed_at <  NOW() - ($2::int || ' days')::interval) AS tonnage_previous,

       -- Só recorde de verdade: estreia (is_first) é linha de base, não conquista.
       (SELECT COUNT(*)::int
          FROM user_pr_events p
         WHERE p.user_id = $1
           AND p.is_first = false
           AND p.achieved_at >= NOW() - ($2::int || ' days')::interval) AS pr_count,

       (SELECT SUM(m.effort_load)
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - INTERVAL '7 days') AS load_7d,

       (SELECT SUM(m.effort_load)
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - ($2::int || ' days')::interval) AS load_28d,

       (SELECT COUNT(*)::int
          FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.effort_load IS NOT NULL
           AND m.performed_at >= NOW() - ($2::int || ' days')::interval) AS sessions_with_load`,
    [userId, windowDays, SCORE_SESSION_LOOKBACK_DAYS],
  );

  const r = rows[0] ?? {};
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    accountAgeDays: num(r.account_age_days),
    sessionsInLookback: Number(r.sessions_lookback ?? 0),
    daysSinceLastSession: num(r.days_since_last),
    tonnageCurrent: num(r.tonnage_current),
    tonnagePrevious: num(r.tonnage_previous),
    prCount: Number(r.pr_count ?? 0),
    loadSum7d: num(r.load_7d),
    loadSum28d: num(r.load_28d),
    sessionsWithLoad28d: Number(r.sessions_with_load ?? 0),
  };
}

/**
 * Exercícios comparáveis entre as duas janelas, e quantos melhoraram/pioraram.
 *
 * "Comparável" = pelo menos 2 dias com registro em CADA janela. Com um ponto só
 * de cada lado, qualquer variação de um treino viraria "progressão", e o score
 * oscilaria com ruído.
 *
 * A métrica comparada é o melhor e1RM do período; quando o exercício não tem
 * e1RM (reps fora de 1..12, ou peso corporal), cai para a maior carga. Sem
 * nenhuma das duas, o exercício não entra.
 */
export async function loadKeyExerciseProgression(
  userId: number,
  windowDays: number,
): Promise<{ total: number; improved: number; regressed: number }> {
  const { rows } = await pool.query<{ total: string; improved: string; regressed: string }>(
    `WITH por_dia AS (
       SELECT sl.exercise_id,
              ${SOURCE_DAY_EXPR.session} AS d,
              CASE WHEN ws.performed_at >= NOW() - ($2::int || ' days')::interval
                   THEN 'atual' ELSE 'anterior' END AS janela,
              MAX(ROUND((sl.load_done_kg * (1 + sl.reps_done / 30.0)) * 2) / 2)
                FILTER (WHERE sl.load_done_kg > 0 AND sl.reps_done BETWEEN 1 AND 12) AS e1rm,
              MAX(sl.load_done_kg) FILTER (WHERE sl.load_done_kg > 0) AS carga
         FROM workout_set_logs sl
         JOIN workout_sessions ws ON ws.id = sl.session_id
        WHERE ws.user_id = $1
          AND ws.status IN ('completed', 'partial')
          AND sl.status = 'done'
          AND sl.exercise_id IS NOT NULL
          AND ws.performed_at >= NOW() - (($2::int * 2) || ' days')::interval
        GROUP BY sl.exercise_id, ${SOURCE_DAY_EXPR.session}, janela
     ),
     -- COALESCE aqui é seguro: só descarta o exercício quando as DUAS métricas
     -- faltam, e nesse caso a linha inteira é NULL e some no HAVING.
     por_janela AS (
       SELECT exercise_id, janela,
              COUNT(*) FILTER (WHERE COALESCE(e1rm, carga) IS NOT NULL)::int AS pontos,
              MAX(COALESCE(e1rm, carga)) AS melhor
         FROM por_dia
        GROUP BY exercise_id, janela
     ),
     comparaveis AS (
       SELECT a.exercise_id, a.melhor AS melhor_atual, p.melhor AS melhor_anterior
         FROM por_janela a
         JOIN por_janela p ON p.exercise_id = a.exercise_id AND p.janela = 'anterior'
        WHERE a.janela = 'atual'
          AND a.pontos >= $3 AND p.pontos >= $3
          AND a.melhor IS NOT NULL AND p.melhor IS NOT NULL
     )
     SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE melhor_atual > melhor_anterior)::text AS improved,
            COUNT(*) FILTER (WHERE melhor_atual < melhor_anterior)::text AS regressed
       FROM comparaveis`,
    [userId, windowDays, PROGRESSION_MIN_POINTS_PER_WINDOW],
  );
  const r = rows[0];
  return {
    total: Number(r?.total ?? 0),
    improved: Number(r?.improved ?? 0),
    regressed: Number(r?.regressed ?? 0),
  };
}

/** Snapshot do score de hoje, se já foi calculado. */
export async function loadTodayScoreSnapshot(userId: number) {
  const { rows } = await pool.query(
    `SELECT score, status, trend, factors, inputs, formula_version, created_at
       FROM user_performance_snapshots
      WHERE user_id = $1 AND snapshot_date = (NOW() AT TIME ZONE $2)::date
      LIMIT 1`,
    [userId, APP_TIMEZONE],
  );
  return rows[0] ?? null;
}

/** Série do score, do mais antigo para o mais recente. */
export async function loadScoreHistory(
  userId: number,
  days: number,
): Promise<{ date: string; score: number | null; status: string }[]> {
  const { rows } = await pool.query(
    `SELECT snapshot_date::text AS date, score, status
       FROM user_performance_snapshots
      WHERE user_id = $1
        AND snapshot_date >= (NOW() AT TIME ZONE $2)::date - $3::int
      ORDER BY snapshot_date ASC`,
    [userId, APP_TIMEZONE, days],
  );
  return rows.map((r) => ({
    date: String(r.date),
    score: r.score == null ? null : Number(r.score),
    status: String(r.status),
  }));
}

/** Breakdown de N dias atrás — base da explicação "o que mudou". */
export async function loadScoreFactorsAt(
  userId: number,
  daysAgo: number,
): Promise<unknown[] | null> {
  const { rows } = await pool.query(
    `SELECT factors
       FROM user_performance_snapshots
      WHERE user_id = $1
        AND snapshot_date <= (NOW() AT TIME ZONE $2)::date - $3::int
      ORDER BY snapshot_date DESC
      LIMIT 1`,
    [userId, APP_TIMEZONE, daysAgo],
  );
  return rows[0] ? (rows[0].factors as unknown[]) : null;
}

/**
 * Grava o snapshot do dia. Idempotente por `(user, dia)`: recalcular o mesmo
 * dia sobrescreve com o mesmo resultado, nunca cria linha nova.
 */
export async function upsertScoreSnapshot(
  userId: number,
  data: {
    score: number | null;
    status: string;
    trend: string;
    factors: unknown;
    inputs: unknown;
    formulaVersion: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO user_performance_snapshots
       (user_id, snapshot_date, score, status, trend, factors, inputs, formula_version)
     VALUES ($1, (NOW() AT TIME ZONE $2)::date, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (user_id, snapshot_date) DO UPDATE
       SET score = EXCLUDED.score,
           status = EXCLUDED.status,
           trend = EXCLUDED.trend,
           factors = EXCLUDED.factors,
           inputs = EXCLUDED.inputs,
           formula_version = EXCLUDED.formula_version,
           created_at = NOW()`,
    [
      userId,
      APP_TIMEZONE,
      data.score,
      data.status,
      data.trend,
      JSON.stringify(data.factors),
      JSON.stringify(data.inputs),
      data.formulaVersion,
    ],
  );
}

/** Invalida o snapshot do dia — chamado quando a execução muda. */
export async function invalidateTodayScoreSnapshot(userId: number): Promise<void> {
  await pool.query(
    `DELETE FROM user_performance_snapshots
      WHERE user_id = $1 AND snapshot_date = (NOW() AT TIME ZONE $2)::date`,
    [userId, APP_TIMEZONE],
  );
}

/**
 * Distribuição do método de carga — observabilidade da qualidade do dado.
 *
 * Mede quanto da carga vem de duração medida e quanto vem do proxy por séries.
 * Sem números pessoais: só contagens agregadas.
 */
/**
 * Contadores de recorde e estagnação, numa consulta só (Onda P5).
 *
 * Três números que a tela do personal usa juntos e que viriam de três viagens ao
 * banco se cada sinal buscasse o seu. Estreias (`is_first`) ficam de fora do
 * contador de recentes: o primeiro registro de um exercício não supera nada, e
 * contá-lo faria todo aluno novo aparecer "batendo recordes".
 */
export async function loadPrCounters(
  userId: number,
  recentDays: number,
  stallDays: number,
): Promise<{ recentPrCount: number; daysSinceLastPr: number | null; sessionsInStallWindow: number }> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM user_pr_events e
         WHERE e.user_id = $1 AND e.is_first = false
           AND e.achieved_at >= NOW() - ($2::int * INTERVAL '1 day')) AS recent_count,

       (SELECT (EXTRACT(EPOCH FROM (NOW() - MAX(e.achieved_at))) / 86400)::int
          FROM user_pr_events e
         WHERE e.user_id = $1 AND e.is_first = false) AS days_since_last,

       (SELECT COUNT(*)::int FROM workout_session_metrics m
         WHERE m.user_id = $1
           AND m.performed_at >= NOW() - ($3::int * INTERVAL '1 day')) AS sessions_stall`,
    [userId, recentDays, stallDays],
  );
  const r = rows[0] ?? {};
  return {
    recentPrCount: Number(r.recent_count ?? 0),
    daysSinceLastPr: r.days_since_last == null ? null : Number(r.days_since_last),
    sessionsInStallWindow: Number(r.sessions_stall ?? 0),
  };
}

/**
 * Score de N dias atrás — o ponto de comparação do sinal de movimento.
 *
 * Pega o snapshot MAIS RECENTE até aquele dia, e não o do dia exato: o snapshot
 * é gravado quando alguém abre a tela, então exigir a data cravada devolveria
 * `null` para quem não entrou no app naquele dia.
 */
export async function loadScoreAsOf(userId: number, daysAgo: number): Promise<number | null> {
  const { rows } = await pool.query<{ score: number | null }>(
    `SELECT score FROM user_performance_snapshots
      WHERE user_id = $1 AND snapshot_date <= (CURRENT_DATE - $2::int)
      ORDER BY snapshot_date DESC LIMIT 1`,
    [userId, daysAgo],
  );
  return rows[0]?.score ?? null;
}

export async function loadEffortMethodDistribution(
  windowDays: number,
): Promise<{ method: string; sessions: number }[]> {
  const { rows } = await pool.query<{ method: string | null; n: string }>(
    `SELECT effort_load_method AS method, COUNT(*)::text AS n
       FROM workout_session_metrics
      WHERE performed_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY effort_load_method
      ORDER BY 2 DESC`,
    [windowDays],
  );
  return rows.map((r) => ({ method: r.method ?? 'sem_carga', sessions: Number(r.n) }));
}
