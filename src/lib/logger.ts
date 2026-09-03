import pino from 'pino';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
/**
 * `pino-pretty` via `transport` sobe uma worker thread (thread-stream) por
 * processo que importa este módulo. Em teste, o Jest isola o cache de módulo
 * POR ARQUIVO mesmo com `--runInBand` — então cada suíte de integração que
 * importa (direta ou indiretamente, via `config/database.ts`) este logger
 * spawna a SUA PRÓPRIA worker, nunca fechada, e o processo acumula uma por
 * suíte ao longo da run inteira. É exatamente o "open handle" que o Jest
 * reporta ao final (`Jest has detected... WORKER`) e a causa mais provável da
 * flakiness intermitente do job de integração no CI (runner com menos núcleos/
 * memória que a máquina de dev). Pretty-print não tem valor nenhum em teste
 * (ninguém lê o log colorido de uma suíte de CI) — desligar aqui elimina o
 * problema na origem, sem tocar no comportamento de dev/produção.
 */
const usePrettyTransport = isDev && process.env.NODE_ENV !== 'test';

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
  ...(usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export default logger;
