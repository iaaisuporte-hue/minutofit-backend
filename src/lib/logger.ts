import pino from 'pino';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

/**
 * Logger centralizado para todo o backend.
 * Em dev: pretty-print legível no terminal.
 * Em prod: JSON estruturado compatível com Render log drain / Sentry breadcrumbs.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
