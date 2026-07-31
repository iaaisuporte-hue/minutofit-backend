/**
 * Serialização segura de erro de chamada HTTP externa (axios).
 *
 * ## Por que existe
 *
 * `logger.error({ err }, ...)` com um `AxiosError` serializa o objeto INTEIRO —
 * incluindo `err.config.headers.Authorization` e `err.request._header` (o
 * cabeçalho HTTP bruto). Ambos carregam o Bearer token do provedor.
 *
 * Isso foi observado em produção: uma falha de checkout do Mercado Pago gravou
 * o access token em texto puro nos logs do Render. A redação do pino não pegou
 * porque os paths configurados eram rasos (`*.authorization`, um nível) e em
 * minúsculas, enquanto o header real é `Authorization` três níveis abaixo.
 *
 * A redação em `logger.ts` foi corrigida como rede de segurança, mas o correto
 * é não jogar o erro cru no log: aqui extraímos só o que serve para diagnóstico.
 */

interface AxiosLikeError {
  message?: string;
  code?: string;
  response?: { status?: number; statusText?: string; data?: unknown };
  config?: { method?: string; url?: string };
}

export interface SafeHttpError {
  message: string;
  code?: string;
  status?: number;
  method?: string;
  url?: string;
  /** Corpo da resposta de erro — é onde o provedor explica a causa. */
  responseData?: unknown;
}

/**
 * Extrai de um erro de chamada HTTP só o que é diagnóstico, nunca credencial.
 * Seguro para passar direto ao logger.
 */
export function describeHttpError(err: unknown): SafeHttpError {
  const e = err as AxiosLikeError;

  if (!e || typeof e !== 'object') {
    return { message: String(err) };
  }

  return {
    message: e.message ?? 'unknown error',
    code: e.code,
    status: e.response?.status,
    method: e.config?.method,
    // A URL do provedor não é secreta e é essencial para saber qual chamada falhou.
    url: e.config?.url,
    responseData: e.response?.data,
  };
}
