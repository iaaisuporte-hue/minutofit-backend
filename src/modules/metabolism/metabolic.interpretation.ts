import { getMetabolicHint } from '../../services/ai/metabolicHint';
import logger from '../../lib/logger';
import type { MetabolicOutput } from './metabolic.types';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4h — alinhado ao SNAPSHOT_CACHE_SECONDS (6h) sem amplificar custo OpenAI

interface CacheEntry {
  interpretation: { hint: string; action: string };
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

function buildContext(output: Omit<MetabolicOutput, 'interpretation'>): string {
  const top = [...output.factors]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map((f) => `${f.label} (${f.delta >= 0 ? '+' : ''}${f.delta})`)
    .join('; ');
  return [
    `Score metabólico do aluno: ${output.score} (${output.status}).`,
    `Tendência: ${output.trend}.`,
    `Principais fatores hoje: ${top || 'sem fatores destacados'}.`,
    `Tendência 7d: ${output.trend7d?.direction ?? 'stable'} (delta ${output.trend7d?.delta ?? 0}).`,
  ].join(' ');
}

/**
 * Gera interpretação narrativa do estado metabólico via IA, com cache por usuário (TTL 4h).
 *
 * Nunca lança — degrada silenciosamente para `null` quando:
 *   - OPENAI_API_KEY ausente
 *   - rate limit (10/usuário/hora em aiCall)
 *   - resposta da IA inválida/incompleta
 *   - erro de rede
 *
 * Cache em memória (Map). Em multi-instância considerar Redis no futuro,
 * mesma estratégia do rate limit (CLAUDE.md menciona REDIS_URL opcional).
 */
export async function getMetabolismInterpretation(
  userId: number,
  output: Omit<MetabolicOutput, 'interpretation'>,
): Promise<{ hint: string; action: string } | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.interpretation;
  }

  try {
    const context = buildContext(output);
    const hint = await getMetabolicHint(context, String(userId));
    const interpretation = { hint: hint.hint, action: hint.action };
    cache.set(userId, { interpretation, expiresAt: now + CACHE_TTL_MS });
    return interpretation;
  } catch (err) {
    logger.debug({ err, userId }, '[metabolism] interpretation unavailable');
    return null;
  }
}
