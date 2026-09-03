/**
 * Fixture para QA da Sprint P2B (Aderência, Recorrência e Insights para o Personal).
 * Baseado em src/scripts/qaDynamicFixture.ts, estendido para: 2 Personals ISOLADOS
 * (nenhum aluno compartilhado, para o teste de segurança 403/404), 1 aluno vinculado
 * SÓ ao Personal A, ficha com 7 exercícios (incl. 1 par Bi-Set) e 6 sessões
 * históricas com prescribed_snapshot + workout_set_logs inseridos DIRETO no banco
 * (mesmo padrão de src/__tests__/adherence-recurring-insights.integration.test.ts —
 * a API real tem janela retroativa de só 3 dias, insuficiente para simular
 * histórico de semanas).
 *
 * Uso (com DATABASE_URL local apontando para banco de QA):
 *   npx tsx src/scripts/qaP2bFixture.ts --setup
 *   npx tsx src/scripts/qaP2bFixture.ts --teardown
 */
import { randomUUID } from 'crypto';

import pool from '../config/database';
import { grantMembership } from '../services/membershipService';
import { createPersonalWorkoutPlanWithDays } from '../services/personalWorkoutPlanService';
import { findOrCreateUserFromContext } from '../services/userIdentityService';

const TAG = 'qa-p2b';
const EMAIL_ALUNO = `${TAG}-aluno@s2core.invalid`;
const EMAIL_PERSONAL_A = `${TAG}-personal-a@s2core.invalid`;
const EMAIL_PERSONAL_B = `${TAG}-personal-b@s2core.invalid`;
const PLAN_TITLE = 'Ficha QA P2B';

const CONSENT_SCOPES = ['profile', 'workouts', 'daily_checkins', 'metabolic', 'body_metrics'];

// IDs reais do seed curado (`seedExercisesLibrary`) — confirmados por consulta
// direta ao banco de QA antes de escrever este fixture.
const EX = {
  supino: { id: '9a0ad9cc-3267-4021-af7d-3b87a09ce413', name: 'Supino Reto' },
  agachamento: { id: 'd1e545f7-01e1-43eb-b7f1-cfe9af7eb37e', name: 'Agachamento Livre' },
  legPress: { id: '549a8efc-4490-4fcd-8cde-a8d70b650e76', name: 'Leg Press 45°' },
  remada: { id: '09dfae7c-ebb2-4cd5-85c0-cceda65ce6b0', name: 'Remada Curvada com Barra' },
  puxada: { id: '13298144-4f10-4b04-9648-dfaa82bf9642', name: 'Puxada Frente (Lat Pulldown)' },
  desenvolvimento: { id: '96c54209-dafe-4b2a-a34d-fea09171e6b4', name: 'Desenvolvimento com Barra (Press Militar)' },
  rosca: { id: 'd42a5819-271f-4535-80c7-9af232dd06e5', name: 'Rosca Direta com Barra' },
  crucifixo: { id: '4838c743-9dc7-49d1-b079-0e86b0cfb67d', name: 'Crucifixo com Halteres' },
  crucifixoInclinado: { id: '10545fce-c238-4d87-9a89-372911924439', name: 'Crucifixo Inclinado com Halteres' },
  triceps: { id: '2c0382ee-e683-4a97-8af8-5ed8aa0b9677', name: 'Tríceps Corda (Pushdown)' },
  prancha: { id: '5fc0ee69-a9fe-44d6-b7de-fa2249a61f3a', name: 'Prancha' },
} as const;

// technique.biSetGroupId exige UUID v4 (sanitizeTechniqueConfig) — string
// arbitrária como "qa-p2b-biset-1" é rejeitada com "Exercícios inválidos no plano".
const BISET_GROUP = randomUUID();
const DISCOMFORT_REASON = 'Dor ou desconforto';
const EQUIPMENT_REASON = 'Equipamento ocupado';

function documentoSintetico(seed: number): { cpf: string; phone: string } {
  const n = String(Date.now() % 100000).padStart(5, '0') + String(seed).padStart(4, '0');
  return { cpf: `999${n}`.slice(0, 11).padEnd(11, '0'), phone: `1199${n}`.slice(0, 11) };
}

function planItem(ex: { id: string; name: string }, sets: string, biSet?: boolean) {
  return {
    exerciseId: ex.id,
    name: ex.name,
    sets,
    reps: '10-12',
    rest: '60',
    rpe: '7',
    ...(biSet ? { technique: { type: 'bi_set', biSetGroupId: BISET_GROUP } } : {}),
  };
}

async function criarPersonal(email: string, nome: string, senha: string, seedDoc: number) {
  const doc = documentoSintetico(seedDoc);
  const personal = await findOrCreateUserFromContext({
    email,
    name: nome,
    password: senha,
    cpf: doc.cpf,
    phone: doc.phone,
    matchBy: ['email'],
  });
  await pool.query(`UPDATE users SET role = 'personal', profile_completed = true WHERE id = $1`, [
    personal.user.id,
  ]);
  await grantMembership(personal.user.id, 'personal', { source: 'corefit' });
  return personal.user.id;
}

/** Sessão `daysAgo` dias atrás, com o snapshot prescrito dado. Espelha o helper
 * homônimo da suíte de integração da P2B — mesma forma de dado. */
async function insertSession(opts: {
  userId: number;
  academyId: number | null;
  personalId: number;
  planId: number;
  dayIndex: number;
  daysAgo: number;
  prescribed: ReturnType<typeof planItem>[];
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO workout_sessions
       (user_id, academy_id, personal_id, source, plan_id, day_index, status, prescribed_snapshot,
        started_at, ended_at, performed_at)
     VALUES ($1,$2,$3,'personal',$4,$5,'completed',$6::jsonb,
             NOW() - ($7 || ' days')::interval, NOW() - ($7 || ' days')::interval, NOW() - ($7 || ' days')::interval)
     RETURNING id`,
    [opts.userId, opts.academyId, opts.personalId, opts.planId, opts.dayIndex, JSON.stringify(opts.prescribed), String(opts.daysAgo)],
  );
  return rows[0].id as number;
}

async function insertSetLog(opts: {
  sessionId: number;
  exerciseId: string | null;
  exerciseName: string;
  executionSource: 'prescribed' | 'replacement' | 'user_added';
  substitutedFrom?: string | null;
  reason?: string | null;
  status?: 'done' | 'skipped';
  setIndex?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workout_set_logs
       (session_id, exercise_id, exercise_name, order_index, set_index, execution_source,
        substituted_from_exercise_id, substitution_reason, status)
     VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8)`,
    [
      opts.sessionId,
      opts.exerciseId,
      opts.exerciseName,
      opts.setIndex ?? 1,
      opts.executionSource,
      opts.substitutedFrom ?? null,
      opts.reason ?? null,
      opts.status ?? 'done',
    ],
  );
}

async function fullSet(sessionId: number, ex: { id: string; name: string }, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await insertSetLog({ sessionId, exerciseId: ex.id, exerciseName: ex.name, executionSource: 'prescribed', setIndex: i });
  }
}

async function partialSet(sessionId: number, ex: { id: string; name: string }, done: number): Promise<void> {
  for (let i = 1; i <= done; i++) {
    await insertSetLog({ sessionId, exerciseId: ex.id, exerciseName: ex.name, executionSource: 'prescribed', setIndex: i });
  }
}

async function substitutedSet(
  sessionId: number,
  original: { id: string; name: string },
  substitute: { id: string; name: string },
  reason: string,
  count = 3,
): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await insertSetLog({
      sessionId,
      exerciseId: substitute.id,
      exerciseName: substitute.name,
      executionSource: 'replacement',
      substitutedFrom: original.id,
      reason,
      setIndex: i,
    });
  }
}

async function setup(): Promise<void> {
  const senhaAluno = 'QaP2bAluno#2026';
  const senhaPersonalA = 'QaP2bPersonalA#2026';
  const senhaPersonalB = 'QaP2bPersonalB#2026';

  const personalAId = await criarPersonal(EMAIL_PERSONAL_A, 'QA P2B Personal A', senhaPersonalA, 21);
  const personalBId = await criarPersonal(EMAIL_PERSONAL_B, 'QA P2B Personal B', senhaPersonalB, 22);

  const docAluno = documentoSintetico(23);
  const aluno = await findOrCreateUserFromContext({
    email: EMAIL_ALUNO,
    name: 'QA P2B Aluno',
    password: senhaAluno,
    cpf: docAluno.cpf,
    phone: docAluno.phone,
    matchBy: ['email'],
  });
  const alunoId = aluno.user.id;
  await pool.query(`UPDATE users SET role = 'user', profile_completed = true WHERE id = $1`, [alunoId]);
  await grantMembership(alunoId, 'app', { source: 'bonus_personal' });

  const tier = await pool.query(`SELECT id FROM subscription_tiers WHERE LOWER(name) = 'premium' LIMIT 1`);
  await pool.query(`UPDATE user_subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`, [alunoId]);
  await pool.query(
    `INSERT INTO user_subscriptions (user_id, tier_id, status, active_from) VALUES ($1, $2, 'active', NOW())`,
    [alunoId, tier.rows[0].id],
  );

  // Vínculo SÓ com o Personal A — Personal B fica isolado (teste de segurança).
  await pool.query(
    `INSERT INTO personal_student_assignments (personal_id, student_id, status, academy_id)
     VALUES ($1, $2, 'active', NULL) ON CONFLICT DO NOTHING`,
    [personalAId, alunoId],
  );

  for (const scope of CONSENT_SCOPES) {
    await pool.query(
      `INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status, granted_at)
       VALUES ($1, $2, 'personal', $3, 'granted', NOW()) ON CONFLICT DO NOTHING`,
      [alunoId, personalAId, scope],
    );
  }

  // PAR-Q liberado — precisa das 5 flags de saúde + assinatura + validade
  // futura (`deriveClearance` em physicalActivityClearanceService.ts); só
  // `parq_signed_at` (como o `qaDynamicFixture.ts` legado faz) NÃO basta e
  // deixa o aluno preso na tela de triagem em vez de abrir o treino.
  await pool.query(
    `UPDATE users SET
       parq_signed_at = NOW(),
       parq_expires_at = NOW() + interval '1 year',
       parq_signature_data = 'data:image/png;base64,qa-fixture-signature',
       parq_any_yes = false,
       sem_historico_hipertensao = true,
       sem_historico_cardiaco = true,
       sem_restricao_medica_exercicio = true,
       apto_para_atividade_fisica = true,
       aceita_responsabilidade_informacoes = true
     WHERE id = $1`,
    [alunoId],
  );

  // Ficha ativa: 7 exercícios, incl. par Bi-Set (Crucifixo + Tríceps Corda).
  const plano = await createPersonalWorkoutPlanWithDays(personalAId, alunoId, null, {
    title: PLAN_TITLE,
    weekPreset: '3',
    days: [
      {
        name: 'Dia A',
        focus: 'Full body',
        items: [
          planItem(EX.supino, '3'),
          planItem(EX.agachamento, '3'),
          planItem(EX.remada, '3'),
          planItem(EX.desenvolvimento, '3'),
          planItem(EX.rosca, '3'),
          planItem(EX.crucifixo, '3', true),
          planItem(EX.triceps, '3', true),
        ],
      },
    ],
  });
  const planId = plano.id;
  const dayIndex = 1; // 1-based, mesma convenção de personal_workout_plan_days.day_index

  const prescribed = [
    planItem(EX.supino, '3'),
    planItem(EX.agachamento, '3'),
    planItem(EX.remada, '3'),
    planItem(EX.desenvolvimento, '3'),
    planItem(EX.rosca, '3'),
    planItem(EX.crucifixo, '3', true),
    planItem(EX.triceps, '3', true),
  ];

  // 6 sessões, mais recente → mais antiga. As 5 mais recentes (2,6,10,14,18)
  // formam a janela de recorrência ("últimas 5 vezes prescrito"); a 6ª (25
  // dias atrás) fica de fora de propósito, para provar que a janela é
  // respeitada e não conta indefinidamente para trás.
  const sessoes = [
    { daysAgo: 2, agachamentoSub: true, remadaSub: true, crucifixoSub: true, desenvolvimentoDone: false, roscaPartial: true, extra: true },
    { daysAgo: 6, agachamentoSub: true, remadaSub: true, crucifixoSub: true, desenvolvimentoDone: true, roscaPartial: false, extra: false },
    { daysAgo: 10, agachamentoSub: false, remadaSub: true, crucifixoSub: true, desenvolvimentoDone: false, roscaPartial: true, extra: true },
    { daysAgo: 14, agachamentoSub: false, remadaSub: false, crucifixoSub: false, desenvolvimentoDone: true, roscaPartial: false, extra: false },
    { daysAgo: 18, agachamentoSub: false, remadaSub: false, crucifixoSub: false, desenvolvimentoDone: true, roscaPartial: false, extra: false },
    { daysAgo: 25, agachamentoSub: true, remadaSub: true, crucifixoSub: true, desenvolvimentoDone: true, roscaPartial: false, extra: false },
  ];

  const sessionIds: number[] = [];
  for (const s of sessoes) {
    const sessionId = await insertSession({
      userId: alunoId,
      academyId: null,
      personalId: personalAId,
      planId,
      dayIndex,
      daysAgo: s.daysAgo,
      prescribed,
    });
    sessionIds.push(sessionId);

    await fullSet(sessionId, EX.supino, 3);

    if (s.agachamentoSub) {
      await substitutedSet(sessionId, EX.agachamento, EX.legPress, DISCOMFORT_REASON, 3);
    } else {
      await fullSet(sessionId, EX.agachamento, 3);
    }

    if (s.remadaSub) {
      await substitutedSet(sessionId, EX.remada, EX.puxada, EQUIPMENT_REASON, 3);
    } else {
      await fullSet(sessionId, EX.remada, 3);
    }

    if (s.desenvolvimentoDone) {
      await fullSet(sessionId, EX.desenvolvimento, 3);
    } // senão: nenhuma linha → NAO_EXECUTADO

    if (s.roscaPartial) {
      await partialSet(sessionId, EX.rosca, 1);
    } else {
      await fullSet(sessionId, EX.rosca, 3);
    }

    // Crucifixo é membro do par Bi-Set NA FICHA ATUAL, mas também recorrentemente
    // substituído na EXECUÇÃO (3/5) — é o caso que faz "Revisar ficha" aparecer
    // num card que, ao ser aberto, esbarra em D-BISET (o par não pode ser editado
    // isoladamente pela revisão assistida). Tríceps Corda (o outro membro do par)
    // fica sempre conforme, para provar que só o membro substituído gera insight.
    if (s.crucifixoSub) {
      await substitutedSet(sessionId, EX.crucifixo, EX.crucifixoInclinado, EQUIPMENT_REASON, 3);
    } else {
      await fullSet(sessionId, EX.crucifixo, 3);
    }
    await fullSet(sessionId, EX.triceps, 3);

    if (s.extra) {
      await insertSetLog({
        sessionId,
        exerciseId: EX.prancha.id,
        exerciseName: EX.prancha.name,
        executionSource: 'user_added',
        status: 'done',
        setIndex: 1,
      });
    }
  }

  // Selo P2A "Alternativa já aprovada por você": Remada → Puxada Frente,
  // cadastrado pelo Personal A (o mesmo que vê o insight).
  await pool.query(
    `INSERT INTO exercise_replacement_alternatives (original_exercise_id, alternative_exercise_id, personal_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [EX.remada.id, EX.puxada.id, personalAId],
  );

  console.log(JSON.stringify({
    alunoId,
    personalAId,
    personalBId,
    planId,
    dayIndex,
    aluno: { email: EMAIL_ALUNO, senha: senhaAluno },
    personalA: { email: EMAIL_PERSONAL_A, senha: senhaPersonalA },
    personalB: { email: EMAIL_PERSONAL_B, senha: senhaPersonalB },
    sessionIds,
    exercicios: EX,
    biSetGroup: BISET_GROUP,
    biSetMembers: [EX.crucifixo.name, EX.triceps.name],
    esperado: {
      agachamento: 'DISCOMFORT_PATTERN (2/5 substituições por "Dor ou desconforto")',
      remada: 'RECURRING_REPLACEMENT (3/5 substituições por "Equipamento ocupado"), selo aprovado',
      desenvolvimento: 'mistura de NAO_EXECUTADO e EXECUTADO_CONFORME_PRESCRITO',
      rosca: 'mistura de PARCIAL e EXECUTADO_CONFORME_PRESCRITO',
      biSet: 'Crucifixo com Halteres RECURRING_REPLACEMENT (3/5, "Equipamento ocupado") — está em par Bi-Set com Tríceps Corda (sempre conforme); "Revisar ficha" no card do Crucifixo deve pedir edição manual (D-BISET), nunca aplicar sozinho',
    },
  }, null, 2));
}

async function teardown(): Promise<void> {
  const dias = await pool.query(
    `DELETE FROM personal_workout_plan_days WHERE plan_id IN (SELECT id FROM personal_workout_plans WHERE title = $1)`,
    [PLAN_TITLE],
  );
  const sessoes = await pool.query(
    `DELETE FROM workout_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
    [EMAIL_ALUNO],
  );
  const planos = await pool.query(`DELETE FROM personal_workout_plans WHERE title = $1`, [PLAN_TITLE]);
  await pool.query(
    `DELETE FROM exercise_replacement_alternatives
      WHERE personal_id IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [EMAIL_PERSONAL_A, EMAIL_PERSONAL_B],
  );
  // Protocolos pessoais (workout_protocols scope='personal') referenciam
  // owner_personal_id — precisam sair antes do DELETE de users (mesmo defeito
  // documentado na suíte de integração da P2B).
  await pool.query(
    `DELETE FROM workout_protocols
      WHERE owner_personal_id IN (SELECT id FROM users WHERE email IN ($1, $2)) AND scope = 'personal'`,
    [EMAIL_PERSONAL_A, EMAIL_PERSONAL_B],
  );

  const { rows } = await pool.query<{ id: number; email: string }>(
    `DELETE FROM users WHERE email IN ($1, $2, $3) RETURNING id, email`,
    [EMAIL_ALUNO, EMAIL_PERSONAL_A, EMAIL_PERSONAL_B],
  );
  console.log(JSON.stringify({
    removidos: rows,
    planosRemovidos: planos.rowCount,
    diasRemovidos: dias.rowCount,
    sessoesRemovidas: sessoes.rowCount,
  }, null, 2));
}

const modo = process.argv[2];
const acao = modo === '--teardown' ? teardown : modo === '--setup' ? setup : null;
if (!acao) {
  console.error('uso: qaP2bFixture.ts --setup | --teardown');
  process.exit(1);
}
acao()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('ERRO:', err.message, err.stack);
    await pool.end();
    process.exit(1);
  });
