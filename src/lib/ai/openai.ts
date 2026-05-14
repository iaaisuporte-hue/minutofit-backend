/**
 * Camada centralizada de acesso à OpenAI — Responses API (GPT-5 compatible).
 *
 * REGRAS:
 *  - Toda chamada à OpenAI passa EXCLUSIVAMENTE por `aiCall()`.
 *  - Nenhum service ou route usa o cliente OpenAI diretamente.
 *  - Parâmetros incompatíveis com GPT-5 são proibidos:
 *      temperature, top_p, frequency_penalty, presence_penalty, max_tokens
 *  - Único parâmetro de controle de saída: max_output_tokens
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
// Modelo padrão — configurável via env
// ---------------------------------------------------------------------------

export const AI_MODEL: string = process.env.OPENAI_MODEL ?? 'gpt-5-mini';

// ---------------------------------------------------------------------------
// Orçamentos rígidos de tokens de saída (max_output_tokens)
// Valores conservadores para MVP — revisitar com dados reais de produção.
// ---------------------------------------------------------------------------

export const TOKEN_BUDGET = {
  /** Classificação simples: intenção, energia, intensidade. */
  CLASSIFY: 80,
  /** Sugestão curta: dica metabólica, ajuste de protocolo. */
  SUGGEST_SHORT: 150,
  /** Resumo inteligente: feedback de sessão, análise de aderência. */
  SMART_SUMMARY: 300,
  /** Ficha de treino objetiva (adaptação de protocolo existente). */
  WORKOUT_PLAN: 500,
} as const;

// ---------------------------------------------------------------------------
// Rate limit por usuário (in-memory)
// Produção futura: substituir por Redis para multi-instância.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const _rateLimitStore = new Map<string, RateLimitEntry>();

const HOURLY_LIMIT = 10;

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
  /** Identificador do usuário para rate limit. Omitir para chamadas de sistema. */
  userId?: string;
  /** Modelo. Padrão: AI_MODEL. */
  model?: string;
  /** Instrução de sistema (scope guard, formato de saída esperado). */
  instructions: string;
  /** Mensagem do usuário. */
  input: string;
  /** Limite rígido de tokens de saída. Obrigatório. */
  maxOutputTokens: number;
  /**
   * Força saída em JSON via text.format: json_object.
   * Distinto de temperature/top_p — é suportado no GPT-5.
   * Usar quando a resposta precisa ser JSON estruturado confiável.
   */
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
 * Executa uma chamada à OpenAI Responses API (GPT-5 compatible).
 *
 * Parâmetros usados: model, input, instructions, max_output_tokens.
 * Parâmetros proibidos: temperature, top_p, frequency_penalty, max_tokens.
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

  // A API exige a palavra "json" no input quando json_object está ativo.
  const safeInput =
    opts.jsonOutput && !opts.input.toLowerCase().includes('json')
      ? `${opts.input}\nResponda apenas em JSON.`
      : opts.input;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.responses.create(
      {
        model,
        instructions: opts.instructions,
        input: safeInput,
        max_output_tokens: opts.maxOutputTokens,
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
      console.log(`[AI] model=${model} in=${usage.inputTokens} out=${usage.outputTokens}`);
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
