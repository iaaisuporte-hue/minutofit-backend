import pino from 'pino';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

/**
 * Logger centralizado para todo o backend.
 * Em dev: pretty-print legível no terminal.
 * Em prod: JSON estruturado compatível com Render log drain / Sentry breadcrumbs.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Rede de segurança: nunca emitir segredos/PII sensível em log, mesmo que
  // uma linha de log futura inclua esses campos por descuido.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'token',
      '*.token',
      'access_token',
      '*.access_token',
      'refresh_token',
      '*.refresh_token',
      'authorization',
      '*.authorization',
      // Erro de axios carrega o Bearer token em DOIS lugares profundos, e o
      // header vem com "A" maiúsculo — os paths do pino são case-sensitive e
      // `*.authorization` só casa UM nível. Sem estes, um checkout do Mercado
      // Pago que falha grava o access token em texto puro no log (observado em
      // produção em 31/07/2026). Rede de segurança: o caminho correto é usar
      // `describeHttpError` (lib/httpError.ts) em vez de logar o erro cru.
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.response.config.headers.Authorization',
      'err.response.config.headers.authorization',
      'err.request._header',
      'err.request._redirectable._options.headers.Authorization',
      '*.card',
      '*.cvv',
      // PII / dados pessoais (LGPD)
      'email',
      '*.email',
      'cpf',
      '*.cpf',
      'phone',
      '*.phone',
      'payer',
      '*.payer',
      'payer_email',
      '*.payer_email',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export default logger;
