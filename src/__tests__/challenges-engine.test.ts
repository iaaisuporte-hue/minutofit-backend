/**
 * Engine de desafios — as regras, sem banco (Spec 034, Onda C2).
 *
 * O primeiro bloco é o teste que representa a TESE DO PRODUTO: progresso é
 * relativo ao próprio plano, e quem cumpre 3 de 3 fica à frente de quem cumpre
 * 3 de 4. Se ele cair, o produto virou um app de competição.
 */
import {
  CHALLENGE_KINDS,
  MIN_PARTICIPANTS_FOR_BANDS,
  RuleValidationError,
  bandOf,
  canTransitionChallenge,
  canTransitionParticipant,
  computeChallengeProgress,
  describeRule,
  effectiveState,
  parseChallengeRule,
  summarizeBands,
  weekPct,
  type WeekFact,
} from '../modules/community/challenges.engine';

const SEG = '2026-01-05'; // segunda-feira

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** `full` = a semana ISO cabe inteira na janela E já terminou. */
function semana(start: string, activeDays: number, weeklyTarget: number | null, full = true): WeekFact {
  return { start, activeDays, weeklyTarget, full };
}

/* ================================================================== *
 * A TESE
 * ================================================================== */

describe('A tese do produto · progresso é relativo ao próprio plano', () => {
  it('Everton (4 previstos, 3 feitos) = 75%; Pedro (3 previstos, 3 feitos) = 100%', () => {
    const everton = semana(SEG, 3, 4);
    const pedro = semana(SEG, 3, 3);

    expect(weekPct(everton)).toBe(75);
    expect(weekPct(pedro)).toBe(100);
  });

  it('Pedro cumpre MAIS que Everton com o MESMO número absoluto de treinos', () => {
    // Os dois treinaram 3 vezes. Volume absoluto é idêntico; cumprimento não.
    const treinosDeCadaUm = 3;
    const everton = weekPct(semana(SEG, treinosDeCadaUm, 4))!;
    const pedro = weekPct(semana(SEG, treinosDeCadaUm, 3))!;

    expect(pedro).toBeGreaterThan(everton);
  });

  it('e Pedro completa o desafio enquanto Everton não', () => {
    const regra = { minPct: 80, requiredWeeks: 4 };
    const semanasDe = (feitos: number, previstos: number) =>
      Array.from({ length: 4 }, (_, i) => semana(addDays(SEG, i * 7), feitos, previstos));

    const everton = computeChallengeProgress({
      kind: 'consistency',
      rule: regra,
      weeks: semanasDe(3, 4), // 75% por semana — abaixo do limiar de 80%
    });
    const pedro = computeChallengeProgress({
      kind: 'consistency',
      rule: regra,
      weeks: semanasDe(3, 3), // 100% por semana
    });

    expect(pedro.achieved).toBe(true);
    expect(everton.achieved).toBe(false);
    expect(pedro.weeksDone).toBe(4);
    expect(everton.weeksDone).toBe(0);
  });

  it('treinar ALÉM do previsto não passa de 100% — excesso não é vantagem', () => {
    // Premiar excesso convidaria a treinar demais, o oposto do produto.
    expect(weekPct(semana(SEG, 7, 3))).toBe(100);
  });

  it('sem frequência prevista, o cumprimento é null — nunca zero', () => {
    expect(weekPct(semana(SEG, 5, null))).toBeNull();
  });
});

/* ================================================================== *
 * Regras
 * ================================================================== */

describe('parseChallengeRule · nada executável vem do cliente', () => {
  it('normaliza a regra de consistência', () => {
    expect(parseChallengeRule('consistency', { minPct: 80, requiredWeeks: 4 })).toEqual({
      minPct: 80,
      requiredWeeks: 4,
    });
  });

  it('rejeita campo desconhecido em vez de ignorá-lo', () => {
    // Ignorar deixaria lixo no rule_json e daria a impressão de que a regra
    // fazia algo que nunca fez.
    expect(() =>
      parseChallengeRule('consistency', { minPct: 80, requiredWeeks: 4, bonus: 999 }),
    ).toThrow(RuleValidationError);
  });

  it('rejeita qualquer coisa que pareça código', () => {
    expect(() =>
      parseChallengeRule('consistency', { requiredWeeks: '4; DROP TABLE users' }),
    ).toThrow(RuleValidationError);
    expect(() =>
      parseChallengeRule('consistency', { requiredWeeks: 4, expr: '() => true' }),
    ).toThrow(RuleValidationError);
  });

  it('devolve objeto NOVO — o payload original nunca chega ao banco', () => {
    const entrada = { minPct: 80, requiredWeeks: 4 };
    const saida = parseChallengeRule('consistency', entrada);
    expect(saida).not.toBe(entrada);
  });

  it('rejeita valores fora de faixa e não-inteiros', () => {
    expect(() => parseChallengeRule('consistency', { minPct: 10, requiredWeeks: 4 })).toThrow();
    expect(() => parseChallengeRule('consistency', { minPct: 80, requiredWeeks: 0 })).toThrow();
    expect(() => parseChallengeRule('consistency', { minPct: 80, requiredWeeks: 99 })).toThrow();
    expect(() => parseChallengeRule('consistency', { minPct: 80, requiredWeeks: 2.5 })).toThrow();
  });

  it('exige requiredWeeks em todos os tipos', () => {
    for (const kind of CHALLENGE_KINDS) {
      expect(() => parseChallengeRule(kind, {})).toThrow(RuleValidationError);
    }
  });

  it('comeback exige a pausa mínima', () => {
    expect(parseChallengeRule('comeback', { minInactiveDays: 21, requiredWeeks: 3 })).toEqual({
      minInactiveDays: 21,
      requiredWeeks: 3,
    });
    expect(() => parseChallengeRule('comeback', { requiredWeeks: 3 })).toThrow();
  });

  it('array e null não são regra', () => {
    expect(() => parseChallengeRule('weekly_goal', [])).toThrow(RuleValidationError);
    expect(() => parseChallengeRule('weekly_goal', null)).toThrow(RuleValidationError);
  });

  it('a regra vira português legível para o convite', () => {
    expect(describeRule('consistency', { minPct: 80, requiredWeeks: 4 })).toContain('80%');
    expect(describeRule('weekly_goal', { requiredWeeks: 1 })).toContain('1 semana');
    expect(describeRule('comeback', { minInactiveDays: 21, requiredWeeks: 3 })).toContain('21 dias');
  });
});

/* ================================================================== *
 * Progresso por tipo
 * ================================================================== */

describe('consistency', () => {
  it('conclui quando N semanas batem o limiar', () => {
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      weeks: Array.from({ length: 4 }, (_, i) => semana(addDays(SEG, i * 7), 4, 4)),
    });
    expect(p).toMatchObject({ achieved: true, weeksDone: 4, weeksRequired: 4, pct: 100 });
  });

  it('semana fraca não conta, e o percentual reflete o que falta', () => {
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      weeks: [
        semana(SEG, 4, 4),
        semana(addDays(SEG, 7), 1, 4),
        semana(addDays(SEG, 14), 4, 4),
        semana(addDays(SEG, 21), 4, 4),
      ],
    });
    expect(p.weeksDone).toBe(3);
    expect(p.achieved).toBe(false);
    expect(p.pct).toBe(75);
  });

  it('sem alvo em nenhuma semana, o progresso é null e diz por quê', () => {
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      weeks: [semana(SEG, 5, null)],
    });
    expect(p.pct).toBeNull();
    expect(p.blockedReason).toBe('no_target');
  });
});

describe('weekly_goal', () => {
  it('usa a mesma régua de 80% — sem segunda definição de semana cumprida', () => {
    const p = computeChallengeProgress({
      kind: 'weekly_goal',
      rule: { requiredWeeks: 2 },
      weeks: [semana(SEG, 4, 5), semana(addDays(SEG, 7), 4, 5)],
    });
    expect(p.achieved).toBe(true);
  });
});

describe('comeback', () => {
  const regra = { minInactiveDays: 21, requiredWeeks: 3 };
  const tresBoas = Array.from({ length: 3 }, (_, i) => semana(addDays(SEG, i * 7), 3, 3));

  it('sem a pausa, não há retomada a medir', () => {
    const p = computeChallengeProgress({
      kind: 'comeback',
      rule: regra,
      weeks: tresBoas,
      inactivityDaysBefore: 5,
    });
    expect(p.achieved).toBe(false);
    expect(p.blockedReason).toBe('no_inactivity');
    expect(p.pct).toBeNull();
  });

  it('sem histórico anterior, também não afirma', () => {
    const p = computeChallengeProgress({
      kind: 'comeback',
      rule: regra,
      weeks: tresBoas,
      inactivityDaysBefore: null,
    });
    expect(p.blockedReason).toBe('no_inactivity');
  });

  it('com a pausa e três semanas dentro do plano, conclui', () => {
    const p = computeChallengeProgress({
      kind: 'comeback',
      rule: regra,
      weeks: tresBoas,
      inactivityDaysBefore: 30,
    });
    expect(p.achieved).toBe(true);
  });
});

/* ================================================================== *
 * Faixas
 * ================================================================== */

describe('Semana parcial · não conta e não reprova', () => {
  it('a semana truncada pela borda do desafio é ignorada', () => {
    // Sem isto, uma semana de 3 dias seria julgada contra o alvo de 7: quem
    // tem 5 previstos chegaria a 60% e nunca a cumpriria — quanto MAIOR a
    // frequência prescrita, mais o desafio puniria.
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 2 },
      weeks: [
        semana(SEG, 2, 5, false), // parcial: ignorada
        semana(addDays(SEG, 7), 5, 5),
        semana(addDays(SEG, 14), 5, 5),
      ],
    });
    expect(p.weeksDone).toBe(2);
    expect(p.achieved).toBe(true);
  });

  it('só semanas parciais → progresso null, nunca 0%', () => {
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      weeks: [semana(SEG, 1, 3, false)],
    });
    expect(p.pct).toBeNull();
  });

  it('desafio que ainda não teve semana nenhuma não afirma 0%', () => {
    const p = computeChallengeProgress({
      kind: 'consistency',
      rule: { minPct: 80, requiredWeeks: 4 },
      weeks: [],
    });
    expect(p.pct).toBeNull();
    expect(p.achieved).toBe(false);
  });
});

describe('A régua de 80% é a MESMA do módulo Performance', () => {
  it('DEFAULT_MIN_PCT deriva de WEEK_WITHIN_PLAN_RATIO, não é redigitado', async () => {
    const { WEEK_WITHIN_PLAN_RATIO } = await import(
      '../modules/performance/consistency.engine'
    );
    const { DEFAULT_MIN_PCT } = await import('../modules/community/challenges.engine');
    // Mudar a régua lá passa a mudar aqui: duas definições dariam o mesmo
    // aluno "dentro do plano" numa tela e reprovado na outra.
    expect(DEFAULT_MIN_PCT).toBe(WEEK_WITHIN_PLAN_RATIO * 100);
  });
});

describe('Faixas · agregado, nunca posição', () => {
  const pessoa = (pct: number | null, achieved = false) => ({ pct, achieved });

  it('some por inteiro com 4 participantes', () => {
    for (let n = 1; n <= 4; n += 1) {
      const grupo = Array.from({ length: n }, () => pessoa(50));
      expect(summarizeBands(grupo)).toBeNull();
    }
  });

  it('aparece com 5 — e o limiar é exatamente esse', () => {
    expect(MIN_PARTICIPANTS_FOR_BANDS).toBe(5);
    const grupo = Array.from({ length: 5 }, () => pessoa(50));
    expect(summarizeBands(grupo)).not.toBeNull();
  });

  it('a resposta traz contagens, jamais nomes ou percentuais alheios', () => {
    const bands = summarizeBands([
      pessoa(100, true),
      pessoa(90),
      pessoa(85),
      pessoa(40),
      pessoa(0),
    ])!;
    const serializado = JSON.stringify(bands);

    expect(serializado).not.toMatch(/userId|name|pct"?:\s*9[05]/);
    expect(bands.find((b) => b.band === 'completed')!.count).toBe(1);
    expect(bands.find((b) => b.band === 'almost')!.count).toBe(2);
    expect(bands.find((b) => b.band === 'in_progress')!.count).toBe(1);
    expect(bands.find((b) => b.band === 'inactive')!.count).toBe(1);
  });

  it('as quatro faixas sempre aparecem, mesmo zeradas — a ausência não é dica', () => {
    // Omitir faixa vazia contaria uma história sobre o grupo.
    const bands = summarizeBands(Array.from({ length: 5 }, () => pessoa(50)))!;
    expect(bands).toHaveLength(4);
  });

  it('classifica sem ordenar pessoas', () => {
    expect(bandOf(100, true)).toBe('completed');
    expect(bandOf(50, true)).toBe('completed'); // concluiu vale mais que o pct
    expect(bandOf(85, false)).toBe('almost');
    expect(bandOf(30, false)).toBe('in_progress');
    expect(bandOf(0, false)).toBe('inactive');
    expect(bandOf(null, false)).toBe('inactive');
  });
});

/* ================================================================== *
 * Estados
 * ================================================================== */

describe('Transições · o cliente executa AÇÃO, nunca escolhe estado', () => {
  it('participante segue o caminho previsto', () => {
    expect(canTransitionParticipant('invited', 'active')).toBe(true);
    expect(canTransitionParticipant('active', 'completed')).toBe(true);
    expect(canTransitionParticipant('active', 'left')).toBe(true);
    expect(canTransitionParticipant('left', 'invited')).toBe(true);
  });

  it('conclusão é terminal — nada volta de completed', () => {
    for (const destino of ['invited', 'active', 'left', 'completed'] as const) {
      expect(canTransitionParticipant('completed', destino)).toBe(false);
    }
  });

  it('quem saiu não volta sozinho a ativo — só por novo convite', () => {
    expect(canTransitionParticipant('left', 'active')).toBe(false);
    expect(canTransitionParticipant('left', 'completed')).toBe(false);
  });

  it('convidado não pula direto para concluído', () => {
    expect(canTransitionParticipant('invited', 'completed')).toBe(false);
  });

  it('desafio cancelado ou encerrado é terminal', () => {
    expect(canTransitionChallenge('cancelled', 'active')).toBe(false);
    expect(canTransitionChallenge('finished', 'active')).toBe(false);
    expect(canTransitionChallenge('active', 'finished')).toBe(true);
    expect(canTransitionChallenge('active', 'cancelled')).toBe(true);
  });
});

describe('Estado efetivo · a data manda, não só a coluna', () => {
  const INICIO = '2026-02-01';
  const FIM = '2026-02-28';

  it('antes da janela é agendado', () => {
    expect(effectiveState('active', INICIO, FIM, '2026-01-20')).toBe('scheduled');
  });

  it('dentro da janela é em andamento — inclusive no primeiro e no último dia', () => {
    expect(effectiveState('active', INICIO, FIM, INICIO)).toBe('running');
    expect(effectiveState('active', INICIO, FIM, FIM)).toBe('running');
  });

  it('depois da janela é encerrado, mesmo com a coluna dizendo active', () => {
    // Sem isto seria preciso um cron para virar estados — e sem o cron a tela
    // mostraria "em andamento" por tempo indeterminado.
    expect(effectiveState('active', INICIO, FIM, '2026-03-01')).toBe('ended');
  });

  it('cancelado vence a data', () => {
    expect(effectiveState('cancelled', INICIO, FIM, '2026-02-10')).toBe('cancelled');
  });
});
