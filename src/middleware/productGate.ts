import { Request, Response, NextFunction } from 'express';

/**
 * Middleware de gate de produto.
 *
 * Verifica se o usuário autenticado possui o produto ativo no JWT.
 * Admin role (CoreFit) é bypassado por padrão.
 *
 * Uso:
 *   router.get('/my-feature', authMiddleware, requireProduct('personal'), handler)
 *
 * O claim `products` é injetado no JWT no login/refresh/OAuth/switch-academy.
 * Tokens legados sem o campo são tratados como sem produto (array vazio).
 */
export function requireProduct(productKey: string, bypassRoles: string[] = ['admin']) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (bypassRoles.includes(req.user.role)) {
      next();
      return;
    }

    // Academy staff profiles implicitly hold the 'academia' product even when
    // user_products was not seeded (e.g. fresh environment or seed gap).
    // academy_student is excluded — students must have the product explicitly granted.
    if (
      productKey === 'academia' &&
      typeof req.user.accessProfile === 'string' &&
      req.user.accessProfile.startsWith('academy_') &&
      req.user.accessProfile !== 'academy_student'
    ) {
      next();
      return;
    }

    const products: string[] = req.user.products ?? [];
    if (!products.includes(productKey)) {
      res.status(403).json({
        success: false,
        error: `Produto '${productKey}' não está habilitado para este usuário.`,
        code: 'PRODUCT_NOT_GRANTED',
        productKey,
      });
      return;
    }

    next();
  };
}
