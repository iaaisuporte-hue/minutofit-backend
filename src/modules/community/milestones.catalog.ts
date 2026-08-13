/**
 * Catálogo de marcos (Spec 034, Onda C1).
 *
 * ## Por que em código e não em tabela
 *
 * O catálogo é uma lista fechada que muda com **deploy**, não com ação de
 * usuário — igual ao `featureCatalog`. Uma tabela daria a ilusão de que alguém
 * pode criar marco pela UI, e criaria a pergunta "qual linha está certa, a do
 * banco ou a do código?". A regra de concessão é código; o catálogo mora junto.
 *
 * ## Terminologia
 *
 * A UI em português diz **"recorde pessoal"**, nunca só "PR" — a sigla é
 * dialeto de academia e exclui exatamente quem está começando.
 *
 * ## O que NÃO está aqui
 *
 * Nenhum marco premia volume, carga alta, perda de peso, jejum ou treinar com
 * dor (§Anti-escopo permanente). Todos premiam **aderência ao próprio plano** —
 * o mesmo princípio que separa a Spec 034 de um app de competição.
 */

export type MilestoneCode =
  | 'first_workout'
  | 'first_full_week'
  | 'first_pr'
  | 'four_consistent_weeks'
  | 'ten_goals'
  | 'three_months_active'
  | 'comeback'
  | 'challenge_completed';

export interface MilestoneDefinition {
  code: MilestoneCode;
  title: string;
  description: string;
  /** A regra exata, em uma frase — é o que a aba Marcos mostra como critério. */
  criterion: string;
  /**
   * Versão da REGRA. Trocar o critério de um marco já concedido não retira o
   * marco de ninguém (seria punição retroativa); a versão existe para o
   * histórico dizer sob qual regra a concessão aconteceu.
   */
  ruleVersion: number;
  /**
   * `false` enquanto a fonte do marco não existe. `challenge_completed` está no
   * catálogo desde a C1 — com título, descrição e critério — mas sem avaliador
   * ativo: `challenge_participants` só nasce na C2. Deixar a definição pronta e
   * o avaliador desligado é o oposto de criar dependência com tabela
   * inexistente: nada consulta o que não existe.
   */
  evaluated: boolean;
}

export const MILESTONE_CATALOG: readonly MilestoneDefinition[] = Object.freeze([
  Object.freeze({
    code: 'first_workout' as const,
    title: 'Primeiro treino',
    description: 'Você registrou o primeiro treino no S2CORE.',
    criterion: 'Primeira sessão de treino executada.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'first_full_week' as const,
    title: 'Primeira semana completa',
    description: 'Você cumpriu, por inteiro, a frequência prevista para a sua semana.',
    criterion: 'Uma semana com todos os dias de treino previstos no seu plano.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'first_pr' as const,
    title: 'Primeiro recorde pessoal',
    description: 'Você superou a própria marca em um exercício pela primeira vez.',
    criterion: 'Primeiro recorde pessoal real — superar um número que já era seu.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'four_consistent_weeks' as const,
    title: 'Quatro semanas consistentes',
    description: 'Quatro semanas seguidas dentro da sua programação.',
    criterion: 'Quatro semanas consecutivas com pelo menos 80% da frequência prevista.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'ten_goals' as const,
    title: 'Dez metas concluídas',
    description: 'Dez metas que você definiu e cumpriu.',
    criterion: 'Dez metas de performance concluídas.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'three_months_active' as const,
    title: 'Três meses ativo',
    description: 'Três meses de presença regular — não de volume.',
    criterion: 'Em 13 semanas, pelo menos 11 com treino registrado.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'comeback' as const,
    title: 'Retomada',
    description: 'Você voltou depois de uma pausa longa e sustentou a volta.',
    criterion: 'Retorno após 21 dias ou mais parado, seguido de 3 semanas dentro da programação.',
    ruleVersion: 1,
    evaluated: true,
  }),
  Object.freeze({
    code: 'challenge_completed' as const,
    title: 'Primeiro desafio concluído',
    description: 'Você concluiu um desafio até o fim.',
    criterion: 'Primeiro desafio concluído.',
    ruleVersion: 1,
    // Avaliador desligado até a C2 criar `challenge_participants`.
    evaluated: false,
  }),
]);

const BY_CODE = new Map<string, MilestoneDefinition>(
  MILESTONE_CATALOG.map((m) => [m.code, m]),
);

export function findMilestone(code: string): MilestoneDefinition | null {
  return BY_CODE.get(code) ?? null;
}

/** Códigos com avaliador ativo — a lista que o engine percorre. */
export const EVALUATED_CODES: readonly MilestoneCode[] = Object.freeze(
  MILESTONE_CATALOG.filter((m) => m.evaluated).map((m) => m.code),
);
