import { type Request, type Response, type NextFunction } from 'express';
import { parseId } from '../utils/parseId';

/**
 * Valida um path param numérico ANTES de qualquer handler tocar o banco.
 *
 * Uso: `router.param('studentId', numericParam('studentId'))` — vale para todas
 * as rotas do router que usam aquele param, sem precisar repetir a checagem em
 * cada handler.
 *
 * Motivo (QA 02/ago/2026, P0-1 / P2-7): `Number(req.params.x)` aceitava
 * `9007199254740991` e `-99999999999`, que passavam pelo `Number.isFinite` e
 * estouravam o `int4` no Postgres — 500 na melhor hipótese, queda do processo
 * na pior. Aqui a fronteira é a faixa do próprio tipo do banco.
 *
 * NÃO aplicar a params que não são inteiros (ex.: `/exercises/:id`, que é UUID).
 */
export function numericParam(name: string) {
  return (_req: Request, res: Response, next: NextFunction, value: string) => {
    if (parseId(value) === null) {
      return res.status(400).json({ success: false, error: `invalid_${name}` });
    }
    return next();
  };
}

/** Açúcar para registrar vários params de uma vez no mesmo router. */
export function registerNumericParams(
  router: { param: (name: string, handler: ReturnType<typeof numericParam>) => unknown },
  names: string[],
): void {
  for (const name of names) router.param(name, numericParam(name));
}
