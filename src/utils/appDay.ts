/**
 * "Que dia é hoje" — na perspectiva do ALUNO, não do servidor.
 *
 * O padrão anterior (`new Date().toISOString().slice(0, 10)`) devolve o dia UTC.
 * Como o processo roda em UTC na Render e o produto é BR (UTC-3), tudo que
 * acontecia entre 21h00 e 23h59 no horário de Brasília era carimbado no dia
 * SEGUINTE. Efeito prático: quem treinava segunda 21h30 e terça 19h00 tinha os
 * dois registros no mesmo `date_key` — streak 1 em vez de 2, e segunda aparecia
 * como dia perdido no heatmap. A janela 19h–23h é justamente a mais usada.
 *
 * `APP_TIMEZONE` permite mover o fuso sem deploy de código; quando o produto
 * internacionalizar, a evolução natural é resolver por `users.timezone` e passar
 * o fuso do aluno explicitamente — a assinatura já aceita.
 */
export const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

/**
 * Converte um INSTANTE (Date/agora) para a chave de dia 'YYYY-MM-DD' no fuso do
 * aluno. Use sempre que precisar saber "que dia é hoje" a partir de um relógio.
 *
 * NÃO use para valores vindos de colunas `date` do Postgres: o driver já
 * devolve essas como meia-noite LOCAL, e reinterpretá-las num fuso desloca o
 * dia. Para esses casos existe `toDateKey()` em `gamificationService`.
 */
export function dayKey(date: Date = new Date(), timeZone: string = APP_TIMEZONE): string {
  // 'en-CA' formata como YYYY-MM-DD, que é exatamente a chave que usamos.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Diferença em dias inteiros entre duas chaves 'YYYY-MM-DD'. */
export function dayKeyDiff(fromKey: string, toKey: string): number {
  const ms = (key: string): number => {
    const [y, m, d] = key.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(toKey) - ms(fromKey)) / 86_400_000);
}

/**
 * Um dia de calendário (`YYYY-MM-DD`) vira um INSTANTE ao meio-dia do fuso do
 * aluno.
 *
 * Existe porque `'2026-08-13'::timestamptz` no Postgres é meia-noite **UTC** —
 * que em São Paulo é 21h do dia 12. Um marco conquistado hoje apareceria
 * carimbado ontem, num registro que o produto vende como auditável, e a
 * ordenação por data misturaria o marco de hoje com a sessão de ontem à noite.
 *
 * O meio-dia é escolha deliberada: qualquer erro de uma hora (horário de verão,
 * mudança de regra de fuso) continua caindo no mesmo dia de calendário. Meia-
 * noite não teria essa folga.
 */
export function dayKeyToInstant(day: string, timeZone: string = APP_TIMEZONE): Date {
  const utcNoon = Date.parse(`${day}T12:00:00Z`);
  if (Number.isNaN(utcNoon)) return new Date(NaN);

  // O deslocamento sai do Intl, nunca do fuso do PROCESSO: em produção o
  // servidor roda em UTC e a máquina do desenvolvedor não, e uma conta que
  // dependesse disso daria resultados diferentes nos dois lugares — o tipo de
  // defeito que só aparece depois do deploy.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcNoon));

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return new Date(utcNoon + (utcNoon - asIfUtc));
}
