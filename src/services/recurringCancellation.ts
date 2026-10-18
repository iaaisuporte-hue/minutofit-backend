/**
 * Cancelamento de recorrência (pre-approval) no Mercado Pago, para o encerramento de conta
 * (Spec 040).
 *
 * Por que não reaproveitar `mercadoPagoService.cancelPreapproval`: ele não tem timeout, devolve
 * um erro genérico que não distingue "já estava cancelada" de "rede caiu", e loga o corpo da
 * resposta do gateway — que pode trazer dados do pagador. Aqui:
 *
 *  - **Idempotente**: consulta antes (`GET`); recorrência já cancelada ou inexistente é um
 *    estado terminal ACEITÁVEL, não um erro. Repetir a chamada nunca gera segundo cancelamento.
 *  - **Verifica o resultado**: um `PUT` com 2xx só vale se o gateway devolver `status: cancelled`.
 *  - **Timeout** em toda chamada.
 *  - **Falha classificada** (`GatewayCancelError.kind`) para o log e para a reconciliação, e nunca
 *    com corpo de resposta — só o tipo da falha e o status HTTP.
 *
 * Sem credencial real em teste: quem testa substitui `axios`.
 */
import axios from 'axios';
import logger from '../lib/logger';

const MP_API = 'https://api.mercadopago.com';
const DEFAULT_TIMEOUT_MS = 10_000;

export type GatewayOutcome = 'cancelled' | 'already_terminal' | 'not_found';

export type GatewayFailureKind =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'rejected'
  | 'unverified';

export class GatewayCancelError extends Error {
  constructor(
    readonly kind: GatewayFailureKind,
    readonly httpStatus?: number,
  ) {
    super(`gateway_${kind}${httpStatus ? `_${httpStatus}` : ''}`);
    this.name = 'GatewayCancelError';
  }

  /** Vale tentar de novo sem ninguém mexer em nada (rede, limite, indisponibilidade do gateway). */
  get transient(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'rate_limit' || this.kind === 'server';
  }
}

function accessToken(): string {
  return process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
}

function classify(err: unknown): GatewayCancelError {
  const e = err as { code?: string; response?: { status?: number }; name?: string };
  const status = e?.response?.status;
  if (status === 429) return new GatewayCancelError('rate_limit', status);
  if (status && status >= 500) return new GatewayCancelError('server', status);
  if (status === 401 || status === 403) return new GatewayCancelError('auth', status);
  if (status) return new GatewayCancelError('rejected', status);
  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') {
    return new GatewayCancelError('timeout');
  }
  return new GatewayCancelError('network');
}

const isNotFound = (err: unknown): boolean => (err as { response?: { status?: number } })?.response?.status === 404;

/**
 * Garante que a recorrência está cancelada no gateway.
 *
 * Resolve com o desfecho terminal; lança `GatewayCancelError` quando não deu para confirmar
 * (o chamador mantém a pendência e tenta de novo).
 */
export async function cancelRecurringAtGateway(
  preapprovalId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GatewayOutcome> {
  const token = accessToken();
  if (!token) throw new GatewayCancelError('not_configured');

  const url = `${MP_API}/preapproval/${encodeURIComponent(preapprovalId)}`;
  const config = { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs };

  try {
    const current = await axios.get(url, config);
    if (current.data?.status === 'cancelled') return 'already_terminal';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    const failure = classify(err);
    logger.warn({ kind: failure.kind, httpStatus: failure.httpStatus }, '[recurring-cancel] consulta da recorrência falhou');
    throw failure;
  }

  try {
    const res = await axios.put(url, { status: 'cancelled' }, config);
    if (res.data?.status !== 'cancelled') {
      throw new GatewayCancelError('unverified', res.status);
    }
    return 'cancelled';
  } catch (err) {
    if (err instanceof GatewayCancelError) throw err;
    if (isNotFound(err)) return 'not_found';
    const failure = classify(err);
    logger.warn({ kind: failure.kind, httpStatus: failure.httpStatus }, '[recurring-cancel] cancelamento falhou');
    throw failure;
  }
}
