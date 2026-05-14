/**
 * Cliente Redis singleton para o backend.
 *
 * Uso principal: rate limit de IA por usuário (substitui Map in-memory).
 * Compatível com multi-instância (Render Redis add-on).
 *
 * Se REDIS_URL não estiver configurada, o cliente fica null e os consumidores
 * devem degradar graciosamente (fallback in-memory ou aceitar a chamada).
 *
 * Configuração: defina REDIS_URL no ambiente.
 * Render Redis: redis://red-xxx:6379 ou rediss://... (TLS).
 */

import Redis from 'ioredis';
import logger from './logger';

let _redis: Redis | null = null;
let _connectAttempted = false;

export function getRedisClient(): Redis | null {
  if (_connectAttempted) return _redis;

  _connectAttempted = true;
  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn('[redis] REDIS_URL não configurada — rate limit de IA em modo in-memory');
    return null;
  }

  try {
    _redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 5000,
    });

    _redis.on('connect', () => logger.info('[redis] conectado'));
    _redis.on('error', (err) => {
      logger.warn({ err: err?.message }, '[redis] erro de conexão — fallback in-memory ativo');
      // Não lançar — deixar o app funcionar degradado
    });

    _redis.connect().catch(() => {
      // Falha silenciosa no boot — health check revelará o estado real
      _redis = null;
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[redis] falha ao inicializar — fallback in-memory ativo');
    _redis = null;
  }

  return _redis;
}
