/**
 * Sinais de performance — função pura (Spec 033, Onda P5).
 *
 * ## O que é um sinal, e o que ele não é
 *
 * Um sinal é uma FRASE VERIFICÁVEL sobre o que os dados mostram, com a evidência
 * que a sustenta anexada. "A frequência caiu de 4 para 2 dias na última semana" é
 * um sinal. "Seu aluno está em overtraining" não é: é diagnóstico, exige dado
 * fisiológico que este produto não coleta, e nenhuma regra deste arquivo produz
 * linguagem clínica.
 *
 * Cada sinal carrega `evidence` com os números crus que o dispararam. É o que
 * permite ao personal discordar do sistema — ele vê a conta, não só a conclusão.
 * Um sinal sem evidência seria uma opinião com aparência de dado.
 *
 * ## Determinístico, e primeiro
 *
 * Nada aqui passa por modelo de linguagem. A IA da P5 é camada de SÍNTESE sobre
 * o que este arquivo produz: ela reescreve, prioriza e resume — nunca calcula,
 * nunca decide se um sinal existe. Com o provedor fora do ar, a tela continua
 * inteira, porque os fatos e os sinais nunca dependeram dele.
 *
 * ## Severidade contida
 *
 * Três níveis: `positive`, `neutral`, `attention`. Não existe "crítico" nem
 * "perigo" — variação de treino é variação de treino, e um vocabulário de
 * emergência aplicado a uma semana com dois treinos ensina o personal a ignorar
 * o alerta quando algo realmente importar.
 */

export type SignalType =
  | 'GOAL_ACHIEVED'
  | 'RECENT_PR'
  | 'GOAL_NEAR_COMPLETION'
  | 'CONSISTENCY_DOWN'
  | 'PROGRESSION_STALLED'
  | 'LOAD_UP'
  | 'LOAD_DOWN'
  | 'PROGRESSION_POSITIVE'
  | 'SCORE_UP'
  | 'SCORE_DOWN';

export type SignalSeverity = 'positive' | 'neutral' | 'attention';

export interface PerformanceSignal {
  type: SignalType;
  severity: SignalSeverity;
  title: string;
  description: string;
  /** Janela observada, em texto curto ("últimos 28 dias"). */
  period: string;
  /** Os números crus que sustentam o sinal. Sem isto, é opinião. */
  evidence: Record<string, number | string | null>;
}

/**
 * Limiares, todos num lugar só.
 *
 * Espalhar `0.8` pelo código faria com que "meta quase lá" significasse coisas
 * diferentes na tela e no insight. Nenhum destes números está na spec — foram
 * escolhidos aqui, e é por isso que ficam nomeados e documentados em vez de
 * embutidos numa comparação.
 */
export const SIGNAL_RULES = Object.freeze({
  /** Meta "quase lá". 80% é perto o bastante para valer um empurrão. */
  GOAL_NEAR_PCT: 0.8,
  /** Conquista "recente": além disso vira histórico, não notícia. */
  RECENT_WINDOW_DAYS: 28,
  /** Movimento de score que vale mencionar. Abaixo disso é ruído. */
  SCORE_DELTA_MIN: 5,
  /** Queda de frequência: precisa de uma base para cair DE. */
  CONSISTENCY_PREV_MIN: 3,
  CONSISTENCY_DROP_MIN: 2,
  /** Estagnação: tempo sem recorde... */
  STALL_DAYS: 56,
  /** ...com treino acontecendo. Sem isto, "parou de evoluir" é "parou de treinar". */
  STALL_MIN_SESSIONS: 8,
  /** Progressão positiva: metade dos exercícios comparáveis melhorando. */
  PROGRESSION_MIN_EXERCISES: 2,
  PROGRESSION_IMPROVED_PCT: 0.5,
  /** Teto de sinais exibidos de uma vez. */
  MAX_SIGNALS: 5,
});

export interface SignalInput {
  /** Score de hoje e o de ~28 dias atrás. `null` quando não há o que afirmar. */
  score: number | null;
  scorePrevious: number | null;
  /** Faixa de ritmo de carga da P3. */
  loadBand: 'below' | 'within' | 'above' | 'spike' | null;
  /** Dias ativos: semana corrente e a anterior. */
  activeDaysThisWeek: number | null;
  activeDaysLastWeek: number | null;
  /** Recordes reais (não estreias) na janela recente. */
  recentPrCount: number;
  /** Dias desde o último recorde. `null` = nunca houve. */
  daysSinceLastPr: number | null;
  /** Sessões executadas na janela de estagnação. */
  sessionsInStallWindow: number;
  /** Exercícios comparáveis e quantos melhoraram (mesma conta do score). */
  keyExercises: { total: number; improved: number };
  /** Metas concluídas na janela recente, com o rótulo canônico. */
  goalsAchievedRecently: { label: string; daysAgo: number }[];
  /** Metas ativas com progresso conhecido. */
  activeGoals: { label: string; progress: number | null }[];
}

function pct(n: number): number {
  return Math.round(n * 100);
}

/**
 * Produz os sinais brutos, antes de dedupe e ordenação.
 *
 * Cada bloco é independente: um sinal que não pode ser sustentado pelos dados
 * simplesmente não entra. Nenhum deles inventa um valor ausente — `null` faz o
 * bloco inteiro ser pulado, e não vira zero.
 */
function detectSignals(input: SignalInput): PerformanceSignal[] {
  const out: PerformanceSignal[] = [];
  const R = SIGNAL_RULES;

  // ── Metas concluídas ─────────────────────────────────────────────────────
  for (const goal of input.goalsAchievedRecently) {
    out.push({
      type: 'GOAL_ACHIEVED',
      severity: 'positive',
      title: 'Meta atingida',
      description: `${goal.label} — concluída há ${goal.daysAgo === 0 ? 'menos de um dia' : `${goal.daysAgo} dia${goal.daysAgo === 1 ? '' : 's'}`}.`,
      period: `últimos ${R.RECENT_WINDOW_DAYS} dias`,
      evidence: { goal: goal.label, daysAgo: goal.daysAgo },
    });
  }

  // ── Recordes ─────────────────────────────────────────────────────────────
  if (input.recentPrCount > 0) {
    out.push({
      type: 'RECENT_PR',
      severity: 'positive',
      title: input.recentPrCount === 1 ? '1 recorde recente' : `${input.recentPrCount} recordes recentes`,
      description: `O aluno superou a própria marca ${input.recentPrCount === 1 ? 'uma vez' : `${input.recentPrCount} vezes`} nos últimos ${R.RECENT_WINDOW_DAYS} dias.`,
      period: `últimos ${R.RECENT_WINDOW_DAYS} dias`,
      evidence: { count: input.recentPrCount, windowDays: R.RECENT_WINDOW_DAYS },
    });
  }

  // ── Meta quase concluída ─────────────────────────────────────────────────
  for (const goal of input.activeGoals) {
    if (goal.progress != null && goal.progress >= R.GOAL_NEAR_PCT && goal.progress < 1) {
      out.push({
        type: 'GOAL_NEAR_COMPLETION',
        severity: 'neutral',
        title: 'Meta perto do alvo',
        description: `${goal.label} está em ${pct(goal.progress)}%.`,
        period: 'agora',
        evidence: { goal: goal.label, progressPct: pct(goal.progress) },
      });
    }
  }

  // ── Queda de frequência ──────────────────────────────────────────────────
  // Exige uma base de onde cair: sair de 1 para 0 não é queda de rotina, é
  // ausência de rotina — e isso o motor de risco do dashboard já cobre.
  if (
    input.activeDaysThisWeek != null &&
    input.activeDaysLastWeek != null &&
    input.activeDaysLastWeek >= R.CONSISTENCY_PREV_MIN &&
    input.activeDaysLastWeek - input.activeDaysThisWeek >= R.CONSISTENCY_DROP_MIN
  ) {
    out.push({
      type: 'CONSISTENCY_DOWN',
      severity: 'attention',
      title: 'Frequência caiu',
      description: `De ${input.activeDaysLastWeek} para ${input.activeDaysThisWeek} dias de treino de uma semana para a outra.`,
      period: 'semana',
      evidence: {
        current: input.activeDaysThisWeek,
        previous: input.activeDaysLastWeek,
        period: 'week',
      },
    });
  }

  // ── Estagnação ───────────────────────────────────────────────────────────
  // Duas condições, e a segunda é o que separa "parou de evoluir" de "parou de
  // treinar": só se chama estagnação quando o aluno ESTEVE treinando.
  if (
    input.daysSinceLastPr != null &&
    input.daysSinceLastPr >= R.STALL_DAYS &&
    input.sessionsInStallWindow >= R.STALL_MIN_SESSIONS
  ) {
    out.push({
      type: 'PROGRESSION_STALLED',
      severity: 'attention',
      title: 'Sem recorde há um tempo',
      description: `${input.sessionsInStallWindow} treinos nos últimos ${R.STALL_DAYS} dias, sem superar marca anterior.`,
      period: `últimos ${R.STALL_DAYS} dias`,
      evidence: {
        daysSinceLastPr: input.daysSinceLastPr,
        sessions: input.sessionsInStallWindow,
        windowDays: R.STALL_DAYS,
      },
    });
  }

  // ── Ritmo de carga ───────────────────────────────────────────────────────
  // Descreve, não recomenda. "Acima do padrão dele" é observação; "reduza a
  // carga" seria prescrição, e quem prescreve é o personal.
  if (input.loadBand === 'above' || input.loadBand === 'spike') {
    out.push({
      type: 'LOAD_UP',
      severity: input.loadBand === 'spike' ? 'attention' : 'neutral',
      title: 'Carga acima do padrão dele',
      description:
        input.loadBand === 'spike'
          ? 'A carga da última semana ficou bem acima do ritmo habitual do aluno.'
          : 'A carga da última semana ficou acima do ritmo habitual do aluno.',
      period: 'últimos 7 dias vs. 28',
      evidence: { band: input.loadBand },
    });
  } else if (input.loadBand === 'below') {
    out.push({
      type: 'LOAD_DOWN',
      severity: 'neutral',
      title: 'Carga abaixo do padrão dele',
      description: 'A carga da última semana ficou abaixo do ritmo habitual do aluno.',
      period: 'últimos 7 dias vs. 28',
      evidence: { band: input.loadBand },
    });
  }

  // ── Progressão positiva ──────────────────────────────────────────────────
  const { total, improved } = input.keyExercises;
  if (total >= R.PROGRESSION_MIN_EXERCISES && improved / total >= R.PROGRESSION_IMPROVED_PCT) {
    out.push({
      type: 'PROGRESSION_POSITIVE',
      severity: 'positive',
      title: 'Carga subindo',
      description: `${improved} de ${total} exercícios comparáveis melhoraram no período.`,
      period: 'últimos 28 dias vs. 28 anteriores',
      evidence: { improved, total, ratioPct: pct(improved / total) },
    });
  }

  // ── Movimento do score ───────────────────────────────────────────────────
  if (input.score != null && input.scorePrevious != null) {
    const delta = input.score - input.scorePrevious;
    if (Math.abs(delta) >= R.SCORE_DELTA_MIN) {
      const subiu = delta > 0;
      out.push({
        type: subiu ? 'SCORE_UP' : 'SCORE_DOWN',
        severity: subiu ? 'positive' : 'attention',
        title: subiu ? 'Progress Score subiu' : 'Progress Score caiu',
        description: `De ${input.scorePrevious} para ${input.score} nas últimas 4 semanas.`,
        period: 'últimas 4 semanas',
        evidence: { current: input.score, previous: input.scorePrevious, delta },
      });
    }
  }

  return out;
}

/**
 * Sinais que EXPLICAM outros sinais.
 *
 * O Progress Score é, por construção, um resumo do que os outros sinais medem:
 * ele sobe porque a carga subiu ou porque houve recorde. Mostrar as duas coisas
 * é dizer a mesma novidade duas vezes, com palavras diferentes — o personal lê
 * quatro cartões e descobre um fato só.
 *
 * A regra: quando a causa está visível, o resumo sai. Fica a informação mais
 * específica, que é a acionável — "carga subiu em 3 de 4 exercícios" diz o que
 * fazer amanhã; "o score subiu" não.
 */
const EXPLAINED_BY: Partial<Record<SignalType, SignalType[]>> = {
  SCORE_UP: ['PROGRESSION_POSITIVE', 'RECENT_PR', 'GOAL_ACHIEVED'],
  SCORE_DOWN: ['CONSISTENCY_DOWN', 'PROGRESSION_STALLED'],
};

/** Ordem de exibição. Conquista primeiro, ruído por último. */
const SEVERITY_ORDER: Record<SignalSeverity, number> = {
  positive: 0,
  attention: 1,
  neutral: 2,
};

/** Desempate estável dentro da mesma severidade — nada depende da ordem do SQL. */
const TYPE_ORDER: SignalType[] = [
  'GOAL_ACHIEVED',
  'RECENT_PR',
  'PROGRESSION_POSITIVE',
  'SCORE_UP',
  'CONSISTENCY_DOWN',
  'PROGRESSION_STALLED',
  'SCORE_DOWN',
  'LOAD_UP',
  'GOAL_NEAR_COMPLETION',
  'LOAD_DOWN',
];

/**
 * Sinais prontos para a tela: detectados, deduplicados, ordenados e limitados.
 *
 * Determinística de ponta a ponta — a mesma entrada produz a mesma lista, na
 * mesma ordem. Isso importa mais do que parece: o personal abre a tela do mesmo
 * aluno duas vezes no mesmo dia e precisa ver a mesma coisa, ou passa a
 * desconfiar do que lê.
 */
export function buildSignals(input: SignalInput): PerformanceSignal[] {
  const detected = detectSignals(input);
  const presentes = new Set(detected.map((s) => s.type));

  const filtrados = detected.filter((s) => {
    const explicadores = EXPLAINED_BY[s.type];
    return !explicadores?.some((t) => presentes.has(t));
  });

  filtrados.sort((a, b) => {
    const porSeveridade = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (porSeveridade !== 0) return porSeveridade;
    return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  });

  return filtrados.slice(0, SIGNAL_RULES.MAX_SIGNALS);
}
