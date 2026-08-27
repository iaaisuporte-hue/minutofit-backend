/**
 * Parser único de id numérico vindo do cliente (path param, query, corpo).
 *
 * Motivo (QA 02/ago/2026, P0-1): `parseInt` só rejeita `NaN`. Um id como
 * `9007199254740991` ou `-99999999999` passava pela validação e estourava o
 * `int4` no Postgres (`22003: value out of range for type integer`). Em rota
 * com try/catch isso virava 500; no middleware `requireActiveConsent` — que é
 * async e não tinha catch — virava `unhandledRejection` e **derrubava o
 * processo Node inteiro**: uma requisição autenticada tirava a API do ar.
 *
 * Aqui a faixa do `integer` do Postgres é a fronteira: o que não couber nela
 * nunca chega ao banco.
 */
export const PG_INT4_MAX = 2147483647;

/** `null` quando o valor não é um id válido (não-inteiro, ≤ 0 ou fora do int4). */
export function parseId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 && raw <= PG_INT4_MAX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Só dígitos: bloqueia '12e5', '0x10', '1.5', ' 1 OR 1=1' antes de qualquer coerção.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= PG_INT4_MAX ? value : null;
}

/**
 * Índice opcional vindo do corpo (hoje: `dayIndex`). Igual a `parseId`, exceto
 * por aceitar 0 — o primeiro dia da ficha é o índice 0.
 *
 * Existe porque `Number(null)` é `0` e `Number.isFinite(0)` é `true`: coagir com
 * `Number()` transforma "campo ausente" em "zero". Ausência precisa continuar
 * ausência (QA Treino Livre, ago/2026).
 */
export function parseOptionalIndex(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= PG_INT4_MAX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= PG_INT4_MAX ? value : null;
}

/**
 * Limite de paginação sanitizado. `?limit=' OR '1'='1` virava `NaN` e chegava
 * ao `LIMIT $n` como 500 (QA 02/ago/2026, P2-7).
 */
export function parseLimit(raw: unknown, fallback: number, max = 100): number {
  const value = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
