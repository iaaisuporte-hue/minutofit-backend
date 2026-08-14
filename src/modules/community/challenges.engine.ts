/**
 * Engine de desafios — puro, determinístico (Spec 034, Onda C2).
 *
 * ## A tese, em uma função
 *
 * `weekPct` mede a semana de cada participante contra a **frequência prevista
 * para ele**. Everton, com 4 previstos e 3 feitos, fica em 75%; Pedro, com 3
 * previstos e 3 feitos, em 100% — treinando menos. É o comportamento desejado,
 * e é o que separa esta spec de um app de competição: volume absoluto nunca
 * vence. Qualquer regra futura que compare número bruto de treinos contradiz o
 * produto.
 *
 * ## Nenhum motor de métrica novo
 *
 * A Community **observa** a Performance. Este arquivo não sabe contar dias
 * ativos, não sabe o que é uma sessão e não conhece a tabela de metas: recebe
 * fatos já apurados pelos serviços canônicos e aplica a regra do desafio. Se
 * uma métrica precisar existir, ela nasce na Spec 033 — nunca aqui.
 *
 * ## Faixas, não posições
 *
 * O agregado é por faixa de cumprimento, sem 1º/2º/3º e sem percentual alheio.
 * E some por inteiro com menos de cinco participantes ativos: em turma pequena,
 * "1 concluído" é um nome.
 */

import { WEEK_WITHIN_PLAN_RATIO } from '../performance/consistency.engine';

export type ChallengeKind = 'consistency' | 'weekly_goal' | 'comeback';
export type ChallengeStatus = 'draft' | 'active' | 'finished' | 'cancelled';
export type ParticipantStatus = 'invited' | 'active' | 'left' | 'completed';

export const CHALLENGE_KINDS: readonly ChallengeKind[] = Object.freeze([
  'consistency',
  'weekly_goal',
  'comeback',
]);

export const RULES_VERSION = 1;

/**
 * Mínimo de participantes ativos para publicar QUALQUER agregado.
 *
 * Abaixo disso o agregado identifica a pessoa: numa turma de três, "1
 * concluído" é um nome, e uma média de dois é praticamente o valor de cada um.
 * O corte é do BACKEND — esconder na tela deixaria o dado saindo pela API, e
 * um cliente qualquer o leria.
 *
 * Vale igual para a academia: turma institucional não relaxa a regra. Uma
 * unidade com quatro alunos ativos é tão identificável quanto a turma de um
 * personal com quatro.
 */
export const MIN_PARTICIPANTS_FOR_BANDS = 5;

/**
 * A política de grupo pequeno, em um lugar só.
 *
 * Existe para o `if (count < 5)` não se espalhar por controllers — quando essa
 * condição vira código repetido, basta um lugar esquecê-la para o dado vazar
 * exatamente onde ninguém está olhando. Quem publica agregado pergunta AQUI.
 */
export function canPublishAggregate(activeParticipants: number): boolean {
  return activeParticipants >= MIN_PARTICIPANTS_FOR_BANDS;
}

/**
 * Aplica a política a qualquer agregado: devolve o valor ou `null`.
 *
 * `null` não é "escondi na tela" — é a API não devolvendo o número. E é
 * genérico de propósito: média de consistência, distribuição, taxa de adesão,
 * tudo passa pela mesma porta.
 */
export function withAggregatePolicy<T>(activeParticipants: number, valor: T): T | null {
  return canPublishAggregate(activeParticipants) ? valor : null;
}

/**
 * Percentual a partir do qual a semana conta como cumprida.
 *
 * DERIVADO da régua canônica do módulo Performance, não redigitado: mudar
 * `WEEK_WITHIN_PLAN_RATIO` lá passa a mudar a aba Consistência, os marcos E os
 * desafios juntos. Escrever `80` aqui deixaria o mesmo aluno "dentro do plano"
 * numa tela e reprovado na outra — exatamente o defeito que o cabeçalho deste
 * arquivo diz não cometer.
 */
export const DEFAULT_MIN_PCT = WEEK_WITHIN_PLAN_RATIO * 100;

export const RULE_LIMITS = Object.freeze({
  minPct: { min: 50, max: 100 },
  requiredWeeks: { min: 1, max: 26 },
  minInactiveDays: { min: 7, max: 180 },
});

/* ------------------------------------------------------------------ *
 * Regras
 * ------------------------------------------------------------------ */

export interface ConsistencyRule {
  minPct: number;
  requiredWeeks: number;
}
export interface WeeklyGoalRule {
  requiredWeeks: number;
}
export interface ComebackRule {
  minInactiveDays: number;
  requiredWeeks: number;
}
export type ChallengeRule = ConsistencyRule | WeeklyGoalRule | ComebackRule;

/** Campos aceitos por tipo. Qualquer outro é rejeitado, não ignorado. */
const RULE_FIELDS: Readonly<Record<ChallengeKind, readonly string[]>> = Object.freeze({
  consistency: Object.freeze(['minPct', 'requiredWeeks']),
  weekly_goal: Object.freeze(['requiredWeeks']),
  comeback: Object.freeze(['minInactiveDays', 'requiredWeeks']),
});

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

function inteiroNaFaixa(valor: unknown, faixa: { min: number; max: number }, campo: string): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < faixa.min || n > faixa.max) {
    throw new RuleValidationError(
      `${campo} deve ser inteiro entre ${faixa.min} e ${faixa.max}`,
    );
  }
  return n;
}

/**
 * Valida e NORMALIZA a regra vinda do cliente.
 *
 * Devolve um objeto novo, montado campo a campo — nunca o payload original.
 * Assim nada além do declarado chega ao `rule_json`: sem campo extra
 * sobrevivendo no banco, sem expressão, sem nada executável. O cliente descreve
 * a regra; quem a interpreta é o servidor.
 */
export function parseChallengeRule(kind: ChallengeKind, raw: unknown): ChallengeRule {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuleValidationError('rule deve ser um objeto');
  }
  const entrada = raw as Record<string, unknown>;

  const permitidos = RULE_FIELDS[kind];
  const desconhecidos = Object.keys(entrada).filter((k) => !permitidos.includes(k));
  if (desconhecidos.length > 0) {
    throw new RuleValidationError(
      `campos não reconhecidos para ${kind}: ${desconhecidos.join(', ')}`,
    );
  }

  switch (kind) {
    case 'consistency':
      return {
        minPct: inteiroNaFaixa(entrada.minPct ?? DEFAULT_MIN_PCT, RULE_LIMITS.minPct, 'minPct'),
        requiredWeeks: inteiroNaFaixa(
          entrada.requiredWeeks,
          RULE_LIMITS.requiredWeeks,
          'requiredWeeks',
        ),
      };
    case 'weekly_goal':
      return {
        requiredWeeks: inteiroNaFaixa(
          entrada.requiredWeeks,
          RULE_LIMITS.requiredWeeks,
          'requiredWeeks',
        ),
      };
    case 'comeback':
      return {
        minInactiveDays: inteiroNaFaixa(
          entrada.minInactiveDays,
          RULE_LIMITS.minInactiveDays,
          'minInactiveDays',
        ),
        requiredWeeks: inteiroNaFaixa(
          entrada.requiredWeeks,
          RULE_LIMITS.requiredWeeks,
          'requiredWeeks',
        ),
      };
    default:
      throw new RuleValidationError('tipo de desafio desconhecido');
  }
}

/** A regra em português, para a tela e para o convite. */
export function describeRule(kind: ChallengeKind, rule: ChallengeRule): string {
  switch (kind) {
    case 'consistency': {
      const r = rule as ConsistencyRule;
      return `Cumprir pelo menos ${r.minPct}% da sua frequência prevista em ${r.requiredWeeks} ${
        r.requiredWeeks === 1 ? 'semana' : 'semanas'
      }.`;
    }
    case 'weekly_goal': {
      const r = rule as WeeklyGoalRule;
      return `Cumprir sua meta semanal em ${r.requiredWeeks} ${
        r.requiredWeeks === 1 ? 'semana' : 'semanas'
      }.`;
    }
    case 'comeback': {
      const r = rule as ComebackRule;
      return `Depois de ${r.minInactiveDays} dias ou mais parado, completar ${r.requiredWeeks} ${
        r.requiredWeeks === 1 ? 'semana' : 'semanas'
      } dentro da sua programação.`;
    }
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * Progresso
 * ------------------------------------------------------------------ */

/** Uma semana do desafio, já apurada pelos serviços canônicos. */
export interface WeekFact {
  /** Segunda-feira da semana ISO (`YYYY-MM-DD`). */
  start: string;
  /** Dias com treino, pela UNIÃO de três fontes da Spec 033. */
  activeDays: number;
  /** Frequência prevista PARA ESTE ALUNO. `null` = sem alvo. */
  weeklyTarget: number | null;
  /**
   * A semana ISO cabe INTEIRA na janela do desafio?
   *
   * Semana parcial não conta e não reprova. Sem isto, um desafio que começa
   * numa quarta cria uma semana de 5 dias julgada contra o alvo de 7: quem
   * tem 5 treinos previstos chega no máximo a 71% naquela semana e nunca a
   * cumpre — quanto MAIOR a frequência prescrita, mais o desafio pune. É o
   * oposto da tese, e o motivo de os marcos também só usarem semanas inteiras.
   */
  full: boolean;
}

export interface ProgressFacts {
  kind: ChallengeKind;
  rule: ChallengeRule;
  weeks: WeekFact[];
  /**
   * Dias parado imediatamente antes do desafio — só o `comeback` usa.
   * `null` quando não há histórico anterior para afirmar.
   */
  inactivityDaysBefore?: number | null;
}

export interface ChallengeProgress {
  /** 0–100, sempre relativo ao PRÓPRIO plano. `null` = não dá para afirmar. */
  pct: number | null;
  /** Semanas já cumpridas. */
  weeksDone: number;
  /** Semanas exigidas pela regra. */
  weeksRequired: number;
  /** O critério final foi atingido? */
  achieved: boolean;
  /** Por que ainda não conta — `null` quando o progresso é mensurável. */
  blockedReason: 'no_target' | 'no_inactivity' | null;
}

/**
 * Cumprimento de UMA semana, relativo à frequência prevista para a pessoa.
 *
 * É aqui que a tese do produto vira aritmética: o denominador é o plano de cada
 * um. Sem alvo, `null` — e `null` significa "não afirmo", nunca zero.
 */
export function weekPct(week: WeekFact): number | null {
  if (week.weeklyTarget == null || week.weeklyTarget <= 0) return null;
  const bruto = (week.activeDays / week.weeklyTarget) * 100;
  // Teto de 100: treinar além do previsto é ótimo, mas "140% de cumprimento"
  // não quer dizer nada — e premiar excesso convidaria a treinar demais.
  return Math.min(100, Math.round(bruto));
}

/** Só semanas INTEIRAS entram na conta — as parciais não contam nem reprovam. */
export function scorableWeeks(weeks: WeekFact[]): WeekFact[] {
  return weeks.filter((w) => w.full);
}

function semanasCumpridas(weeks: WeekFact[], minPct: number): number {
  let n = 0;
  for (const w of scorableWeeks(weeks)) {
    const pct = weekPct(w);
    if (pct != null && pct >= minPct) n += 1;
  }
  return n;
}

/**
 * Progresso do participante — derivado na leitura, nunca materializado.
 *
 * O percentual exibido é `semanas cumpridas ÷ semanas exigidas`, e não a média
 * dos percentuais semanais: o desafio pede N semanas dentro do plano, então é
 * isso que a barra precisa mostrar.
 */
export function computeChallengeProgress(facts: ProgressFacts): ChallengeProgress {
  const required = (facts.rule as { requiredWeeks: number }).requiredWeeks;

  if (facts.kind === 'comeback') {
    const regra = facts.rule as ComebackRule;
    const parado = facts.inactivityDaysBefore ?? null;
    // Sem a pausa, não há retomada a medir — e inventar um começo seria dar o
    // desafio a quem nunca parou.
    if (parado == null || parado < regra.minInactiveDays) {
      return {
        pct: null,
        weeksDone: 0,
        weeksRequired: required,
        achieved: false,
        blockedReason: 'no_inactivity',
      };
    }
  }

  const minPct =
    facts.kind === 'consistency' ? (facts.rule as ConsistencyRule).minPct : DEFAULT_MIN_PCT;

  // `weekly_goal` e `comeback` usam o mesmo limiar da régua semanal do produto
  // (80% do previsto). Não há segunda definição de "semana cumprida".
  const inteiras = scorableWeeks(facts.weeks);
  const mensuraveis = inteiras.filter((w) => weekPct(w) != null);

  // Sem semana inteira medida ainda, não há o que afirmar. `0%` diria que a
  // pessoa falhou num desafio que talvez nem tenha começado.
  if (mensuraveis.length === 0) {
    return {
      pct: null,
      weeksDone: 0,
      weeksRequired: required,
      achieved: false,
      blockedReason: inteiras.length > 0 ? 'no_target' : null,
    };
  }

  const done = semanasCumpridas(facts.weeks, minPct);
  const pct = required > 0 ? Math.min(100, Math.round((done / required) * 100)) : null;

  return {
    pct,
    weeksDone: done,
    weeksRequired: required,
    achieved: done >= required,
    blockedReason: null,
  };
}

/* ------------------------------------------------------------------ *
 * Faixas
 * ------------------------------------------------------------------ */

export type BandId = 'completed' | 'almost' | 'in_progress' | 'inactive';

export const BAND_LABEL: Readonly<Record<BandId, string>> = Object.freeze({
  completed: 'Concluído',
  almost: 'Quase lá',
  in_progress: 'Em andamento',
  inactive: 'Sem atividade',
});

/** Em qual faixa um percentual cai. Sem posição, sem ordenação entre pessoas. */
export function bandOf(pct: number | null, achieved: boolean): BandId {
  if (achieved) return 'completed';
  if (pct == null || pct <= 0) return 'inactive';
  if (pct >= 80) return 'almost';
  return 'in_progress';
}

export interface BandCount {
  band: BandId;
  label: string;
  count: number;
}

/**
 * Contagem por faixa — ou `null` em turma pequena.
 *
 * `null` não é "escondi na tela": a API não devolve o agregado, porque com
 * quatro participantes a contagem por faixa reconstrói o indivíduo. E nunca há
 * lista de nomes por faixa: o aluno sabe a própria faixa e quantas pessoas há
 * em cada uma, jamais quem são.
 */
export function summarizeBands(pcts: Array<{ pct: number | null; achieved: boolean }>): BandCount[] | null {
  if (!canPublishAggregate(pcts.length)) return null;

  const contagem: Record<BandId, number> = {
    completed: 0,
    almost: 0,
    in_progress: 0,
    inactive: 0,
  };
  for (const p of pcts) contagem[bandOf(p.pct, p.achieved)] += 1;

  return (Object.keys(contagem) as BandId[]).map((band) => ({
    band,
    label: BAND_LABEL[band],
    count: contagem[band],
  }));
}

/* ------------------------------------------------------------------ *
 * Estados
 * ------------------------------------------------------------------ */

/**
 * Transições permitidas. O cliente jamais escolhe um estado: ele executa uma
 * AÇÃO (entrar, sair, cancelar), e o servidor decide o estado resultante.
 */
const PARTICIPANT_TRANSITIONS: Readonly<Record<ParticipantStatus, readonly ParticipantStatus[]>> =
  Object.freeze({
    invited: Object.freeze(['active', 'left'] as ParticipantStatus[]),
    active: Object.freeze(['completed', 'left'] as ParticipantStatus[]),
    // Terminais: quem saiu pode ser convidado de novo pelo personal (volta a
    // `invited`), mas nunca "volta" sozinho a ativo.
    left: Object.freeze(['invited'] as ParticipantStatus[]),
    completed: Object.freeze([] as ParticipantStatus[]),
  });

export function canTransitionParticipant(
  from: ParticipantStatus,
  to: ParticipantStatus,
): boolean {
  return PARTICIPANT_TRANSITIONS[from].includes(to);
}

const CHALLENGE_TRANSITIONS: Readonly<Record<ChallengeStatus, readonly ChallengeStatus[]>> =
  Object.freeze({
    draft: Object.freeze(['active', 'cancelled'] as ChallengeStatus[]),
    active: Object.freeze(['finished', 'cancelled'] as ChallengeStatus[]),
    finished: Object.freeze([] as ChallengeStatus[]),
    cancelled: Object.freeze([] as ChallengeStatus[]),
  });

export function canTransitionChallenge(from: ChallengeStatus, to: ChallengeStatus): boolean {
  return CHALLENGE_TRANSITIONS[from].includes(to);
}

/**
 * Estado EFETIVO — o que a data diz, não só o que está gravado.
 *
 * Um desafio `active` cuja janela já passou não é ativo; um cuja janela não
 * começou também não. Confiar apenas na coluna exigiria um cron para virar
 * estados, e sem ele a UI mostraria "em andamento" por tempo indeterminado. O
 * status persistido guarda a INTENÇÃO (cancelado, encerrado à mão); a data
 * decide o resto.
 */
export type EffectiveState = 'scheduled' | 'running' | 'ended' | 'cancelled';

export function effectiveState(
  status: ChallengeStatus,
  startsOn: string,
  endsOn: string,
  today: string,
): EffectiveState {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'finished') return 'ended';
  if (today < startsOn) return 'scheduled';
  if (today > endsOn) return 'ended';
  return 'running';
}
