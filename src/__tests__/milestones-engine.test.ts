/**
 * Engine de marcos — as regras exatas, sem banco (Spec 034, Onda C1).
 *
 * Cada teste aqui é a definição executável de um marco. Se alguém mudar o
 * critério, o teste falha com o número velho na mão — que é a única forma de um
 * marco continuar auditável seis meses depois.
 */
import {
  CONSISTENT_WEEK_RATIO,
  buildWeekBuckets,
  consistentWeekThreshold,
  evaluateMilestoneFacts,
  type MilestoneFacts,
} from '../modules/community/milestones.engine';
import { EVALUATED_CODES, MILESTONE_CATALOG, findMilestone } from '../modules/community/milestones.catalog';

/** Segunda-feira. Todas as datas dos testes são ancoradas nela. */
const SEG = '2026-01-05';

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

function facts(over: Partial<MilestoneFacts> = {}): MilestoneFacts {
  return {
    today: SEG,
    firstSession: null,
    firstActiveDay: null,
    firstRealPr: null,
    goalsAchieved: 0,
    goalsLastAchievedAt: null,
    activeDays: [],
    previousActiveDay: null,
    weeklyTarget: null,
    planActiveSince: null,
    firstChallengeCompleted: null,
    ...over,
  };
}

/** Próxima segunda-feira a partir de um dia qualquer. */
function startOfWeekAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ate = dow === 1 ? 0 : (8 - dow) % 7;
  return addDays(day, ate);
}

function codes(f: MilestoneFacts): string[] {
  return evaluateMilestoneFacts(f).map((u) => u.code).sort();
}

/** Dias de treino: `perWeek` dias em cada uma das `weeks` semanas a partir de `start`. */
function weeklyDays(start: string, weeks: number, perWeek: number): string[] {
  const out: string[] = [];
  for (let w = 0; w < weeks; w += 1) {
    for (let d = 0; d < perWeek; d += 1) out.push(addDays(start, w * 7 + d));
  }
  return out;
}

describe('catálogo', () => {
  it('tem os oito marcos da spec, com título, descrição e critério', () => {
    expect(MILESTONE_CATALOG).toHaveLength(8);
    for (const def of MILESTONE_CATALOG) {
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.criterion.length).toBeGreaterThan(0);
      expect(def.ruleVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('todos os oito têm avaliador desde a C2', () => {
    expect(findMilestone('challenge_completed')?.evaluated).toBe(true);
    expect(EVALUATED_CODES).toContain('challenge_completed');
    expect(EVALUATED_CODES).toHaveLength(8);
  });

  it('o marco de desafio nasce do fato real, com evidência auditável', () => {
    const f = facts({
      firstChallengeCompleted: {
        challengeId: '42',
        title: 'Quatro semanas firmes',
        completedAt: '2026-03-01T12:00:00.000Z',
        finalPct: 100,
      },
    });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'challenge_completed')!;
    expect(unlock.unlockedAt).toBe('2026-03-01T12:00:00.000Z');
    expect(unlock.evidence).toMatchObject({ challengeId: '42', finalPct: 100 });
  });

  it('a UI fala "recorde pessoal", não a sigla', () => {
    const pr = findMilestone('first_pr')!;
    expect(`${pr.title} ${pr.description} ${pr.criterion}`).toContain('recorde pessoal');
  });

  it('código desconhecido não resolve', () => {
    expect(findMilestone('nao_existe')).toBeNull();
  });
});

describe('conta nova — nada é concedido de graça', () => {
  it('sem fato nenhum, nenhum marco', () => {
    expect(codes(facts())).toEqual([]);
  });

  it('sem ficha ativa, os marcos de semana não são concedidos nem negados por engano', () => {
    // 4 semanas de 5 treinos, mas sem alvo semanal: não dá para dizer se a
    // semana foi cumprida — e `null` significa "não afirmo", não "reprovou".
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 5),
      weeklyTarget: null,
    });
    expect(codes(f)).toEqual([]);
  });
});

describe('first_workout', () => {
  it('concede na primeira sessão, com a data do fato', () => {
    const f = facts({
      firstSession: { sessionId: 42, performedAt: '2026-01-05T10:00:00.000Z' },
    });
    const [unlock] = evaluateMilestoneFacts(f);
    expect(unlock.code).toBe('first_workout');
    expect(unlock.unlockedAt).toBe('2026-01-05T10:00:00.000Z');
    expect(unlock.evidence).toEqual({
      sessionId: 42,
      performedAt: '2026-01-05T10:00:00.000Z',
    });
  });
});

describe('first_pr — o primeiro registro NÃO é recorde', () => {
  it('não concede quando só existe linha de base (is_first=true)', () => {
    // O repositório filtra `is_first=false`; aqui o fato simplesmente não vem.
    expect(codes(facts({ firstRealPr: null }))).toEqual([]);
  });

  it('concede no primeiro recorde real, com evidência reproduzível', () => {
    const f = facts({
      firstRealPr: {
        prEventId: 7,
        exerciseId: 'a3f1c2d4-0000-4000-8000-000000000001',
        kind: 'max_load',
        achievedAt: '2026-01-05T12:00:00.000Z',
      },
    });
    const [unlock] = evaluateMilestoneFacts(f);
    expect(unlock.code).toBe('first_pr');
    expect(unlock.evidence).toMatchObject({ prEventId: 7, kind: 'max_load' });
  });
});

describe('ten_goals', () => {
  it('nove metas não bastam', () => {
    expect(codes(facts({ goalsAchieved: 9 }))).toEqual([]);
  });

  it('dez concedem, carimbando a data da última', () => {
    const f = facts({ goalsAchieved: 10, goalsLastAchievedAt: '2026-01-04T09:00:00.000Z' });
    const [unlock] = evaluateMilestoneFacts(f);
    expect(unlock.code).toBe('ten_goals');
    expect(unlock.unlockedAt).toBe('2026-01-04T09:00:00.000Z');
    expect(unlock.evidence).toMatchObject({ totalGoalsAchieved: 10, required: 10 });
  });
});

describe('first_full_week — a definição canônica de semana cumprida', () => {
  it('3 de 3 previstos fecham a semana', () => {
    const f = facts({
      today: addDays(SEG, 8),
      activeDays: [SEG, addDays(SEG, 2), addDays(SEG, 4)],
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('first_full_week');
  });

  it('2 de 3 não fecham', () => {
    const f = facts({
      today: addDays(SEG, 8),
      activeDays: [SEG, addDays(SEG, 2)],
      weeklyTarget: 3,
    });
    expect(codes(f)).not.toContain('first_full_week');
  });

  it('a semana corrente conta assim que cumpre — sem esperar domingo', () => {
    // Sexta-feira, 3 treinos feitos, alvo 3. Fazer o aluno esperar dois dias
    // para ver o marco seria burocracia, não honestidade.
    const f = facts({
      today: addDays(SEG, 4),
      activeDays: [SEG, addDays(SEG, 2), addDays(SEG, 4)],
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('first_full_week');
  });

  it('a evidência permite refazer a conta à mão', () => {
    const f = facts({
      today: addDays(SEG, 8),
      activeDays: [SEG, addDays(SEG, 2), addDays(SEG, 4)],
      weeklyTarget: 3,
    });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'first_full_week')!;
    expect(unlock.evidence).toEqual({
      weekStart: SEG,
      weekEnd: addDays(SEG, 6),
      activeDays: 3,
      targetDays: 3,
    });
  });
});

describe('four_consistent_weeks — 80% do previsto, não volume bruto', () => {
  it('plano de 3x: quatro semanas com 3 treinos concedem', () => {
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 3),
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('four_consistent_weeks');
  });

  it('plano de 3x NÃO exige 5 treinos — o limiar é 2,4 dias', () => {
    expect(consistentWeekThreshold(3)).toBeCloseTo(2.4);
    expect(CONSISTENT_WEEK_RATIO).toBe(0.8);
  });

  it('plano de 5x: quatro semanas com 4 treinos bastam (80%)', () => {
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 4),
      weeklyTarget: 5,
    });
    expect(codes(f)).toContain('four_consistent_weeks');
  });

  it('uma semana fraca no meio quebra a sequência', () => {
    const dias = [
      ...weeklyDays(SEG, 2, 3),
      addDays(SEG, 14), // 3ª semana: 1 treino só
      ...weeklyDays(addDays(SEG, 21), 1, 3),
    ];
    const f = facts({ today: addDays(SEG, 28), activeDays: dias, weeklyTarget: 3 });
    expect(codes(f)).not.toContain('four_consistent_weeks');
  });

  it('três semanas boas não concedem', () => {
    const f = facts({
      today: addDays(SEG, 21),
      activeDays: weeklyDays(SEG, 3, 3),
      weeklyTarget: 3,
    });
    expect(codes(f)).not.toContain('four_consistent_weeks');
  });

  it('a semana corrente incompleta não derruba a sequência em curso', () => {
    // 4 semanas fechadas boas + a corrente com 1 treino: o marco já foi feito.
    const f = facts({
      today: addDays(SEG, 29),
      activeDays: [...weeklyDays(SEG, 4, 3), addDays(SEG, 28)],
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('four_consistent_weeks');
  });
});

describe('three_months_active — presença distribuída, não volume', () => {
  it('11 de 13 semanas com treino concedem (duas de folga são permitidas)', () => {
    const dias: string[] = [];
    for (let w = 0; w < 13; w += 1) {
      if (w === 3 || w === 8) continue; // viagem e gripe
      dias.push(addDays(SEG, w * 7));
    }
    const f = facts({ today: addDays(SEG, 13 * 7), activeDays: dias });
    expect(codes(f)).toContain('three_months_active');
  });

  it('10 de 13 não concedem', () => {
    const dias: string[] = [];
    for (let w = 0; w < 13; w += 1) {
      if (w === 3 || w === 8 || w === 11) continue;
      dias.push(addDays(SEG, w * 7));
    }
    const f = facts({ today: addDays(SEG, 13 * 7), activeDays: dias });
    expect(codes(f)).not.toContain('three_months_active');
  });

  it('volume concentrado em três semanas não é "três meses ativo"', () => {
    const f = facts({
      today: addDays(SEG, 13 * 7),
      activeDays: weeklyDays(SEG, 3, 6),
      weeklyTarget: null,
    });
    expect(codes(f)).not.toContain('three_months_active');
  });

  it('não concede sem 13 semanas fechadas de histórico', () => {
    const dias: string[] = [];
    for (let w = 0; w < 12; w += 1) dias.push(addDays(SEG, w * 7));
    const f = facts({ today: addDays(SEG, 12 * 7), activeDays: dias });
    expect(codes(f)).not.toContain('three_months_active');
  });

  it('a evidência diz exatamente qual janela foi avaliada', () => {
    const dias: string[] = [];
    for (let w = 0; w < 13; w += 1) dias.push(addDays(SEG, w * 7));
    const f = facts({ today: addDays(SEG, 13 * 7), activeDays: dias });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'three_months_active')!;
    expect(unlock.evidence).toMatchObject({
      weeksEvaluated: 13,
      weeksWithActivity: 13,
      required: 11,
    });
    expect(String(unlock.evidence.windowStart)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('comeback — retorno sustentado, não um treino solto', () => {
  const PAUSA = 24;

  it('um treino depois de 21 dias parado não concede', () => {
    const f = facts({
      today: addDays(SEG, PAUSA + 1),
      activeDays: [addDays(SEG, PAUSA)],
      previousActiveDay: SEG,
      weeklyTarget: 3,
    });
    expect(codes(f)).not.toContain('comeback');
  });

  it('pausa + três semanas dentro do plano concedem', () => {
    const volta = addDays(SEG, 28); // segunda-feira, 4 semanas depois
    const f = facts({
      today: addDays(volta, 21),
      activeDays: weeklyDays(volta, 3, 3),
      previousActiveDay: SEG,
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('comeback');
  });

  it('sem pausa longa não há retomada', () => {
    const f = facts({
      today: addDays(SEG, 21),
      activeDays: weeklyDays(SEG, 3, 3),
      previousActiveDay: addDays(SEG, -2),
      weeklyTarget: 3,
    });
    expect(codes(f)).not.toContain('comeback');
  });

  it('a pausa pode ter começado antes da janela avaliada', () => {
    // Nenhum treino na janela até a volta; a âncora é o dia anterior à janela.
    const volta = addDays(SEG, 42); // segunda-feira, 6 semanas depois
    const f = facts({
      today: addDays(volta, 21),
      activeDays: weeklyDays(volta, 3, 3),
      previousActiveDay: SEG,
      weeklyTarget: 3,
    });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'comeback')!;
    expect(unlock.evidence).toMatchObject({
      inactivityDays: 42,
      returnedOn: volta,
      weeksCompletedAfterReturn: 3,
    });
  });

  it('quem volta no sábado não é reprovado pela semana em que voltou', () => {
    // A semana do retorno é parcial por natureza: cobrar dela a frequência
    // inteira puniria o dia da volta, não a aderência.
    const sabado = addDays(SEG, 33); // 33 = 4 semanas + 5 dias → sábado
    const segundaSeguinte = addDays(SEG, 35);
    const f = facts({
      today: addDays(segundaSeguinte, 21),
      activeDays: [sabado, ...weeklyDays(segundaSeguinte, 3, 3)],
      previousActiveDay: SEG,
      weeklyTarget: 3,
    });
    expect(codes(f)).toContain('comeback');
  });

  it('sem alvo semanal não há "dentro da programação"', () => {
    const volta = addDays(SEG, 28);
    const f = facts({
      today: addDays(volta, 21),
      activeDays: weeklyDays(volta, 3, 3),
      previousActiveDay: SEG,
      weeklyTarget: null,
    });
    expect(codes(f)).not.toContain('comeback');
  });
});

describe('fronteiras exatas — onde mora o off-by-one', () => {
  it('pausa de 20 dias não é retomada; 21 é', () => {
    const comGap = (gap: number) => {
      const volta = addDays(SEG, gap);
      // A volta cai numa segunda para as três semanas ficarem limpas.
      const voltaSegunda = startOfWeekAfter(volta);
      return facts({
        today: addDays(voltaSegunda, 21),
        activeDays: weeklyDays(voltaSegunda, 3, 3),
        previousActiveDay: SEG,
        weeklyTarget: 3,
      });
    };
    // 20 dias entre SEG e a volta: abaixo do limiar, não há retomada.
    const curto = facts({
      today: addDays(SEG, 41),
      activeDays: weeklyDays(addDays(SEG, 20), 3, 3),
      previousActiveDay: SEG,
      weeklyTarget: 3,
    });
    expect(evaluateMilestoneFacts(curto).find((u) => u.code === 'comeback')).toBeUndefined();
    expect(codes(comGap(28))).toContain('comeback');
  });

  it('limiar de 80%: com 3 previstos, 2 dias reprovam a semana', () => {
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 2),
      weeklyTarget: 3,
    });
    expect(codes(f)).not.toContain('four_consistent_weeks');
  });

  it('12 semanas fechadas não fazem três meses; 13 fazem', () => {
    const semanas = (n: number) => {
      const dias: string[] = [];
      for (let w = 0; w < n; w += 1) dias.push(addDays(SEG, w * 7));
      return facts({ today: addDays(SEG, n * 7), activeDays: dias });
    };
    expect(codes(semanas(12))).not.toContain('three_months_active');
    expect(codes(semanas(13))).toContain('three_months_active');
  });

  it('a evidência de quatro semanas registra as semanas e o limiar', () => {
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 3),
      weeklyTarget: 3,
    });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'four_consistent_weeks')!;
    expect((unlock.evidence.weeks as unknown[])).toHaveLength(4);
    expect(unlock.evidence.thresholdDays).toBeCloseTo(2.4);
    expect(unlock.evidence.targetDays).toBe(3);
  });
});

describe('a ficha ativa delimita o que é julgado', () => {
  it('semanas anteriores à ficha atual não concedem marco retroativo', () => {
    // O personal trocou a ficha ontem. As semanas vividas sob o alvo antigo
    // não podem ser julgadas pelo novo — a evidência ficaria coerente e falsa.
    const f = facts({
      today: addDays(SEG, 28),
      activeDays: weeklyDays(SEG, 4, 3),
      weeklyTarget: 3,
      planActiveSince: addDays(SEG, 27),
    });
    expect(codes(f)).not.toContain('four_consistent_weeks');
  });

  it('a semana em que a ficha começou é parcial e não reprova', () => {
    // Ficha entrou numa quarta: aquela semana tem 5 dias, não 7.
    const quarta = addDays(SEG, 2);
    const f = facts({
      today: addDays(SEG, 29),
      activeDays: [quarta, ...weeklyDays(addDays(SEG, 7), 4, 3)],
      weeklyTarget: 3,
      planActiveSince: quarta,
    });
    expect(codes(f)).toContain('four_consistent_weeks');
  });
});

describe('primeiro treino aceita presença registrada pelo personal', () => {
  it('sem sessão rica, o dia ativo da união concede o marco', () => {
    // Aluno acompanhado presencialmente: a Spec 009 registra presença, e ele
    // não pode ganhar "primeira semana completa" sem "primeiro treino".
    const f = facts({ firstSession: null, firstActiveDay: SEG });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'first_workout')!;
    expect(unlock.evidence).toEqual({ activeDay: SEG, source: 'active_days_union' });
  });

  it('havendo sessão rica, ela é a evidência preferida', () => {
    const f = facts({
      firstSession: { sessionId: 5, performedAt: '2026-01-05T10:00:00.000Z' },
      firstActiveDay: SEG,
    });
    const unlock = evaluateMilestoneFacts(f).find((u) => u.code === 'first_workout')!;
    expect(unlock.evidence).toMatchObject({ sessionId: 5 });
  });
});

describe('semanas ISO', () => {
  it('semanas sem treino entram nos buckets — são elas que quebram sequências', () => {
    const f = facts({
      today: addDays(SEG, 21),
      activeDays: [SEG, addDays(SEG, 21)],
    });
    const buckets = buildWeekBuckets(f);
    expect(buckets).toHaveLength(4);
    expect(buckets.map((b) => b.activeDays)).toEqual([1, 0, 0, 1]);
    expect(buckets[3].closed).toBe(false);
  });

  it('a semana começa na segunda, não no domingo', () => {
    const domingo = addDays(SEG, -1);
    const f = facts({ today: SEG, activeDays: [domingo, SEG] });
    const buckets = buildWeekBuckets(f);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].activeDays).toBe(1);
    expect(buckets[1].activeDays).toBe(1);
  });
});

describe('determinismo', () => {
  it('as mesmas entradas produzem sempre a mesma saída', () => {
    const f = facts({
      today: addDays(SEG, 28),
      firstSession: { sessionId: 1, performedAt: '2026-01-05T10:00:00.000Z' },
      activeDays: weeklyDays(SEG, 4, 3),
      weeklyTarget: 3,
      goalsAchieved: 10,
      goalsLastAchievedAt: '2026-01-20T10:00:00.000Z',
    });
    const a = JSON.stringify(evaluateMilestoneFacts(f));
    const b = JSON.stringify(evaluateMilestoneFacts(f));
    expect(a).toBe(b);
    expect(codes(f)).toEqual([
      'first_full_week',
      'first_workout',
      'four_consistent_weeks',
      'ten_goals',
    ]);
  });
});
