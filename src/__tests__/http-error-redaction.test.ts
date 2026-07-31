/**
 * Regressão de vazamento de credencial em log.
 *
 * Em 31/07/2026 uma falha de checkout do Mercado Pago gravou o access token em
 * TEXTO PURO nos logs de produção do Render. O `logger.error({ err }, ...)` com
 * um AxiosError serializa o objeto inteiro, e o Bearer aparece em dois lugares:
 * `err.config.headers.Authorization` e `err.request._header` (cabeçalho bruto).
 *
 * A redação do pino não pegou porque os paths eram rasos (`*.authorization`,
 * um nível) e minúsculos, enquanto o header real é `Authorization` três níveis
 * abaixo — os paths do pino são case-sensitive.
 */

import { describeHttpError } from '../lib/httpError';

const TOKEN = 'APP_USR-super-secreto-nao-pode-vazar';

/** Reproduz a forma de um AxiosError real, com o token nos dois lugares. */
function fakeAxiosError() {
  return {
    name: 'AxiosError',
    message: 'Request failed with status code 401',
    code: 'ERR_BAD_REQUEST',
    isAxiosError: true,
    config: {
      method: 'post',
      url: 'https://api.mercadopago.com/preapproval',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    },
    request: {
      _header: `POST /preapproval HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
    },
    response: {
      status: 401,
      statusText: 'Unauthorized',
      data: { message: 'Unauthorized access to resource.', status: 401 },
      config: { headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  };
}

describe('describeHttpError — não vaza credencial', () => {
  it('o erro cru CONTÉM o token (é o defeito que motivou isto)', () => {
    expect(JSON.stringify(fakeAxiosError())).toContain(TOKEN);
  });

  it('a versão serializada NÃO contém o token', () => {
    const safe = describeHttpError(fakeAxiosError());
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    expect(JSON.stringify(safe)).not.toContain('Bearer');
  });

  it('preserva o que serve para diagnóstico', () => {
    const safe = describeHttpError(fakeAxiosError());
    expect(safe.status).toBe(401);
    expect(safe.code).toBe('ERR_BAD_REQUEST');
    expect(safe.method).toBe('post');
    expect(safe.url).toBe('https://api.mercadopago.com/preapproval');
    // O corpo da resposta é onde o provedor explica a causa — tem que sobreviver.
    expect(safe.responseData).toEqual({ message: 'Unauthorized access to resource.', status: 401 });
  });

  it('aguenta entrada que não é erro de axios', () => {
    expect(describeHttpError(new Error('boom')).message).toBe('boom');
    expect(describeHttpError('string solta').message).toBe('string solta');
    expect(describeHttpError(null).message).toBe('null');
  });
});
