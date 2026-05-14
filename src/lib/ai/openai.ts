/**
 * Camada centralizada de acesso à OpenAI — Responses API (GPT-5 compatible).
 *
 * REGRAS:
 *  - Toda chamada à OpenAI passa EXCLUSIVAMENTE por `aiCall()`.
 *  - Nenhum service ou route usa o cliente OpenAI diretamente.
 *  - Parâmetros incompatíveis com GPT-5 são proibidos:
 *      temperature, top_p, frequency_penalty, presence_penalty, max_tokens
 *  - Único parâmetro de controle de saída: max_output_tokens
 *  - gpt-5-mini é reasoning model: reservar budget generoso para compensar
 *    tokens internos de reasoning. Usar effort='minimal' para minimizar custo.
 */

import OpenAI from 'openai';
import { getRedisClient } from '../redisClient';
import logger from '../logger';

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
// Orçamentos de tokens de saída (max_output_tokens)
// IMPORTANTE: gpt-5-mini é reasoning model — tokens internos de "thinking"
// consomem parte do budget antes do output real. Valores incluem margem para
// reasoning com effort='minimal' (~400–600 tokens extras).
// ---------------------------------------------------------------------------

export const TOKEN_BUDGET = {
  /** Classificação simples: intenção, energia, intensidade. */
  CLASSIFY: 200,
  /** Sugestão curta: dica metabólica, ajuste de protocolo. */
  SUGGEST_SHORT: 500,
  /** Resumo inteligente: feedback de sessão, análise de aderência. */
  SMART_SUMMARY: 800,
  /** Plano semanal: JSON com até 5 dias × 7 exercícios + reasoning minimal. */
  WORKOUT_PLAN: 3000,
} as const;

// ---------------------------------------------------------------------------
// Rate limit por usuário — Redis (multi-instância) com fallback in-memory
// ---------------------------------------------------------------------------

const HOURLY_LIMIT = 10;
const HOUR_SECONDS = 3600;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const _memStore = new Map<string, RateLimitEntry>();

async function checkRateLimitRedis(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    checkRateLimitMemory(userId);
    return;
  }

  const key = `ai_rl:${userId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // Primeiro increment — define TTL de 1h
      await redis.expire(key, HOUR_SECONDS);
    }
    if (count > HOURLY_LIMIT) {
      throw new Error(
        `Limite de ${HOURLY_LIMIT} chamadas de IA por hora atingido. Aguarde antes de tentar novamente.`,
      );
    }
  } catch (err: any) {
    // Se o erro for do rate limit, propaga. Erro de Redis → fallback in-memory.
    if (err.message?.includes('Limite de')) throw err;
    checkRateLimitMemory(userId);
  }
}

function checkRateLimitMemory(userId: string): void {
  const now = Date.now();
  const entry = _memStore.get(userId);

  if (!entry || now > entry.resetAt) {
    _memStore.set(userId, { count: 1, resetAt: now + HOUR_SECONDS * 1000 });
    return;
  }

  if (entry.count >= HOURLY_LIMIT) {
    throw new Error(
      `Limite de ${HOURLY_LIMIT} chamadas de IA por hora atingido. Aguarde antes de tentar novamente.`,
    );
  }

  entry.count += 1;
}

export async function checkUserRateLimit(userId: string): Promise<void> {
  await checkRateLimitRedis(userId);
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
  /** Limite rígido de tokens de saída. Obrigatório. Deve incluir margem para reasoning. */
  maxOutputTokens: number;
  /**
   * Esforço de reasoning para modelos GPT-5.
   * Default: 'minimal' — menos tokens de thinking, mais rápido, mais barato.
   * Aumentar para 'low' ou 'medium' apenas quando precisão analítica for crítica.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  /**
   * Força saída em JSON via text.format: json_object.
   * Requer que a palavra "json" apareça no input (injetada automaticamente se ausente).
   */
  jsonOutput?: boolean;
  /** Timeout em ms. Padrão: 20 000 (reasoning models são mais lentos). */
  timeoutMs?: number;
}

export interface AiCallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
}

const RETRY_DELAY_MS = 1500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function aiCall(opts: AiCallOptions): Promise<AiCallResult> {
  if (opts.userId) {
    await checkUserRateLimit(opts.userId);
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
  // Reasoning models são mais lentos — timeout padrão maior
  const timeoutMs = opts.timeoutMs ?? 20_000;

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
        reasoning: { effort: opts.reasoningEffort ?? 'minimal' },
        ...(opts.jsonOutput
          ? { text: { format: { type: 'json_object' as const } } }
          : {}),
      },
      { signal: controller.signal },
    );

    // Detectar resposta truncada antes de tentar parsear
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason ?? 'unknown';
      const reasoningTokens = (response.usage as any)?.output_tokens_details?.reasoning_tokens ?? 0;
      logger.error({ model, reason, maxRequested: opts.maxOutputTokens, outputUsed: response.usage?.output_tokens, reasoningTokens }, '[AI] response incomplete');
      throw new Error(
        `A IA não conseguiu completar a resposta (${reason}). Tente um prompt mais curto.`,
      );
    }

    const text = response.output_text ?? '';
    const reasoningTokens = (response.usage as any)?.output_tokens_details?.reasoning_tokens ?? 0;
    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          reasoningTokens,
        }
      : null;

    if (usage) {
      logger.info({ model, in: usage.inputTokens, out: usage.outputTokens, reasoning: usage.reasoningTokens }, '[AI] usage');
    }

    return { text, usage };
  } catch (err: any) {
    // OpenAI SDK v6 lança APIUserAbortError (com message 'Request was aborted.')
    // quando o AbortController interno expira. O nome do erro NÃO é 'AbortError'.
    // Detectamos por constructor.name, message ou pela presença do signal abortado.
    const isAbort =
      err?.constructor?.name === 'APIUserAbortError' ||
      err?.name === 'APIUserAbortError' ||
      err?.name === 'AbortError' ||
      typeof err?.message === 'string' && err.message.toLowerCase().includes('aborted');
    if (isAbort) {
      logger.warn({ model, timeoutMs }, '[AI] request aborted (timeout)');
      throw new Error('A IA demorou demais para responder. Tente novamente em alguns instantes.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
