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
      '*.card',
      '*.cvv',
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
