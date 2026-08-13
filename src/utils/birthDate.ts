import { dayKey } from './appDay';

/**
 * Idade mínima para criar conta.
 *
 * Os Termos e a Política publicados dizem "18 anos ou mais", mas até ago/2026 o
 * cadastro nem perguntava a data de nascimento — a regra existia só no texto. O
 * app trata dados sensíveis de saúde (art. 11 da LGPD) e a classificação IARC
 * declarada às lojas parte dessa mesma premissa, então a checagem passou a ser
 * feita no servidor.
 */
export const MINIMUM_AGE_YEARS = 18;

/** Normaliza 'YYYY-MM-DD' (aceita ISO completo). Devolve null se inválida. */
export function parseBirthDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejeita data que "existe" no formato mas não no calendário (ex.: 2000-02-31,
  // que o Date silenciosamente vira 02 de março).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  if (year < 1900) return null;
  if (value > dayKey()) return null; // nascer no futuro, não

  return value;
}

/** Idade em anos completos, comparando no fuso do usuário (não em UTC). */
export function ageInYears(birthDate: string, today: string = dayKey()): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);

  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

export function isAdult(birthDate: string): boolean {
  return ageInYears(birthDate) >= MINIMUM_AGE_YEARS;
}

/**
 * Valida a data recebida no cadastro público. Lança erro com `code` estável para
 * o frontend distinguir "data inválida" de "menor de idade".
 */
export function assertAdultBirthDate(input: unknown): string {
  const parsed = parseBirthDate(input);
  if (!parsed) {
    const err: any = new Error('Informe uma data de nascimento valida.');
    err.code = 'INVALID_BIRTH_DATE';
    throw err;
  }
  if (!isAdult(parsed)) {
    const err: any = new Error(
      `É necessário ter ${MINIMUM_AGE_YEARS} anos ou mais para criar uma conta.`,
    );
    err.code = 'UNDERAGE';
    throw err;
  }
  return parsed;
}
