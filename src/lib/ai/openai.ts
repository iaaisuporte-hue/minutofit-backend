/**
 * Camada centralizada de acesso à OpenAI.
 *
 * Todas as chamadas à API da OpenAI DEVEM passar por `aiCall()`.
 * Nunca use o cliente OpenAI diretamente em services ou routes.
 *
 * Princípios:
 *  - Único ponto de configuração do modelo e limites de tokens
 *  - Rate limit por usuário (in-memory, reset a cada hora)
 *  - Timeout fixo por chamada
 *  - Log de uso de tokens para acompanhamento de custo
 *  - Retry automático em falhas transitórias (1 retry com back-off)
 */

import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Cliente singleton
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurada no ambiente.');
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Modelo padrão — lido do ambiente para facilitar troca futura
// ---------------------------------------------------------------------------

export const AI_MODEL: string = process.env.OPENAI_MODEL ?? 'gpt-5-mini';

// ---------------------------------------------------------------------------
// Orçamentos de tokens por tipo de operação (output tokens)
// Ajuste estes valores conforme o custo observado em produção.
// ---------------------------------------------------------------------------

export const TOKEN_BUDGET = {
  /** Classificação simples: intenção, nível de energia, etc. */
  CLASSIFY: 80,
  /** Sugestão curta: dica metabólica, ajuste de intensidade. */
  SUGGEST_SHORT: 200,
  /** Resumo inteligente: análise de sessão, feedback de treino. */
  SMART_SUMMARY: 300,
  /** Ficha de treino completa. */
  WORKOUT_PLAN: 700,
} as const;

// ---------------------------------------------------------------------------
// Rate limit por usuário (in-memory)
// Produção futura: substituir por Redis para ser persistente entre instâncias.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const _rateLimitStore = new Map<string, RateLimitEntry>();

/** Máximo de chamadas de IA por usuário por hora. */
const HOURLY_LIMIT = 10;

/**
 * Verifica e incrementa o contador do usuário.
 * Lança erro se o limite foi atingido.
 */
export function checkUserRateLimit(userId: string): void {
  const now = Date.now();
  const entry = _rateLimitStore.get(userId);

  if (!entry || now > entry.resetAt) {
    _rateLimitStore.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return;
  }

  if (entry.count >= HOURLY_LIMIT) {
    throw new Error(
      `Limite de ${HOURLY_LIMIT} chamadas de IA por hora atingido. Aguarde antes de tentar novamente.`,
    );
  }

  entry.count += 1;
}

// ---------------------------------------------------------------------------
// Wrapper central de chamada
// ---------------------------------------------------------------------------

export interface AiCallOptions {
  /** Identificador do usuário para rate limit (omitir em chamadas de sistema). */
  userId?: string;
  /** Modelo a usar. Padrão: AI_MODEL. */
  model?: string;
  /** Instrução de sistema (equivale ao antigo role:system). */
  instructions: string;
  /** Mensagem do usuário. */
  input: string;
  /** Limite rígido de tokens de saída. Obrigatório. */
  maxOutputTokens: number;
  /** Temperatura. Padrão: 0.4 — moderada. */
  temperature?: number;
  /** Se true, força saída em JSON (json_object). */
  jsonOutput?: boolean;
  /** Timeout em ms. Padrão: 15 000. */
  timeoutMs?: number;
}

export interface AiCallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

const RETRY_DELAY_MS = 1500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Executa uma chamada à OpenAI Responses API com:
 *  - rate limit por usuário
 *  - timeout configurável
 *  - 1 retry automático em erros transitórios
 *  - log de tokens consumidos
 */
export async function aiCall(opts: AiCallOptions): Promise<AiCallResult> {
  if (opts.userId) {
    checkUserRateLimit(opts.userId);
  }

  return _executeWithRetry(opts);
}

async function _executeWithRetry(opts: AiCallOptions, attempt = 0): Promise<AiCallResult> {
  try {
    return await _executeOnce(opts);
  } catch (err: any) {
    const isRetryable =
      attempt === 0 &&
      (err.name === 'APIConnectionError' ||
        (err.status && RETRYABLE_STATUS.has(err.status as number)));

    if (isRetryable) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return _executeWithRetry(opts, attempt + 1);
    }

    throw err;
  }
}

async function _executeOnce(opts: AiCallOptions): Promise<AiCallResult> {
  const client = getOpenAIClient();
  const model = opts.model ?? AI_MODEL;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.responses.create(
      {
        model,
        instructions: opts.instructions,
        input: opts.input,
        max_output_tokens: opts.maxOutputTokens,
        temperature: opts.temperature ?? 0.4,
        ...(opts.jsonOutput
          ? { text: { format: { type: 'json_object' as const } } }
          : {}),
      },
      { signal: controller.signal },
    );

    const text = response.output_text ?? '';
    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : null;

    if (usage) {
      console.log(
        `[AI] model=${model} in_tokens=${usage.inputTokens} out_tokens=${usage.outputTokens}`,
      );
    }

    return { text, usage };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('A IA demorou demais para responder. Tente novamente.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
