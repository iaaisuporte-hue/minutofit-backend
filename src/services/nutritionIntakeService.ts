/**
 * PLAN_NUTRITION_QUICK_MACROS (P1B) — resolução do texto/refeição contra o
 * catálogo (SPEC 038) + persistência do registro. Regras de segurança que
 * este módulo protege:
 *
 * 1. Nenhum item NÃO RESOLVIDO chega a ser persistido — `persistIntakeLog`
 *    rejeita (lança `ValidationError`) antes de tocar o banco.
 * 2. Nenhum item de baixa confiança é persistido sem `confirmed:true` — e a
 *    confiança nunca é a que o cliente alega: quando o item veio de texto
 *    livre (`rawText` presente), o servidor RE-CALCULA a confiança a partir
 *    do próprio texto + do alimento escolhido, nunca aceitando o rótulo do
 *    cliente como verdade.
 * 3. `energyKcal/proteinG/carbohydrateG/fatG` de item de catálogo são SEMPRE
 *    recalculados a partir do per-100g atual do alimento (nunca do que o
 *    cliente mandou) — mesma disciplina de `nutritionCalculation.ts`
 *    (SPEC 038). Só o item `manual` é uma afirmação direta do usuário.
 * 4. `confidence_score` do log é SEMPRE derivado no servidor a partir dos
 *    pesos do resolver — nunca aceito do cliente.
 */
import pool from '../config/database';
import { dayKey, dayKeyDiff } from '../utils/appDay';
import { parseIntakeText, type ParsedIntakeToken } from './nutritionIntakeParser';
import { calculateNutrition, sumNutrients, type NutrientsPer100g } from './nutritionCalculation';
import { getCatalogFoodById, listCatalogFoodMeasures, getFoodIndex, type FoodSummary, type FoodMeasure } from './nutritionFoodService';
import { matchFood, normalizeFoodText, BEVERAGE_CATEGORY, type MatchConfidence, type UnitHint } from './nutritionFoodMatcher';
import { interpretIntakeTextWithAi, type IntakeInterpreterDeps } from './ai/intakeInterpreterAi';
import { getFeatureMapForUser } from './planFeatureService';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * PLAN P1B corrective ("Agrupamento por Refeição + Refeição Extra + Janela
 * de Edição") §17 — "hoje" e "ontem" o aluno pode corrigir; de anteontem
 * pra trás o histórico é preservado (Truth Layer/Nutri/agregações seguem
 * lendo tudo) mas o PRÓPRIO aluno não edita/exclui mais. `dayKeyDiff(from,
 * to)` = dias de `from` até `to`; diff 0 = hoje, 1 = ontem.
 */
export class EditWindowError extends Error {
  constructor() {
    super('edit_window_exceeded');
    this.name = 'EditWindowError';
  }
}

function toDateKeyString(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

function assertWithinEditWindow(logDateKey: string): void {
  if (dayKeyDiff(logDateKey, dayKey()) > 1) throw new EditWindowError();
}

/** Medidas caseiras sem correspondência cadastrada no catálogo (PLAN §10). */
export const FALLBACK_MEASURES_G: Record<string, number> = {
  colher_sopa: 15,
  colher_cha: 5,
  xicara: 120,
  copo: 200,
  concha: 80,
  fatia: 25,
};

/**
 * Fallback por contagem de alimento quando não há palavra de medida
 * ("2 ovos", "1 pão francês") — chave é a 1ª palavra da query já
 * normalizada. `pao: 50` cobre a família pão francês/pãozinho (unidade
 * padrão ~50g, mesma convenção já usada para `ovo`); não se aplica a pão de
 * forma/pão integral em fatia — esses exigem palavra de medida própria
 * ("1 fatia") e não caem neste fallback.
 */
export const FALLBACK_UNIT_FOOD_G: Record<string, number> = {
  ovo: 50,
  pao: 50,
};

/** Peso de cada resolver no `confidence_score` do log (PLAN §8). */
export const RESOLVER_WEIGHT: Record<'catalog' | 'measure' | 'manual' | 'plan' | 'history', number> = {
  catalog: 1,
  measure: 1,
  plan: 1,
  manual: 0.8,
  // Item reaproveitado do histórico do PRÓPRIO usuário (PLAN P1B.1 §caveat 6)
  // — não é dado oficial de catálogo, mas também não é palpite: é uma
  // afirmação que o próprio usuário já confirmou antes. Peso entre catálogo
  // e manual.
  history: 0.85,
};

export type IntakeItemResolver = 'catalog' | 'measure' | 'manual' | 'plan' | 'history';
/**
 * `medium` é nova (PLAN P1B corrective §8/§9) — fuzzy match plausível mas
 * não certo o bastante para entrar sem confirmação ("você quis dizer?").
 * Tratada como `low` para efeito de persistência: ambas exigem
 * `confirmed:true` (ver `resolveFoodItem`); a diferença é só de UX/telemetria.
 */
export type IntakeConfidence = MatchConfidence;

export interface IntakePreviewItem {
  resolved: boolean;
  rawText: string;
  foodQuery: string;
  foodId?: number;
  name?: string;
  grams?: number;
  measureId?: number | null;
  fallbackMeasureKey?: string | null;
  per100g?: { kcal: number; p: number; c: number; f: number };
  energyKcal?: number;
  proteinG?: number;
  carbohydrateG?: number;
  fatG?: number;
  resolver?: IntakeItemResolver;
  confidence?: IntakeConfidence;
  confirmed?: boolean;
  /** Top candidato(s) do fuzzy match — só populado quando `confidence` é `medium`/`low` (PLAN §14: UI "você quis dizer?", nunca detalhe técnico). */
  matchScore?: number;
  /**
   * Quantidade E unidade EXATAMENTE como o usuário disse (PLAN P1B.1 §3) —
   * preenchido mesmo quando `resolved:false`, para a UI nunca perder "200 ml"
   * e reexibir como se fosse grama, nem pedir para o usuário reescrever em
   * outra unidade. `grams` continua sendo a base de CÁLCULO; estes dois
   * campos são só de EXIBIÇÃO.
   */
  quantity?: number;
  unitLabel?: string;
}

function toPer100g(food: FoodSummary): NutrientsPer100g {
  return {
    energyKcal: food.energyKcal,
    proteinG: food.proteinG,
    carbohydrateG: food.carbohydrateG,
    fatG: food.fatG,
    fiberG: food.fiberG,
    sodiumMg: food.sodiumMg,
  };
}

/** Medida DB cujo nome normalizado contém as palavras esperadas do alias canônico. */
const MEASURE_WORDS: Record<string, string[]> = {
  colher_sopa: ['colher', 'sopa'],
  colher_cha: ['colher', 'cha'],
  xicara: ['xicara'],
  copo: ['copo'],
  concha: ['concha'],
  fatia: ['fatia'],
  unidade: ['unidade'],
};

function findDbMeasure(measures: FoodMeasure[], canonical: string): FoodMeasure | null {
  const words = MEASURE_WORDS[canonical] ?? [canonical];
  return measures.find((m) => {
    const n = normalizeFoodText(m.name);
    return words.every((w) => n.includes(w));
  }) ?? null;
}

/**
 * Resolve o alimento de um token do parser contra o catálogo (PLAN P1B
 * corrective) — pipeline alias → exato → fuzzy por token, sobre o índice em
 * memória (`nutritionFoodMatcher.matchFood`), no lugar do antigo ILIKE
 * substring-contíguo (que falhava sempre que uma palavra do TACO se
 * intercalava entre os termos do usuário — "pao frances" nunca batia em
 * "pao TRIGO frances"). `unitHint` só afeta o desempate de nomes ambíguos
 * quando a MEDIDA do usuário já entrega contexto físico (§Measure Resolver
 * abaixo) — nunca o score do fuzzy. Retorna o alimento completo (com
 * macros) já carregado, ou `null` quando nenhum candidato plausível existe.
 */
async function resolveFoodForQuery(
  foodQuery: string,
  unitHint?: UnitHint,
): Promise<{ food: FoodSummary; confidence: IntakeConfidence; score: number } | null> {
  const index = await getFoodIndex();
  const match = matchFood(foodQuery, index, unitHint);
  if (!match.resolved || !match.entry) return null;
  const food = await getCatalogFoodById(match.entry.id);
  if (!food) return null;
  return { food, confidence: match.confidence!, score: match.score ?? 0 };
}

/**
 * Volume → grama, de forma encapsulada e restrita (PLAN P1B.1 §2/§10 —
 * caveat explícito: nunca um fator 1:1 universal, nunca popular uma tabela
 * de densidades por chute). Só resolve quando o alimento identificado é da
 * categoria Bebidas — infusões, refrigerantes, isotônico, água de coco,
 * caldo de cana, cerveja: líquidos diluídos em água onde 1 ml ≈ 1 g é uma
 * aproximação honesta (desvio &lt;5%). Para qualquer outro alimento (leite,
 * suco — densidade real diferente e, no caso do leite, a versão fluida nem
 * existe no catálogo hoje) devolve `null`: o chamador cai para o histórico
 * do usuário ou para a entrada manual, preservando "ml" na tela — nunca
 * convertido, nunca pedido de volta em gramas (§3).
 */
function resolveVolumeGrams(ml: number, food: FoodSummary): number | null {
  if (food.category !== BEVERAGE_CATEGORY) return null;
  return ml;
}

interface QuantityResolution {
  grams: number;
  measureId: number | null;
  fallbackMeasureKey: string | null;
}

/** Measure Resolver — quantidade+unidade já identificadas → gramas para o Nutrition Engine. Separado do Food Resolver (função acima) por design (PLAN P1B.1 §1/§10). */
async function resolveQuantityToGrams(token: ParsedIntakeToken, food: FoodSummary): Promise<QuantityResolution | null> {
  if (token.unitType === 'grams') {
    return { grams: token.quantity, measureId: null, fallbackMeasureKey: null };
  }
  if (token.unitType === 'ml') {
    const grams = resolveVolumeGrams(token.quantity, food);
    return grams == null ? null : { grams, measureId: null, fallbackMeasureKey: null };
  }
  const canonical = token.measureName ?? 'unidade';
  const dbMeasures = await listCatalogFoodMeasures(food.id);
  const dbMatch = findDbMeasure(dbMeasures, canonical);
  if (dbMatch) {
    return { grams: token.quantity * dbMatch.grams, measureId: dbMatch.id, fallbackMeasureKey: null };
  }
  if (token.measureName && token.measureName !== 'unidade' && FALLBACK_MEASURES_G[token.measureName] != null) {
    return { grams: token.quantity * FALLBACK_MEASURES_G[token.measureName], measureId: null, fallbackMeasureKey: token.measureName };
  }
  // "unidade" explícita ("1 unidade de banana") é semanticamente a mesma
  // coisa que contagem bare ("3 bananas") — mesmo fallback por alimento
  // (PLAN P1B.1: o Interpreter por IA sempre manda um `unit` explícito,
  // nunca omite; sem este ramo, "1 pão francês" via IA nunca resolveria
  // gramas, mesmo com o alimento já identificado).
  if (!token.measureName || token.measureName === 'unidade') {
    const foodHead = token.foodQuery.split(' ')[0];
    if (FALLBACK_UNIT_FOOD_G[foodHead] != null) {
      return { grams: token.quantity * FALLBACK_UNIT_FOOD_G[foodHead], measureId: null, fallbackMeasureKey: foodHead };
    }
  }
  return null;
}

/**
 * Histórico do PRÓPRIO usuário como estágio de resolução (PLAN P1B.1 §5/§10,
 * caveat 6) — "whey"/"1 scoop de whey" não existem na TACO e nunca vão
 * existir (nenhum banco externo é autorizado); mas depois da PRIMEIRA vez
 * que o usuário informou os macros manualmente, o segundo lançamento não
 * precisa repetir o formulário. Escopo estritamente por `user_id` — nunca
 * um alias global (§5: "whey" não tem alvo dominante único como "arroz"
 * tem). Só considera itens `manual`/`history` já confirmados (nunca
 * catálogo — esse já teria resolvido normalmente) com `grams` conhecido.
 */
interface HistoryFoodMatch {
  name: string;
  grams: number | null;
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
}

async function findHistoryMatch(userId: number, foodQuery: string): Promise<HistoryFoodMatch | null> {
  const qNorm = normalizeFoodText(foodQuery);
  if (!qNorm) return null;
  const { rows } = await pool.query(
    `SELECT items FROM user_nutrition_intake_logs
      WHERE user_id = $1 AND deleted_at IS NULL AND logged_at >= NOW() - INTERVAL '120 days'
      ORDER BY logged_at DESC LIMIT 200`,
    [userId],
  );
  for (const row of rows) {
    const items = (row.items ?? []) as PersistedIntakeItem[];
    for (const item of items) {
      if (item.resolver !== 'manual' && item.resolver !== 'history') continue;
      const nNorm = normalizeFoodText(item.name);
      if (!nNorm) continue;
      if (nNorm === qNorm || nNorm.includes(qNorm) || qNorm.includes(nNorm)) {
        return {
          name: item.name,
          grams: item.grams,
          energyKcal: item.energyKcal,
          proteinG: item.proteinG,
          carbohydrateG: item.carbohydrateG,
          fatG: item.fatG,
          fiberG: item.fiberG,
        };
      }
    }
  }
  return null;
}

/**
 * Item de preview a partir de um match de histórico. Quando a menção atual
 * TAMBÉM tem gramas conhecidos (massa explícita — "30g de whey" de novo) e o
 * histórico também tinha, escala pelo per-100g derivado (mesma disciplina
 * do catálogo — nunca aceita o total antigo como se fosse o de agora).
 * Quando não há como escalar (medida ambígua, "1 scoop" de novo, ou o
 * histórico não tinha gramas), reaproveita os macros TOTAIS como estão —
 * legítimo porque é a mesma unidade discreta de antes ("1 scoop" continua
 * significando a mesma coisa), nunca um palpite novo.
 */
function buildHistoryPreviewItem(token: ParsedIntakeToken, hist: HistoryFoodMatch): IntakePreviewItem {
  const canScale = hist.grams != null && hist.grams > 0 && (token.unitType === 'grams' || token.unitType === 'ml');
  const grams = canScale ? token.quantity : (hist.grams ?? undefined);
  const factor = canScale ? token.quantity / hist.grams! : 1;
  return {
    resolved: true,
    rawText: token.rawText,
    foodQuery: token.foodQuery,
    name: hist.name,
    grams,
    quantity: token.quantity,
    unitLabel: token.unitLabel,
    energyKcal: round2(hist.energyKcal * factor),
    proteinG: round2(hist.proteinG * factor),
    carbohydrateG: round2(hist.carbohydrateG * factor),
    fatG: round2(hist.fatG * factor),
    resolver: 'history',
    confidence: 'high',
    confirmed: true,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve um token do parser contra o catálogo — usado pelo preview (`/parse`). `userId` habilita o estágio de histórico (§ acima); omitido em contextos onde não há usuário autenticado. */
export async function resolveTokenForPreview(token: ParsedIntakeToken, userId?: number): Promise<IntakePreviewItem> {
  const resolution = await resolveFoodForQuery(token.foodQuery, token.unitDimension);

  if (resolution) {
    const { food: best, confidence, score } = resolution;
    const quantityResult = await resolveQuantityToGrams(token, best);
    if (quantityResult) {
      const per100g = toPer100g(best);
      const calc = calculateNutrition(per100g, quantityResult.grams);
      return {
        resolved: true,
        rawText: token.rawText,
        foodQuery: token.foodQuery,
        foodId: best.id,
        name: best.name,
        grams: quantityResult.grams,
        measureId: quantityResult.measureId,
        fallbackMeasureKey: quantityResult.fallbackMeasureKey,
        quantity: token.quantity,
        unitLabel: token.unitLabel,
        per100g: { kcal: per100g.energyKcal, p: per100g.proteinG, c: per100g.carbohydrateG, f: per100g.fatG },
        energyKcal: calc.energyKcal,
        proteinG: calc.proteinG,
        carbohydrateG: calc.carbohydrateG,
        fatG: calc.fatG,
        resolver: token.unitType === 'grams' ? 'catalog' : 'measure',
        confidence,
        confirmed: confidence === 'high',
        matchScore: confidence === 'high' && score === 1 ? undefined : score,
      };
    }
    // Alimento identificado, mas sem como chegar a gramas com segurança (ex.:
    // volume sem densidade conhecida) — NUNCA "informe em gramas" (§3): cai
    // para o histórico/manual preservando quantidade+unidade originais.
  }

  const history = userId != null ? await findHistoryMatch(userId, token.foodQuery) : null;
  if (history) return buildHistoryPreviewItem(token, history);

  return {
    resolved: false,
    rawText: token.rawText,
    foodQuery: token.foodQuery,
    quantity: token.quantity,
    unitLabel: token.unitLabel,
    // Só quando a dimensão é MASSA a "quantidade" já É a gramagem — permite
    // que a entrada manual comece com a base real em vez de vazia (caveat
    // 6); para volume/contagem/medida caseira `grams` fica indefinido, nunca
    // um número forjado.
    grams: token.unitType === 'grams' ? token.quantity : undefined,
  };
}

export interface ParsedPreview {
  items: IntakePreviewItem[];
  totals: ReturnType<typeof sumNutrients>;
  needsConfirmation: boolean;
  /** `true` quando a IA (não o parser determinístico) produziu os tokens usados — o chamador decide o `source` do log a partir disto. */
  aiUsed: boolean;
}

async function resolveAll(tokens: ParsedIntakeToken[], userId?: number): Promise<IntakePreviewItem[]> {
  return Promise.all(tokens.map((t) => resolveTokenForPreview(t, userId)));
}

/**
 * PLAN P1B.1 §6/§7/§caveat 1/5 — determinístico primeiro, sempre. A IA
 * (`nutrition_intake_ai`, ROLLOUT_ONLY) só é consultada quando o resultado
 * determinístico tem algo NÃO resolvido — nunca no caminho feliz (chips,
 * "200g de frango"), e nunca substitui um resultado que já funcionou. A
 * versão da IA só é adotada se estritamente melhor (mais itens resolvidos,
 * nenhum item unresolved que o determinístico também não tivesse) — o
 * determinístico é sempre o piso, nunca "às vezes pior". A confiança final
 * de cada item, com ou sem IA, vem só do Resolver (`resolveFoodForQuery`
 * acima) — a IA nunca resolve um item.
 */
export async function parseAndResolve(text: string, userId?: number, aiDeps?: IntakeInterpreterDeps): Promise<ParsedPreview> {
  const tokens = parseIntakeText(text);
  const items = await resolveAll(tokens, userId);
  const hasUnresolved = items.some((i) => !i.resolved);

  let finalItems = items;
  let aiUsed = false;

  if (hasUnresolved && userId != null) {
    const aiEnabled = await isNutritionIntakeAiEnabled(userId);
    if (aiEnabled) {
      const aiTokens = await interpretIntakeTextWithAi(text, userId, aiDeps);
      if (aiTokens && aiTokens.length > 0) {
        const aiItems = await resolveAll(aiTokens, userId);
        const aiUnresolvedCount = aiItems.filter((i) => !i.resolved).length;
        const detUnresolvedCount = items.filter((i) => !i.resolved).length;
        if (aiUnresolvedCount < detUnresolvedCount) {
          finalItems = aiItems;
          aiUsed = true;
        }
      }
    }
  }

  const resolvedCalcs = finalItems
    .filter((i) => i.resolved)
    .map((i) => ({
      energyKcal: i.energyKcal!, proteinG: i.proteinG!, carbohydrateG: i.carbohydrateG!, fatG: i.fatG!,
      fiberG: null, sodiumMg: null,
    }));
  return {
    items: finalItems,
    totals: sumNutrients(resolvedCalcs),
    needsConfirmation: finalItems.some((i) => !i.resolved || (i.confidence !== 'high' && !i.confirmed)),
    aiUsed,
  };
}

async function isNutritionIntakeAiEnabled(userId: number): Promise<boolean> {
  try {
    const { features } = await getFeatureMapForUser(userId);
    return Boolean(features['nutrition_intake_ai']) && Boolean(process.env.OPENAI_API_KEY);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

export type IntakeItemRequest =
  | {
      kind: 'food';
      foodId: number;
      quantity: number;
      unitType: 'grams' | 'measure';
      measureId?: number | null;
      fallbackMeasureKey?: string | null;
      /** Presente só quando o item nasceu de texto livre — dispara re-checagem de confiança no servidor. */
      rawText?: string | null;
      confirmed?: boolean;
      /** Quantidade/unidade ORIGINAIS tal como o usuário disse (preview) — só para exibição, nunca para cálculo (PLAN P1B.1 §3). */
      displayQuantity?: number | null;
      displayUnitLabel?: string | null;
    }
  | {
      kind: 'manual';
      name: string;
      grams?: number | null;
      energyKcal: number;
      proteinG: number;
      carbohydrateG: number;
      fatG: number;
      displayQuantity?: number | null;
      displayUnitLabel?: string | null;
    }
  | {
      kind: 'plan';
      planMealItemId: number;
    };

export interface PersistedIntakeItem {
  foodId?: number;
  name: string;
  grams: number | null;
  per100g?: { kcal: number; p: number; c: number; f: number };
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  /** null quando o alimento/medição não tem fibra conhecida — nunca 0 fabricado (PLAN §11). */
  fiberG: number | null;
  resolver: IntakeItemResolver;
  confidence: IntakeConfidence;
  confirmed: boolean;
  /** Quantidade/unidade ORIGINAIS tal como o usuário disse — exibição apenas (PLAN P1B.1 §3); `grams` continua a base de cálculo. */
  quantity?: number | null;
  unitLabel?: string | null;
}

const MANUAL_ITEM_KCAL_MAX = 3000;

/**
 * Re-deriva a confiança de um item de catálogo escolhido a partir de texto
 * livre — NUNCA aceita o rótulo de confiança que o cliente mandou. Item
 * escolhido por busca explícita (sem `rawText`) é sempre `high`: não há
 * ambiguidade de parser a reconfirmar quando o próprio usuário apontou o
 * alimento na lista. Quando há `rawText`, roda o MESMO matcher do preview
 * (`resolveFoodForQuery`) — se o alimento escolhido não é o que o matcher
 * também escolheria, ou a confiança dele não é `high`, trata como `low`
 * (nunca confia que o cliente "só confirmou o que já era certo").
 */
async function deriveFoodConfidence(rawText: string | null | undefined, foodId: number): Promise<IntakeConfidence> {
  if (!rawText) return 'high';
  const [token] = parseIntakeText(rawText);
  if (!token) return 'low';
  const resolution = await resolveFoodForQuery(token.foodQuery, token.unitDimension);
  if (!resolution || resolution.food.id !== foodId) return 'low';
  return resolution.confidence;
}

async function resolveFoodItem(item: Extract<IntakeItemRequest, { kind: 'food' }>): Promise<PersistedIntakeItem> {
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new ValidationError('invalid_quantity');
  const food = await getCatalogFoodById(item.foodId);
  if (!food) throw new ValidationError('food_not_found');

  let grams: number;
  let resolver: IntakeItemResolver;
  if (item.unitType === 'grams') {
    grams = item.quantity;
    resolver = 'catalog';
  } else {
    resolver = 'measure';
    if (item.measureId != null) {
      const measures = await listCatalogFoodMeasures(item.foodId);
      const measure = measures.find((m) => m.id === item.measureId);
      if (!measure) throw new ValidationError('measure_not_found_for_food');
      grams = item.quantity * measure.grams;
    } else if (item.fallbackMeasureKey && FALLBACK_MEASURES_G[item.fallbackMeasureKey] != null) {
      grams = item.quantity * FALLBACK_MEASURES_G[item.fallbackMeasureKey];
    } else if (item.fallbackMeasureKey && FALLBACK_UNIT_FOOD_G[item.fallbackMeasureKey] != null) {
      grams = item.quantity * FALLBACK_UNIT_FOOD_G[item.fallbackMeasureKey];
    } else {
      throw new ValidationError('measure_required');
    }
  }
  if (grams <= 0) throw new ValidationError('invalid_grams');

  const confidence = await deriveFoodConfidence(item.rawText, food.id);
  if (confidence !== 'high' && !item.confirmed) {
    throw new ValidationError('low_confidence_item_needs_confirmation');
  }

  const per100g = toPer100g(food);
  const calc = calculateNutrition(per100g, grams);
  return {
    foodId: food.id,
    name: food.name,
    grams,
    per100g: { kcal: per100g.energyKcal, p: per100g.proteinG, c: per100g.carbohydrateG, f: per100g.fatG },
    energyKcal: calc.energyKcal,
    proteinG: calc.proteinG,
    carbohydrateG: calc.carbohydrateG,
    fatG: calc.fatG,
    fiberG: calc.fiberG,
    resolver,
    confidence,
    confirmed: true,
    quantity: item.displayQuantity ?? null,
    unitLabel: item.displayUnitLabel ?? null,
  };
}

function resolveManualItem(item: Extract<IntakeItemRequest, { kind: 'manual' }>): PersistedIntakeItem {
  const name = item.name?.trim();
  if (!name) throw new ValidationError('manual_name_required');
  const nums = [item.energyKcal, item.proteinG, item.carbohydrateG, item.fatG];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
    throw new ValidationError('invalid_manual_macros');
  }
  if (item.energyKcal > MANUAL_ITEM_KCAL_MAX) throw new ValidationError('manual_kcal_too_high');
  return {
    name,
    grams: item.grams != null && item.grams > 0 ? item.grams : null,
    energyKcal: item.energyKcal,
    proteinG: item.proteinG,
    carbohydrateG: item.carbohydrateG,
    fatG: item.fatG,
    // Item manual não tem como o usuário informar fibra separadamente hoje —
    // `null` (não conhecida), nunca 0 (que afirmaria "sem fibra").
    fiberG: null,
    resolver: 'manual',
    confidence: 'high',
    confirmed: true,
    quantity: item.displayQuantity ?? null,
    unitLabel: item.displayUnitLabel ?? null,
  };
}

async function resolvePlanItem(userId: number, item: Extract<IntakeItemRequest, { kind: 'plan' }>): Promise<PersistedIntakeItem> {
  // IDOR: só pode copiar item de refeição de um plano do PRÓPRIO usuário.
  const { rows } = await pool.query(
    `SELECT nmi.food_name_snapshot, nmi.energy_kcal_snapshot, nmi.protein_g_snapshot,
            nmi.carbohydrate_g_snapshot, nmi.fat_g_snapshot, nmi.fiber_g_snapshot, nmi.grams
       FROM nutrition_meal_items nmi
       JOIN nutrition_plan_meals npm ON npm.id = nmi.meal_id
       JOIN nutrition_plans np ON np.id = npm.plan_id
      WHERE nmi.id = $1 AND nmi.deleted_at IS NULL AND np.patient_id = $2`,
    [item.planMealItemId, userId]
  );
  if (rows.length === 0) throw new ValidationError('plan_meal_item_not_found');
  const row = rows[0];
  return {
    name: row.food_name_snapshot,
    grams: Number(row.grams),
    energyKcal: Number(row.energy_kcal_snapshot),
    proteinG: Number(row.protein_g_snapshot),
    carbohydrateG: Number(row.carbohydrate_g_snapshot),
    fatG: Number(row.fat_g_snapshot),
    fiberG: row.fiber_g_snapshot == null ? null : Number(row.fiber_g_snapshot),
    resolver: 'plan',
    confidence: 'high',
    confirmed: true,
  };
}

export interface IntakeLogInput {
  userId: number;
  label: string;
  rawText?: string | null;
  mealId?: number | null;
  items: IntakeItemRequest[];
  source: 'parse' | 'parse_ai' | 'manual' | 'repeat' | 'favorite' | 'plan';
}

export interface IntakeLogRecord {
  id: number;
  dateKey: string;
  loggedAt: string;
  mealId: number | null;
  label: string;
  rawText: string | null;
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  /** null quando NENHUM item do log tinha fibra conhecida (PLAN §11) — nunca 0 fabricado. */
  fiberG: number | null;
  /** true quando ALGUM item do log não tinha fibra conhecida — `fiberG` é uma soma parcial. */
  fiberPartial: boolean;
  items: PersistedIntakeItem[];
  confidenceScore: number;
  source: string;
  isFavorite: boolean;
}

function mapRow(r: any): IntakeLogRecord {
  return {
    id: r.id,
    dateKey: r.date_key instanceof Date ? r.date_key.toISOString().slice(0, 10) : r.date_key,
    loggedAt: r.logged_at,
    mealId: r.meal_id,
    label: r.label,
    rawText: r.raw_text,
    energyKcal: Number(r.energy_kcal),
    proteinG: Number(r.protein_g),
    carbohydrateG: Number(r.carbohydrate_g),
    fatG: Number(r.fat_g),
    fiberG: r.fiber_g == null ? null : Number(r.fiber_g),
    fiberPartial: Boolean(r.fiber_partial),
    items: r.items,
    confidenceScore: Number(r.confidence_score),
    source: r.source,
    isFavorite: r.is_favorite,
  };
}

function weightedConfidence(items: PersistedIntakeItem[]): number {
  const totalKcal = items.reduce((s, i) => s + i.energyKcal, 0);
  const score = totalKcal > 0
    ? items.reduce((s, i) => s + i.energyKcal * RESOLVER_WEIGHT[i.resolver], 0) / totalKcal
    : RESOLVER_WEIGHT[items[0].resolver];
  return Math.round(score * 100) / 100;
}

/**
 * PLAN P1B corrective ("Agrupamento por Refeição") §6/§26 — "adicionar
 * alimento depois" a uma refeição do PLANO nunca pode virar um segundo
 * card. Quando `mealId` é informado e já existe um log não-apagado HOJE
 * para esse `(user_id, date_key, meal_id)`, este registro passa a ser um
 * UPDATE que junta os itens novos aos já persistidos, em vez de um INSERT
 * — a mesma ação ("Registrar o que comi" a partir da MESMA refeição do
 * plano, chamada mais de uma vez no dia) sempre converge para UMA linha.
 * Preserva o `label`/`logged_at` originais (a refeição continua sendo a
 * mesma, só ganhou mais itens). Refeição EXTRA (`mealId == null`) nunca
 * funde — cada chamada sem vínculo ao plano é uma refeição nova por
 * definição (§3: não agrupar por rótulo/horário parecido sem associação
 * persistida).
 */
export async function persistIntakeLog(input: IntakeLogInput): Promise<IntakeLogRecord> {
  const label = input.label?.trim();
  if (!label) throw new ValidationError('label_required');
  if (label.length > 80) throw new ValidationError('label_too_long');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError('items_required');

  const resolved: PersistedIntakeItem[] = [];
  for (const item of input.items) {
    if (item.kind === 'food') resolved.push(await resolveFoodItem(item));
    else if (item.kind === 'manual') resolved.push(resolveManualItem(item));
    else if (item.kind === 'plan') resolved.push(await resolvePlanItem(input.userId, item));
    else throw new ValidationError('invalid_item_kind');
  }

  const dateKey = dayKey();

  if (input.mealId != null) {
    const existing = await pool.query(
      `SELECT * FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND date_key = $2 AND meal_id = $3 AND deleted_at IS NULL
        LIMIT 1`,
      [input.userId, dateKey, input.mealId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const mergedItems: PersistedIntakeItem[] = [...(row.items as PersistedIntakeItem[]), ...resolved];
      const totals = sumNutrients(mergedItems.map((i) => ({
        energyKcal: i.energyKcal, proteinG: i.proteinG, carbohydrateG: i.carbohydrateG, fatG: i.fatG,
        fiberG: i.fiberG, sodiumMg: null,
      })));
      const { rows } = await pool.query(
        `UPDATE user_nutrition_intake_logs SET
           energy_kcal = $2, protein_g = $3, carbohydrate_g = $4, fat_g = $5,
           fiber_g = $6, fiber_partial = $7, items = $8, confidence_score = $9, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [row.id, totals.energyKcal, totals.proteinG, totals.carbohydrateG, totals.fatG,
          totals.fiberG, totals.fiberPartial, JSON.stringify(mergedItems), weightedConfidence(mergedItems)]
      );
      return mapRow(rows[0]);
    }
  }

  const totals = sumNutrients(resolved.map((i) => ({
    energyKcal: i.energyKcal, proteinG: i.proteinG, carbohydrateG: i.carbohydrateG, fatG: i.fatG,
    fiberG: i.fiberG, sodiumMg: null,
  })));

  const { rows } = await pool.query(
    `INSERT INTO user_nutrition_intake_logs
       (user_id, date_key, meal_id, label, raw_text, energy_kcal, protein_g, carbohydrate_g, fat_g, fiber_g, fiber_partial, items, confidence_score, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.userId, dateKey, input.mealId ?? null, label, input.rawText ?? null,
      totals.energyKcal, totals.proteinG, totals.carbohydrateG, totals.fatG,
      totals.fiberG, totals.fiberPartial,
      JSON.stringify(resolved), weightedConfidence(resolved), input.source,
    ]
  );
  return mapRow(rows[0]);
}

export interface IntakeLogUpdateInput {
  label: string;
  rawText?: string | null;
  items: IntakeItemRequest[];
  source: 'parse' | 'parse_ai' | 'manual' | 'repeat' | 'favorite' | 'plan';
}

/**
 * Edição de um log já persistido (PLAN P1B corrective — "Consulta + Edição
 * de Refeição Registrada"). Reusa os MESMOS resolvers de `persistIntakeLog`
 * — todo item é revalidado e recalculado no servidor a partir do catálogo
 * atual, nunca aceita totais/kcal do cliente como autoridade. Preserva
 * `date_key`/`logged_at`/`meal_id` originais (não fazem parte do input) —
 * editar o que o usuário declarou ter comido nunca migra o registro para
 * "hoje" nem move o horário; `updated_at` marca que houve edição.
 * `resolvePlanItem` só LÊ `nutrition_plan_meals`/`nutrition_meal_items` —
 * a prescrição do Nutri nunca é escrita por este caminho (§8). Ownership
 * via `WHERE id=$1 AND user_id=$2` no próprio UPDATE — mesmo padrão já
 * usado por `softDeleteLog`/`setFavorite`; `rows.length === 0` cobre tanto
 * "não existe" quanto "log de outro usuário" quanto "já apagado".
 */
export async function updateIntakeLog(userId: number, id: number, input: IntakeLogUpdateInput): Promise<IntakeLogRecord | null> {
  const label = input.label?.trim();
  if (!label) throw new ValidationError('label_required');
  if (label.length > 80) throw new ValidationError('label_too_long');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError('items_required');

  const existing = await pool.query(
    `SELECT date_key FROM user_nutrition_intake_logs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  if (existing.rows.length === 0) return null;
  assertWithinEditWindow(toDateKeyString(existing.rows[0].date_key));

  const resolved: PersistedIntakeItem[] = [];
  for (const item of input.items) {
    if (item.kind === 'food') resolved.push(await resolveFoodItem(item));
    else if (item.kind === 'manual') resolved.push(resolveManualItem(item));
    else if (item.kind === 'plan') resolved.push(await resolvePlanItem(userId, item));
    else throw new ValidationError('invalid_item_kind');
  }

  const totals = sumNutrients(resolved.map((i) => ({
    energyKcal: i.energyKcal, proteinG: i.proteinG, carbohydrateG: i.carbohydrateG, fatG: i.fatG,
    fiberG: i.fiberG, sodiumMg: null,
  })));

  const { rows } = await pool.query(
    `UPDATE user_nutrition_intake_logs SET
       label = $3, raw_text = $4, energy_kcal = $5, protein_g = $6, carbohydrate_g = $7, fat_g = $8,
       fiber_g = $9, fiber_partial = $10, items = $11, confidence_score = $12, source = $13, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [
      id, userId, label, input.rawText ?? null,
      totals.energyKcal, totals.proteinG, totals.carbohydrateG, totals.fatG,
      totals.fiberG, totals.fiberPartial,
      JSON.stringify(resolved), weightedConfidence(resolved), input.source,
    ]
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function getDayLogs(userId: number, dateKey: string): Promise<IntakeLogRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM user_nutrition_intake_logs
      WHERE user_id = $1 AND date_key = $2 AND deleted_at IS NULL
      ORDER BY logged_at`,
    [userId, dateKey]
  );
  return rows.map(mapRow);
}

export interface NutritionIntakeMeal {
  groupKey: string;
  mealId: number | null;
  label: string;
  loggedAt: string;
  /** `true` quando não está associada a nenhuma `nutrition_plan_meal` — realidade alimentar fora do plano do Nutri. */
  isExtra: boolean;
  items: PersistedIntakeItem[];
  energyKcal: number;
  proteinG: number;
  carbohydrateG: number;
  fatG: number;
  fiberG: number | null;
  fiberPartial: boolean;
  confidenceScore: number;
  /** Linhas físicas de `user_nutrition_intake_logs` agregadas neste card — normalmente 1; >1 só em registros legados de antes desta correção. */
  sourceLogIds: number[];
}

/**
 * PLAN P1B corrective ("Agrupamento por Refeição") §2-§4/§18-§19 — a
 * unidade visual do aluno é REFEIÇÃO, não log. Função PURA (sem banco):
 * agrupa os logs do dia por associação PERSISTIDA, nunca por horário
 * parecido (§3) — `meal_id` (refeição do plano) é a única chave de
 * agrupamento; um log sem `meal_id` é, por definição, a própria refeição
 * extra (§3 categoria B: "pertence à refeição/momento escolhido pelo
 * usuário" — a linha É a refeição). `persistIntakeLog` já garante que, daqui
 * em diante, existe no máximo 1 log por `(dia, meal_id)` — o agrupamento
 * aqui é sobretudo defensivo para dados legados de antes desta correção.
 */
export function groupLogsIntoMeals(logs: IntakeLogRecord[]): NutritionIntakeMeal[] {
  const groups = new Map<string, IntakeLogRecord[]>();
  for (const log of logs) {
    const key = log.mealId != null ? `plan:${log.mealId}` : `log:${log.id}`;
    const arr = groups.get(key);
    if (arr) arr.push(log);
    else groups.set(key, [log]);
  }

  const meals: NutritionIntakeMeal[] = [];
  for (const [groupKey, groupLogs] of groups) {
    const sorted = [...groupLogs].sort((a, b) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime());
    const items = sorted.flatMap((l) => l.items);
    const totals = sumNutrients(items.map((i) => ({
      energyKcal: i.energyKcal, proteinG: i.proteinG, carbohydrateG: i.carbohydrateG, fatG: i.fatG,
      fiberG: i.fiberG, sodiumMg: null,
    })));
    meals.push({
      groupKey,
      mealId: sorted[0].mealId,
      label: sorted[0].label,
      loggedAt: sorted[0].loggedAt,
      isExtra: sorted[0].mealId == null,
      items,
      energyKcal: totals.energyKcal,
      proteinG: totals.proteinG,
      carbohydrateG: totals.carbohydrateG,
      fatG: totals.fatG,
      fiberG: totals.fiberG,
      fiberPartial: totals.fiberPartial,
      confidenceScore: items.length > 0 ? weightedConfidence(items) : sorted[0].confidenceScore,
      sourceLogIds: sorted.map((l) => l.id),
    });
  }

  return meals.sort((a, b) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime());
}

export async function softDeleteLog(userId: number, id: number): Promise<boolean> {
  const existing = await pool.query(
    `SELECT date_key FROM user_nutrition_intake_logs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  if (existing.rows.length === 0) return false;
  assertWithinEditWindow(toDateKeyString(existing.rows[0].date_key));

  const { rowCount } = await pool.query(
    `UPDATE user_nutrition_intake_logs SET deleted_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  return (rowCount ?? 0) > 0;
}

export async function setFavorite(userId: number, id: number, favorite: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE user_nutrition_intake_logs SET is_favorite = $3
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId, favorite]
  );
  return (rowCount ?? 0) > 0;
}

export type DayCoverageLevel = 'high' | 'partial' | 'low';

export interface DayCoverage {
  loggedMeals: number;
  expectedMeals: number;
  coverageRatio: number;
  confidence: number;
  level: DayCoverageLevel;
}

/**
 * Classificação de cobertura/confiança de UM dia (PLAN §11) — usada aqui só
 * para a faixa do dia do próprio aluno. A agregação de 7/14 dias para o
 * nutri (P1C) reaplica as MESMAS regras em `nutritionIntake.ts`, nunca uma
 * segunda fórmula.
 */
export interface DayLogSummary {
  loggedMeals: number;
  totalKcal: number;
  /** Média ponderada por kcal do `confidence_score` dos logs do dia (0..1). */
  weightedConfidence: number;
}

/**
 * Núcleo puro da classificação de cobertura/confiança de UM dia (PLAN §11).
 * Recebe o dia já resumido — reusado tanto para o dia único do aluno
 * (`classifyDayCoverage` abaixo, a partir de logs reais) quanto para os 14
 * dias pré-agregados por SQL que o nutri vê (`nutritionIntake.ts`, P1C) —
 * MESMA fórmula, nunca duas.
 */
export function classifyDaySummary(day: DayLogSummary, expectedMeals: number): DayCoverage {
  const { loggedMeals, weightedConfidence } = day;
  const coverageRatio = expectedMeals > 0 ? Math.min(loggedMeals / expectedMeals, 1) : 0;

  let level: DayCoverageLevel = 'low';
  if (coverageRatio >= 0.75 && weightedConfidence >= 0.8) level = 'high';
  else if (coverageRatio >= 0.5) level = 'partial';

  return { loggedMeals, expectedMeals, coverageRatio, confidence: Math.round(weightedConfidence * 100) / 100, level };
}

export function summarizeDayLogs(logs: Array<{ energyKcal: number; confidenceScore: number }>): DayLogSummary {
  const loggedMeals = logs.length;
  const totalKcal = logs.reduce((s, l) => s + l.energyKcal, 0);
  const weightedConfidence = totalKcal > 0
    ? logs.reduce((s, l) => s + l.energyKcal * l.confidenceScore, 0) / totalKcal
    : (loggedMeals > 0 ? logs.reduce((s, l) => s + l.confidenceScore, 0) / loggedMeals : 0);
  return { loggedMeals, totalKcal, weightedConfidence };
}

export function classifyDayCoverage(logs: IntakeLogRecord[], expectedMeals: number): DayCoverage {
  return classifyDaySummary(summarizeDayLogs(logs), expectedMeals);
}

export interface IntakeShortcuts {
  recent: Array<{ label: string; items: PersistedIntakeItem[] }>;
  favorites: Array<{ id: number; label: string; items: PersistedIntakeItem[] }>;
  yesterdayMeals: Array<{ logId: number; label: string; loggedAt: string; items: PersistedIntakeItem[] }>;
}

export async function getShortcuts(userId: number): Promise<IntakeShortcuts> {
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 60 * 60 * 1000));

  const [recentRes, favRes, yesterdayRes] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (label) label, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY label, logged_at DESC LIMIT 5`,
      [userId]
    ),
    pool.query(
      `SELECT id, label, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND is_favorite
        ORDER BY logged_at DESC LIMIT 10`,
      [userId]
    ),
    pool.query(
      `SELECT id, label, logged_at, items FROM user_nutrition_intake_logs
        WHERE user_id = $1 AND deleted_at IS NULL AND date_key = $2
        ORDER BY logged_at`,
      [userId, yesterday]
    ),
  ]);

  return {
    recent: recentRes.rows.map((r) => ({ label: r.label, items: r.items })),
    favorites: favRes.rows.map((r) => ({ id: r.id, label: r.label, items: r.items })),
    yesterdayMeals: yesterdayRes.rows.map((r) => ({ logId: r.id, label: r.label, loggedAt: r.logged_at, items: r.items })),
  };
}
