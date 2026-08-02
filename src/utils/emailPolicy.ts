/**
 * Validação de e-mail no servidor.
 *
 * O cadastro aceitava qualquer string: `POST /auth/register` com
 * `email: "nao-eh-email"` respondia 201. O `type="email"` do formulário era a
 * única barreira, e ela não existe fora do navegador (app, script, cliente
 * antigo). Como o e-mail é a CHAVE de identidade do signup público
 * (`matchBy: ['email']`) e o único canal de recuperação de senha, um endereço
 * inválido cria uma conta que ninguém consegue recuperar.
 *
 * Deliberadamente permissiva: valida forma, não entregabilidade. Regras
 * criativas demais rejeitam endereços legítimos (subdomínios, TLDs longos,
 * `+tag`), o que é pior do que deixar passar um domínio que não existe.
 */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(\.[^\s@.,;:<>()[\]\\"]+)+$/;

export const MAX_EMAIL_LENGTH = 254; // RFC 5321

export function isValidEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (email.includes('..')) return false;
  return EMAIL_RE.test(email);
}

/** Normaliza para armazenamento/comparação: sem espaços, minúsculo. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}
