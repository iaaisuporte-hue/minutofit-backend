/**
 * Sinais determinísticos — unitários (Spec 033, Onda P5).
 *
 * Cada sinal tem uma fixture que o dispara e, quando a regra tem uma condição
 * que separa o caso legítimo do falso positivo, uma fixture vizinha que NÃO o
 * dispara. Testar só a presença provaria que o código roda, não que a regra
 * está certa — e a regra é o produto aqui.
 */
import fs from 'fs';
import path from 'path';

import {
  SIGNAL_RULES,
  buildSignals,
  type SignalType,
} from '../modules/performance/insights.engine';

type Input = Parameters<typeof buildSignals>[0];

/** Aluno sem nada acontecendo: nenhuma regra dispara. É o ponto de partida. */
const NEUTRO: Input = {
  score: 60,
  scorePrevious: 60,
  loadBand: 'within',
  activeDaysThisWeek: 3,
  activeDaysLastWeek: 3,
  recentPrCount: 0,
  daysSinceLastPr: 10,
  sessionsInStallWindow: 12,
  keyExercises: { total: 4, improved: 1 },
  goalsAchievedRecently: [],
  activeGoals: [],
};

const com = (over: Partial<Input>): Input => ({ ...NEUTRO, ...over });
const tipos = (input: Input): SignalType[] => buildSignals(input).map((s) => s.type);
const acha = (input: Input, type: SignalType) => buildSignals(input).find((s) => s.type === type);

describe('nenhum sinal quando não há novidade', () => {
  it('aluno estável não gera cartão nenhum', () => {
    expect(buildSignals(NEUTRO)).toHaveLength(0);
  });
});

describe('GOAL_ACHIEVED', () => {
  it('dispara com a meta concluída na janela e nomeia a meta', () => {
    const s = acha(com({ goalsAchievedRecently: [{ label: 'Supino: carga de 100 kg', daysAgo: 3 }] }), 'GOAL_ACHIEVED');
    expect(s?.severity).toBe('positive');
    expect(s?.description).toContain('Supino: carga de 100 kg');
    expect(s?.evidence).toEqual({ goal: 'Supino: carga de 100 kg', daysAgo: 3 });
  });

  it('usa o rótulo canônico vindo do backend, não remonta o texto', () => {
    // O label chega pronto de `goalDisplayLabel`. Se este teste quebrar porque
    // alguém passou a formatar aqui, a tela do personal e a do aluno vão
    // divergir na primeira mudança de redação.
    const s = acha(com({ goalsAchievedRecently: [{ label: 'X × 12 reps', daysAgo: 0 }] }), 'GOAL_ACHIEVED');
    expect(s?.description).toContain('X × 12 reps');
  });
});

describe('RECENT_PR', () => {
  it('conta os recordes da janela e mostra a evidência', () => {
    const s = acha(com({ recentPrCount: 3 }), 'RECENT_PR');
    expect(s?.title).toBe('3 recordes recentes');
    expect(s?.evidence.count).toBe(3);
    expect(s?.evidence.windowDays).toBe(SIGNAL_RULES.RECENT_WINDOW_DAYS);
  });

  it('não dispara sem recorde algum', () => {
    expect(tipos(com({ recentPrCount: 0 }))).not.toContain('RECENT_PR');
  });
});

describe('GOAL_NEAR_COMPLETION', () => {
  it('dispara a partir do limiar e informa o percentual', () => {
    const s = acha(com({ activeGoals: [{ label: 'Supino 100 kg', progress: 0.87 }] }), 'GOAL_NEAR_COMPLETION');
    expect(s?.description).toContain('87%');
    expect(s?.evidence.progressPct).toBe(87);
  });

  it('não dispara abaixo do limiar', () => {
    expect(tipos(com({ activeGoals: [{ label: 'x', progress: 0.5 }] }))).not.toContain('GOAL_NEAR_COMPLETION');
  });

  it('meta já em 100% não é "quase lá" — ela é conquista, e vem por outro sinal', () => {
    expect(tipos(com({ activeGoals: [{ label: 'x', progress: 1 }] }))).not.toContain('GOAL_NEAR_COMPLETION');
  });

  it('meta sem medição não vira "quase lá" por engano', () => {
    expect(tipos(com({ activeGoals: [{ label: 'x', progress: null }] }))).not.toContain('GOAL_NEAR_COMPLETION');
  });
});

describe('CONSISTENCY_DOWN', () => {
  it('dispara na queda relevante e traz os dois números', () => {
    const s = acha(com({ activeDaysLastWeek: 4, activeDaysThisWeek: 2 }), 'CONSISTENCY_DOWN');
    expect(s?.severity).toBe('attention');
    expect(s?.evidence).toEqual({ current: 2, previous: 4, period: 'week' });
  });

  it('queda de um dia só é variação normal de rotina', () => {
    expect(tipos(com({ activeDaysLastWeek: 4, activeDaysThisWeek: 3 }))).not.toContain('CONSISTENCY_DOWN');
  });

  it('quem treinava 2 dias e foi a 0 não gera "queda" — é ausência, e outro motor cobre', () => {
    expect(tipos(com({ activeDaysLastWeek: 2, activeDaysThisWeek: 0 }))).not.toContain('CONSISTENCY_DOWN');
  });

  it('sem medição de uma das semanas, não afirma nada', () => {
    expect(tipos(com({ activeDaysLastWeek: null, activeDaysThisWeek: 0 }))).not.toContain('CONSISTENCY_DOWN');
  });
});

describe('PROGRESSION_STALLED', () => {
  it('exige tempo sem recorde E treino acontecendo', () => {
    const s = acha(
      com({ daysSinceLastPr: 70, sessionsInStallWindow: 20, score: 50, scorePrevious: 50 }),
      'PROGRESSION_STALLED',
    );
    expect(s?.severity).toBe('attention');
    expect(s?.evidence.sessions).toBe(20);
  });

  it('sem treino no período não é estagnação — é interrupção', () => {
    // A diferença importa: dizer "estagnou" a quem parou de treinar manda o
    // personal mexer no programa quando o problema é presença.
    expect(tipos(com({ daysSinceLastPr: 70, sessionsInStallWindow: 2 }))).not.toContain('PROGRESSION_STALLED');
  });

  it('duas semanas sem recorde não é platô', () => {
    expect(tipos(com({ daysSinceLastPr: 14, sessionsInStallWindow: 20 }))).not.toContain('PROGRESSION_STALLED');
  });

  it('quem nunca bateu recorde não é acusado de estagnar', () => {
    expect(tipos(com({ daysSinceLastPr: null, sessionsInStallWindow: 30 }))).not.toContain('PROGRESSION_STALLED');
  });
});

describe('carga', () => {
  it('pico é atenção; acima do padrão é neutro', () => {
    expect(acha(com({ loadBand: 'spike' }), 'LOAD_UP')?.severity).toBe('attention');
    expect(acha(com({ loadBand: 'above' }), 'LOAD_UP')?.severity).toBe('neutral');
  });

  it('abaixo do padrão é observação, não repreensão', () => {
    expect(acha(com({ loadBand: 'below' }), 'LOAD_DOWN')?.severity).toBe('neutral');
  });

  it('sem faixa, nenhum sinal de carga', () => {
    const t = tipos(com({ loadBand: null }));
    expect(t).not.toContain('LOAD_UP');
    expect(t).not.toContain('LOAD_DOWN');
  });

  it('descreve sem prescrever — nada de "reduza" ou "aumente"', () => {
    for (const band of ['spike', 'above', 'below'] as const) {
      const s = buildSignals(com({ loadBand: band }))[0];
      expect(s.description).not.toMatch(/reduz|aument[ae]|diminu|descans/i);
    }
  });
});

describe('PROGRESSION_POSITIVE', () => {
  it('dispara quando metade dos comparáveis melhora', () => {
    const s = acha(com({ keyExercises: { total: 4, improved: 3 } }), 'PROGRESSION_POSITIVE');
    expect(s?.evidence).toEqual({ improved: 3, total: 4, ratioPct: 75 });
  });

  it('um único exercício comparável não sustenta a afirmação', () => {
    expect(tipos(com({ keyExercises: { total: 1, improved: 1 } }))).not.toContain('PROGRESSION_POSITIVE');
  });
});

describe('movimento do score', () => {
  it('sobe acima do limiar e traz os dois valores', () => {
    const s = acha(com({ score: 70, scorePrevious: 60, keyExercises: { total: 4, improved: 0 } }), 'SCORE_UP');
    expect(s?.evidence).toEqual({ current: 70, previous: 60, delta: 10 });
  });

  it('variação pequena é ruído e não vira cartão', () => {
    expect(tipos(com({ score: 62, scorePrevious: 60 }))).not.toContain('SCORE_UP');
  });

  it('sem histórico de score, nenhum movimento é afirmado', () => {
    expect(tipos(com({ score: 80, scorePrevious: null }))).not.toContain('SCORE_UP');
  });
});

describe('dedupe: o resumo sai quando a causa está visível', () => {
  it('SCORE_UP some quando a progressão já explica a subida', () => {
    const t = tipos(com({ score: 75, scorePrevious: 60, keyExercises: { total: 4, improved: 3 } }));
    expect(t).toContain('PROGRESSION_POSITIVE');
    expect(t).not.toContain('SCORE_UP');
  });

  it('SCORE_UP some quando houve recorde', () => {
    const t = tipos(com({ score: 75, scorePrevious: 60, recentPrCount: 2, keyExercises: { total: 4, improved: 0 } }));
    expect(t).toContain('RECENT_PR');
    expect(t).not.toContain('SCORE_UP');
  });

  it('SCORE_UP sobrevive quando nada mais explica a subida', () => {
    expect(tipos(com({ score: 75, scorePrevious: 60, keyExercises: { total: 4, improved: 0 } }))).toContain('SCORE_UP');
  });

  it('SCORE_DOWN some quando a queda de frequência já explica', () => {
    const t = tipos(com({ score: 50, scorePrevious: 65, activeDaysLastWeek: 4, activeDaysThisWeek: 1 }));
    expect(t).toContain('CONSISTENCY_DOWN');
    expect(t).not.toContain('SCORE_DOWN');
  });
});

describe('ordenação e limite', () => {
  const cheio = com({
    score: 80,
    scorePrevious: 60,
    loadBand: 'spike',
    activeDaysLastWeek: 5,
    activeDaysThisWeek: 1,
    recentPrCount: 2,
    daysSinceLastPr: 1,
    keyExercises: { total: 4, improved: 4 },
    goalsAchievedRecently: [{ label: 'Meta A', daysAgo: 1 }],
    activeGoals: [{ label: 'Meta B', progress: 0.9 }],
  });

  it('conquista vem antes de atenção, que vem antes de neutro', () => {
    const sev = buildSignals(cheio).map((s) => s.severity);
    const ordem = { positive: 0, attention: 1, neutral: 2 } as const;
    const valores = sev.map((s) => ordem[s]);
    expect(valores).toEqual([...valores].sort((a, b) => a - b));
  });

  it('nunca passa do teto de cartões', () => {
    expect(buildSignals(cheio).length).toBeLessThanOrEqual(SIGNAL_RULES.MAX_SIGNALS);
  });

  it('é determinística: a mesma entrada dá a mesma lista, na mesma ordem', () => {
    // O personal abre a tela do mesmo aluno duas vezes no mesmo dia. Se a ordem
    // mudar, ele passa a desconfiar do que lê.
    expect(tipos(cheio)).toEqual(tipos(cheio));
  });
});

describe('linguagem', () => {
  const todos = [
    com({ loadBand: 'spike', activeDaysLastWeek: 5, activeDaysThisWeek: 1 }),
    com({ daysSinceLastPr: 90, sessionsInStallWindow: 30 }),
    com({ score: 40, scorePrevious: 70 }),
    com({ recentPrCount: 1, goalsAchievedRecently: [{ label: 'M', daysAgo: 2 }] }),
  ];

  it('nenhum sinal usa linguagem clínica', () => {
    const proibidas = /overtraining|lesã|patolog|síndrome|doen|diagnóst|sobretreino/i;
    for (const input of todos) {
      for (const s of buildSignals(input)) {
        expect(`${s.title} ${s.description}`).not.toMatch(proibidas);
      }
    }
  });

  it('todo sinal carrega evidência não vazia', () => {
    for (const input of todos) {
      for (const s of buildSignals(input)) {
        expect(Object.keys(s.evidence).length).toBeGreaterThan(0);
        expect(s.period).toBeTruthy();
      }
    }
  });

  it('severidade fica nos três níveis contidos — nada de "crítico"', () => {
    for (const input of todos) {
      for (const s of buildSignals(input)) {
        expect(['positive', 'neutral', 'attention']).toContain(s.severity);
      }
    }
  });
});

/**
 * Contrato das rotas da P5 — lido do fonte.
 *
 * O serviço `getStudentPerformanceSnapshot` valida VÍNCULO, e só. O
 * consentimento é aplicado pelo middleware da rota, o que significa que os
 * testes de serviço, sozinhos, não provam que o aluno está protegido: remover
 * `requireActiveConsent('workouts')` do arquivo de rotas deixaria a suíte
 * inteira verde com a porta aberta.
 *
 * Ler o fonte é grosseiro e é de propósito — é a checagem mais barata que falha
 * exatamente no dia em que alguém apaga a linha.
 */
describe('rotas da P5 exigem consent, e não só vínculo', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/personal.ts'), 'utf8');

  /** Janela do fonte a partir da declaração da rota. */
  const trecho = (rota: string, chars = 400): string => {
    const i = source.indexOf(rota);
    expect(i).toBeGreaterThan(-1);
    return source.slice(i, i + chars);
  };

  it('GET /performance passa por papel, consent de workouts e vínculo', () => {
    const rota = trecho("'/students/:studentId/performance',");
    expect(rota).toContain("roleCheckMiddleware('personal')");
    expect(rota).toContain("requireActiveConsent('workouts')");
    expect(rota).toContain('getStudentPerformanceSnapshot');
  });

  it('POST /performance/insight exige as mesmas trancas', () => {
    const rota = trecho("'/students/:studentId/performance/insight',");
    expect(rota).toContain("roleCheckMiddleware('personal')");
    expect(rota).toContain("requireActiveConsent('workouts')");
  });

  it('o insight é gated pelo plano do PERSONAL, não pelo do aluno', () => {
    // Janela maior: o gate fica algumas linhas dentro do handler.
    const rota = trecho("'/students/:studentId/performance/insight',", 900);
    expect(rota).toContain('getPersonalPlan');
    expect(rota).toContain('AI_NOT_ENABLED');
  });

  it('não existe rota de escrita do personal sobre performance do aluno', () => {
    // A P5 é leitura. Um PUT/PATCH/DELETE aqui significaria que alguém passou a
    // poder editar o histórico de esforço de outra pessoa.
    for (const verbo of ['router.put', 'router.patch', 'router.delete']) {
      const escritas = source.split(verbo).slice(1).map((t) => t.slice(0, 120));
      for (const t of escritas) {
        expect(t).not.toContain('/performance');
      }
    }
  });
});
