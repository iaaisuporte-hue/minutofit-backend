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
