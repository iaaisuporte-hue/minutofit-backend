/**
 * Acesso a dados dos desafios (Spec 034, Onda C2).
 *
 * ## O que NÃO está aqui
 *
 * Nenhuma métrica. Dias ativos, frequência prevista e metas vêm dos serviços
 * canônicos do módulo Performance — a Community observa a 033 e nunca a
 * recalcula. As queries abaixo leem apenas `challenges` e
 * `challenge_participants`.
 */
import type { PoolClient } from 'pg';

import pool from '../../config/database';
import type { ChallengeKind, ChallengeStatus, ParticipantStatus } from './challenges.engine';

/** Espaço de chaves do advisory lock reservado a desafios (§spec). */
export const LOCK_NAMESPACE_CHALLENGES = 4;

export interface ChallengeRow {
  id: string;
  scope: string;
  created_by_user_id: number;
  personal_id: number | null;
  academy_id: number | null;
  title: string;
  description: string | null;
  kind: ChallengeKind;
  rule_json: Record<string, unknown>;
  rules_version: number;
  starts_on: string;
  ends_on: string;
  status: ChallengeStatus;
  created_at: Date;
}

export interface ParticipantRow {
  id: string;
  challenge_id: string;
  user_id: number;
  status: ParticipantStatus;
  invited_at: Date;
  joined_at: Date | null;
  left_at: Date | null;
  completed_at: Date | null;
  consent_ack_at: Date | null;
  final_pct: string | null;
}

/**
 * Colunas do desafio, SEMPRE qualificadas por alias.
 *
 * Datas viajam como `YYYY-MM-DD` porque o driver desserializa DATE como objeto
 * e formatá-lo no JS reintroduz fuso numa data de calendário. E o alias é
 * obrigatório: sem ele, todo SELECT com JOIN em `challenge_participants` morre
 * com "column reference id is ambiguous" — as duas tabelas têm `id` e `status`.
 */
const challengeColumns = (a: string) => `
  ${a}.id::text, ${a}.scope, ${a}.created_by_user_id, ${a}.personal_id, ${a}.academy_id,
  ${a}.title, ${a}.description, ${a}.kind, ${a}.rule_json, ${a}.rules_version,
  to_char(${a}.starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(${a}.ends_on,   'YYYY-MM-DD') AS ends_on,
  ${a}.status, ${a}.created_at`;

/**
 * Trava a avaliação de UM desafio.
 *
 * O id é `bigint`, e `pg_advisory_xact_lock` resolve para a variante de dois
 * `int4`: passar um número acima de 2³¹−1 lança `integer out of range` DENTRO
 * da transação — o catch faz rollback e a conclusão simplesmente nunca
 * acontece, com um warn que ninguém lê. `hashtext` no servidor elimina a
 * faixa: qualquer id vira um int4 válido.
 */
export async function lockChallengeEvaluation(
  client: PoolClient,
  challengeId: string | number,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    LOCK_NAMESPACE_CHALLENGES,
    String(challengeId),
  ]);
}

export interface CreateChallengeInput {
  createdByUserId: number;
  /** Dono do desafio. Exatamente UM dos dois — o CHECK do banco exige. */
  personalId?: number | null;
  academyId?: number | null;
  title: string;
  description: string | null;
  kind: ChallengeKind;
  rule: Record<string, unknown>;
  rulesVersion: number;
  startsOn: string;
  endsOn: string;
}

export async function insertChallenge(input: CreateChallengeInput): Promise<ChallengeRow> {
  // O escopo é DERIVADO do dono, nunca aceito do cliente: quem cria dentro do
  // contexto de uma academia produz desafio institucional, e quem cria como
  // personal produz desafio de turma. Um `scope` vindo do corpo seria um
  // pedido de autorização disfarçado de campo.
  const scope = input.academyId != null ? 'academy' : 'personal';

  const { rows } = await pool.query<ChallengeRow>(
    `INSERT INTO challenges
       (scope, created_by_user_id, personal_id, academy_id, title, description, kind,
        rule_json, rules_version, starts_on, ends_on, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::date, $11::date, 'active')
     RETURNING ${challengeColumns('challenges')}`,
    [
      scope,
      input.createdByUserId,
      input.personalId ?? null,
      input.academyId ?? null,
      input.title,
      input.description,
      input.kind,
      JSON.stringify(input.rule),
      input.rulesVersion,
      input.startsOn,
      input.endsOn,
    ],
  );
  return rows[0];
}

/**
 * Um desafio, se pertencer à ACADEMIA informada.
 *
 * Gêmeo de `findChallengeOwnedBy`, com o tenant na cláusula pela mesma razão:
 * desafio de outra academia não é "encontrado e recusado", é inexistente para
 * quem pergunta — a resposta não distingue "não existe" de "é de outro tenant".
 */
export async function findChallengeOwnedByAcademy(
  challengeId: string,
  academyId: number,
): Promise<ChallengeRow | null> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT ${challengeColumns('c')} FROM challenges c
      WHERE c.id = $1::bigint AND c.academy_id = $2 AND c.scope = 'academy'`,
    [challengeId, academyId],
  );
  return rows[0] ?? null;
}

export async function listChallengesForAcademy(academyId: number): Promise<ChallengeRow[]> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT ${challengeColumns('c')} FROM challenges c
      WHERE c.academy_id = $1 AND c.scope = 'academy'
      ORDER BY c.starts_on DESC, c.id DESC
      LIMIT 100`,
    [academyId],
  );
  return rows;
}

/**
 * Alunos ELEGÍVEIS de uma academia — resolvidos no servidor.
 *
 * O convite institucional pode ser "todos os elegíveis", e por isso a lista
 * nasce aqui: aceitar ids do frontend transformaria a seleção da tela em
 * autorização. `ar.slug = 'academy_student'` é o vínculo canônico do módulo
 * Academia — não existe vínculo paralelo para desafio.
 */
export async function listEligibleAcademyStudents(
  academyId: number,
  unitId?: number | null,
): Promise<number[]> {
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT au.user_id
       FROM academy_users au
       JOIN academy_roles ar ON ar.id = au.role_id
      WHERE au.academy_id = $1
        AND ar.slug = 'academy_student'
        AND au.status = 'active' AND au.is_active = true
        AND ($2::int IS NULL OR au.academy_unit_id = $2)`,
    [academyId, unitId ?? null],
  );
  return rows.map((r) => r.user_id);
}

/** O aluno pertence a ESTA academia? Fail-closed, sem revelar existência. */
export async function isAcademyStudent(academyId: number, userId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM academy_users au
       JOIN academy_roles ar ON ar.id = au.role_id
      WHERE au.academy_id = $1 AND au.user_id = $2
        AND ar.slug = 'academy_student'
        AND au.status = 'active' AND au.is_active = true
      LIMIT 1`,
    [academyId, userId],
  );
  return rows.length > 0;
}

/**
 * Remove os desafios de uma academia encerrada.
 *
 * Precedente do projeto (migrations 1826 e a exclusão de conta do personal):
 * entidade operacional não sobrevive ao dono. Um desafio institucional sem
 * tenant é entidade social órfã carregando dado pessoal de terceiros; os
 * participantes vão por CASCADE.
 */
export async function deleteAcademyChallenges(academyId: number): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM challenges WHERE academy_id = $1`, [
    academyId,
  ]);
  return rowCount ?? 0;
}

export async function cancelAcademyChallenge(
  challengeId: string,
  academyId: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE challenges
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1::bigint AND academy_id = $2 AND scope = 'academy'
        AND status IN ('draft', 'active')`,
    [challengeId, academyId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Um desafio, se pertencer ao personal informado.
 *
 * A propriedade entra na CLÁUSULA, não numa checagem depois: buscar por id e
 * comparar o dono em JavaScript deixaria a janela em que alguém esquece a
 * comparação. Desafio alheio simplesmente não existe para quem pergunta.
 */
export async function findChallengeOwnedBy(
  challengeId: string,
  personalId: number,
): Promise<ChallengeRow | null> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT ${challengeColumns('c')} FROM challenges c
      WHERE c.id = $1::bigint AND c.personal_id = $2 AND c.scope = 'personal'`,
    [challengeId, personalId],
  );
  return rows[0] ?? null;
}

/** Um desafio visível ao ALUNO: só se ele foi convidado ou participa. */
export async function findChallengeForParticipant(
  challengeId: string,
  userId: number,
): Promise<{ challenge: ChallengeRow; participant: ParticipantRow } | null> {
  const { rows } = await pool.query(
    `SELECT ${challengeColumns('c')},
            COALESCE(
              (SELECT name FROM users WHERE id = c.personal_id),
              (SELECT display_name FROM academies WHERE id = c.academy_id)
            ) AS invited_by_name,
            p.id::text AS p_id, p.status AS p_status, p.invited_at, p.joined_at,
            p.left_at, p.completed_at, p.consent_ack_at, p.final_pct::text AS final_pct
       FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id AND p.user_id = $2
      WHERE c.id = $1::bigint`,
    [challengeId, userId],
  );
  const r = rows[0];
  if (!r) return null;

  return {
    challenge: r as ChallengeRow,
    participant: {
      id: r.p_id,
      challenge_id: r.id,
      user_id: userId,
      status: r.p_status,
      invited_at: r.invited_at,
      joined_at: r.joined_at,
      left_at: r.left_at,
      completed_at: r.completed_at,
      consent_ack_at: r.consent_ack_at,
      final_pct: r.final_pct,
    },
  };
}

export async function listChallengesForPersonal(personalId: number): Promise<ChallengeRow[]> {
  const { rows } = await pool.query<ChallengeRow>(
    `SELECT ${challengeColumns('c')} FROM challenges c
      WHERE c.personal_id = $1 AND c.scope = 'personal'
      ORDER BY c.starts_on DESC, c.id DESC
      LIMIT 100`,
    [personalId],
  );
  return rows;
}

/**
 * Os desafios do aluno — do personal E da academia, na mesma lista.
 *
 * O `scope` diferencia a origem; não existem "Desafios do Personal" e
 * "Desafios da Academia" como duas aplicações. A ordem é por ESTADO, não por
 * origem: em andamento, depois futuros, depois encerrados. Priorizar o
 * institucional sobre o do personal seria uma escolha de produto que ninguém
 * fez.
 */
export async function listChallengesForUser(userId: number, today: string): Promise<
  Array<ChallengeRow & { p_status: ParticipantStatus; final_pct: string | null; invited_by_name: string | null }>
> {
  const { rows } = await pool.query(
    `SELECT ${challengeColumns('c')},
            p.status AS p_status, p.final_pct::text AS final_pct,
            COALESCE(
              (SELECT name FROM users WHERE id = c.personal_id),
              (SELECT display_name FROM academies WHERE id = c.academy_id)
            ) AS invited_by_name
       FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id
      WHERE p.user_id = $1
      ORDER BY
        CASE
          WHEN c.status = 'cancelled' THEN 3
          WHEN c.starts_on > $2::date THEN 1   -- futuros
          WHEN c.ends_on   < $2::date THEN 2   -- encerrados
          ELSE 0                               -- em andamento
        END,
        c.ends_on ASC, c.id DESC
      LIMIT 50`,
    [userId, today],
  );
  return rows;
}

/**
 * Convida em lote — com a validação de vínculo JÁ FEITA pelo chamador.
 *
 * `ON CONFLICT ... DO UPDATE` cobre o reconvite de quem saiu: a linha volta a
 * `invited` sem perder o histórico da participação anterior. Reconvidar quem
 * já está ativo não muda nada.
 */
export async function inviteParticipants(
  challengeId: string,
  userIds: number[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO challenge_participants (challenge_id, user_id, status, invited_at)
     SELECT $1::bigint, u, 'invited', now() FROM unnest($2::int[]) AS u
     ON CONFLICT (challenge_id, user_id) DO UPDATE
        SET status = CASE WHEN challenge_participants.status = 'left'
                          THEN 'invited' ELSE challenge_participants.status END,
            invited_at = CASE WHEN challenge_participants.status = 'left'
                              THEN now() ELSE challenge_participants.invited_at END`,
    [challengeId, userIds],
  );
  return rowCount ?? 0;
}

/** Quem já saiu deste desafio — o convite em massa não os reconvida. */
export async function listParticipantsWhoLeft(challengeId: string): Promise<number[]> {
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT user_id FROM challenge_participants
      WHERE challenge_id = $1::bigint AND status = 'left'`,
    [challengeId],
  );
  return rows.map((r) => r.user_id);
}

export async function listParticipants(challengeId: string): Promise<ParticipantRow[]> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT id::text, challenge_id::text, user_id, status, invited_at, joined_at,
            left_at, completed_at, consent_ack_at, final_pct::text
       FROM challenge_participants
      WHERE challenge_id = $1::bigint
      ORDER BY id`,
    [challengeId],
  );
  return rows;
}

/**
 * Participantes que contam para as faixas.
 *
 * `consent_ack_at IS NOT NULL` é a condição real, não o status: quem revogou a
 * visibilidade some do agregado mesmo tendo concluído. Filtrar só por status
 * deixaria quem concluiu exposto para sempre, sem caminho de saída.
 */
export async function listScoringParticipants(challengeId: string): Promise<ParticipantRow[]> {
  const todos = await listParticipants(challengeId);
  return todos.filter(
    (p) => (p.status === 'active' || p.status === 'completed') && p.consent_ack_at != null,
  );
}

/**
 * Entra no desafio. Só a partir de `invited`, e é o `WHERE` que garante isso —
 * um join repetido devolve 0 linhas em vez de reescrever `joined_at`.
 */
export async function joinChallenge(
  challengeId: string,
  userId: number,
): Promise<ParticipantRow | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `UPDATE challenge_participants
        SET status = 'active', joined_at = now(), consent_ack_at = now(), left_at = NULL
      WHERE challenge_id = $1::bigint AND user_id = $2 AND status = 'invited'
      RETURNING id::text, challenge_id::text, user_id, status, invited_at, joined_at,
                left_at, completed_at, consent_ack_at, final_pct::text`,
    [challengeId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Sai do desafio. Revoga a visibilidade na MESMA operação: `consent_ack_at`
 * volta a NULL, e quem saiu deixa de contar nas faixas imediatamente — não há
 * janela em que a pessoa continue exposta enquanto algo "processa".
 */
export async function leaveChallenge(
  challengeId: string,
  userId: number,
): Promise<ParticipantRow | null> {
  const { rows } = await pool.query<ParticipantRow>(
    // Quem CONCLUIU também pode revogar a visibilidade: o status vira o fato
    // histórico (`completed` continua `completed`, com `final_pct` intacto) e
    // só a exposição acaba. Sem isto, concluir era uma porta de mão única —
    // a pessoa ficaria no agregado do grupo para sempre.
    `UPDATE challenge_participants
        SET status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'left' END,
            left_at = now(),
            consent_ack_at = NULL
      WHERE challenge_id = $1::bigint AND user_id = $2
        AND status IN ('invited', 'active', 'completed')
        AND consent_ack_at IS NOT NULL
      RETURNING id::text, challenge_id::text, user_id, status, invited_at, joined_at,
                left_at, completed_at, consent_ack_at, final_pct::text`,
    [challengeId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Congela a conclusão. `WHERE status='active'` é a idempotência: a segunda
 * avaliação devolve 0 linhas, e nem a conclusão nem o XP se repetem.
 */
export async function completeParticipant(
  client: PoolClient,
  challengeId: string,
  userId: number,
  finalPct: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE challenge_participants
        SET status = 'completed', completed_at = now(), final_pct = $3
      WHERE challenge_id = $1::bigint AND user_id = $2 AND status = 'active'`,
    [challengeId, userId, finalPct],
  );
  return (rowCount ?? 0) > 0;
}

export async function cancelChallenge(challengeId: string, personalId: number): Promise<boolean> {
  // Só sai de `draft`/`active`: cancelar o que já terminou reescreveria
  // história, e o histórico de quem concluiu permanece intocado.
  const { rowCount } = await pool.query(
    `UPDATE challenges
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1::bigint AND personal_id = $2 AND status IN ('draft', 'active')`,
    [challengeId, personalId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Desafios do aluno relevantes HOJE — alimenta o card da tela Hoje.
 *
 * `invited` entra na lista, e isso não é detalhe: sem ele o convite ficava
 * invisível no app inteiro (não há tela de lista), e todo o consentimento
 * informado desta onda vivia atrás de uma porta sem maçaneta — o personal
 * convidava e o aluno só descobria se alguém lhe passasse o link.
 *
 * O convite vem primeiro na ordem: é o que exige ação.
 */
export async function listRunningForUser(userId: number, today: string) {
  const { rows } = await pool.query(
    `SELECT ${challengeColumns('c')}, p.status AS p_status,
            COALESCE(
              (SELECT name FROM users WHERE id = c.personal_id),
              (SELECT display_name FROM academies WHERE id = c.academy_id)
            ) AS invited_by_name
       FROM challenges c
       JOIN challenge_participants p ON p.challenge_id = c.id
      WHERE p.user_id = $1
        AND p.status IN ('invited', 'active', 'completed')
        AND c.status = 'active'
        AND c.ends_on >= $2::date
      ORDER BY (p.status = 'invited') DESC, c.ends_on ASC
      LIMIT 5`,
    [userId, today],
  );
  return rows;
}
