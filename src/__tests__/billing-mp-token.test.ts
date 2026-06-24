/**
 * Guard de regressão (Spec 011) — token do Mercado Pago no caminho do webhook.
 *
 * O webhook depende de `getPreapprovalStatus` (mercadoPagoService) para buscar o
 * status real do preapproval e ATIVAR o plano. Se esse service voltar a ler
 * apenas `MERCADO_PAGO_ACCESS_TOKEN` (com underscore) e a produção setar só o
 * nome canônico `MERCADOPAGO_ACCESS_TOKEN` (o validado no boot/CLAUDE.md), o
 * service fica com Bearer vazio → webhook 500 em loop → plano NUNCA ativa.
 *
 * Bug histórico (jun/2026): falha silenciosa de ativação. Este teste trava o
 * fallback que voltou a funcionar.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

describe('regressão — token MP do webhook aceita o nome canônico', () => {
  it('mercadoPagoService lê MERCADOPAGO_ACCESS_TOKEN (canônico), não só o legado', () => {
    const src = readFileSync(join(__dirname, '../services/mercadoPagoService.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.MERCADOPAGO_ACCESS_TOKEN/);
  });
});
