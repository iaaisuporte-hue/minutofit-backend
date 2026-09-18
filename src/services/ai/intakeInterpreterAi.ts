/**
 * Intake Interpreter por IA (P1B.1, spike de arquitetura "Smart Food
 * Logging") — fallback OPCIONAL de texto→estrutura, atrás da feature flag
 * `nutrition_intake_ai` (ROLLOUT_ONLY, default off).
 *
 * ## O que esta camada pode e não pode fazer
 *
 * Ela só produz `{foodQuery, quantity, unit}` — a mesma forma que o parser
 * determinístico (`nutritionIntakeParser.ts`) já produz. Nunca calcula kcal
 * ou macro, nunca escolhe o alimento do catálogo: dali em diante o texto
 * "interpretado pela IA" passa pelo MESMO Resolver determinístico (alias →
 * exato → fuzzy) que qualquer texto digitado — a confiança final de um item
 * vem do Resolver, nunca de "a IA disse que é isso" (caveat explícito do
 * usuário: não travar em confirmação item-a-item só por ter passado pela IA).
 *
 * Se a IA falhar, devolver algo malformado, ou a flag estiver off, o
 * chamador (`nutritionIntakeService.parseAndResolve`) simplesmente usa o
 * resultado determinístico — nunca há dependência dura desta camada.
 */
import { aiCall, TOKEN_BUDGET } from '../../lib/ai/openai';
import logger from '../../lib/logger';
import { INTAKE_INTERPRETER_SYSTEM_PROMPT } from './prompts';
import type { ParsedIntakeToken, ParsedUnitDimension } from '../nutritionIntakeParser';

const ALLOWED_UNITS: Record<string, { unitType: 'grams' | 'ml' | 'measure'; measureName: string | null; dimension: ParsedUnitDimension; label: string; toBase?: number }> = {
  g: { unitType: 'grams', measureName: null, dimension: 'mass', label: 'g' },
  kg: { unitType: 'grams', measureName: null, dimension: 'mass', label: 'g', toBase: 1000 },
  ml: { unitType: 'ml', measureName: null, dimension: 'volume', label: 'ml' },
  l: { unitType: 'ml', measureName: null, dimension: 'volume', label: 'ml', toBase: 1000 },
  unidade: { unitType: 'measure', measureName: 'unidade', dimension: 'count', label: 'unidade' },
  colher_sopa: { unitType: 'measure', measureName: 'colher_sopa', dimension: 'household', label: 'colher de sopa' },
  colher_cha: { unitType: 'measure', measureName: 'colher_cha', dimension: 'household', label: 'colher de chá' },
  xicara: { unitType: 'measure', measureName: 'xicara', dimension: 'volume', label: 'xícara' },
  copo: { unitType: 'measure', measureName: 'copo', dimension: 'volume', label: 'copo' },
  concha: { unitType: 'measure', measureName: 'concha', dimension: 'household', label: 'concha' },
  fatia: { unitType: 'measure', measureName: 'fatia', dimension: 'household', label: 'fatia' },
  // "scoop" não tem medida cadastrada em lugar nenhum do catálogo (whey não é
  // TACO) — a resolução do gram (ou a ausência dela) fica inteiramente a
  // cargo do Measure Resolver / estágio de histórico do usuário, nunca desta
  // camada. Mapeado para 'measure' com measureName próprio só para chegar
  // identificável do outro lado.
  scoop: { unitType: 'measure', measureName: 'scoop', dimension: 'household', label: 'scoop' },
};

const MAX_ITEMS = 12;
const MAX_QUERY_LEN = 60;

function sanitizeFoodQuery(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_QUERY_LEN) return null;
  return trimmed;
}

/**
 * Valida a resposta da IA contra o contrato — tudo ou nada, mesmo padrão de
 * `performanceInsightAi.parseAiSummary`: um item fora do formato descarta a
 * lista inteira (nunca "aproveita o que deu", que produziria uma refeição
 * com metade dos itens faltando e nenhuma pista de por quê).
 */
export function parseAiIntakeTokens(raw: string, rawTextByIndex?: string[]): ParsedIntakeToken[] | null {
  let data: unknown;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  if (items.length === 0) return [];
  if (items.length > MAX_ITEMS) return null;

  const tokens: ParsedIntakeToken[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const foodQuery = sanitizeFoodQuery(obj.foodQuery);
    if (!foodQuery) return null;

    const quantity = typeof obj.quantity === 'number' ? obj.quantity : Number(obj.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 5000) return null;

    const unitCode = typeof obj.unit === 'string' ? obj.unit.trim().toLowerCase() : null;
    const unit = unitCode ? ALLOWED_UNITS[unitCode] : null;
    if (!unit) return null;

    tokens.push({
      rawText: rawTextByIndex?.[i] ?? foodQuery,
      foodQuery,
      quantity: unit.toBase ? quantity * unit.toBase : quantity,
      unitType: unit.unitType,
      measureName: unit.measureName,
      unitDimension: unit.dimension,
      unitLabel: unit.label,
    });
  }
  return tokens;
}

export interface IntakeInterpreterDeps {
  /** Injetável para teste — nenhum teste fala com provedor real. */
  callModel?: (input: string) => Promise<string>;
}

/**
 * `null` = "IA não ajudou" (indisponível, erro, timeout ou saída inválida) —
 * o chamador sempre tem o resultado determinístico como piso, nunca quebra
 * por causa desta camada.
 */
export async function interpretIntakeTextWithAi(
  text: string,
  userId: number,
  deps: IntakeInterpreterDeps = {},
): Promise<ParsedIntakeToken[] | null> {
  const started = Date.now();
  try {
    const raw = deps.callModel
      ? await deps.callModel(text)
      : (
          await aiCall({
            userId: String(userId),
            instructions: INTAKE_INTERPRETER_SYSTEM_PROMPT,
            input: text,
            maxOutputTokens: TOKEN_BUDGET.INTAKE_INTERPRET,
            reasoningEffort: 'minimal',
            jsonOutput: true,
            timeoutMs: 8000,
          })
        ).text;

    const tokens = parseAiIntakeTokens(raw);
    if (tokens == null) {
      logger.warn({ userId, latencyMs: Date.now() - started, reason: 'invalid_schema' }, '[nutrition-intake] ai_interpreter_failure');
      return null;
    }
    logger.info({ userId, latencyMs: Date.now() - started, items: tokens.length }, '[nutrition-intake] ai_interpreter_success');
    return tokens;
  } catch (err) {
    logger.warn({ err, userId, latencyMs: Date.now() - started }, '[nutrition-intake] ai_interpreter_failure');
    return null;
  }
}
