import { Request, Response, NextFunction } from 'express';

/**
 * Sanitiza respostas 500 num único ponto (segurança/LGPD).
 *
 * ~140 handlers fazem `res.status(500).json({ error: error.message })`, vazando
 * SQL/constraints/internals do Postgres ao cliente. Em vez de editar todos, este
 * middleware intercepta `res.json` e, quando o status for **exatamente 500**
 * (erro inesperado de servidor), substitui o corpo por uma mensagem genérica +
 * requestId (para suporte correlacionar com o log/Sentry).
 *
 * Só 500 é sanitizado — 4xx (mensagens intencionais ao usuário) e 503
 * (health/PAYMENTS_UNAVAILABLE) passam intactos.
 */
export function sanitize5xxResponses(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode === 500) {
      const requestId = (req as unknown as { id?: string }).id ?? res.getHeader('x-request-id');
      return originalJson({ success: false, error: 'Internal server error', requestId });
    }
    return originalJson(body);
  }) as Response['json'];
  next();
}
