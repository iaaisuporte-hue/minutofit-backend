/**
 * Alinhado ao frontend: mínimo 8 caracteres, 1 maiúscula A–Z, 1 símbolo não alfanumérico ASCII.
 */
export function assertStrongPassword(password: string): void {
  const p = String(password || '');
  if (p.length < 8) {
    throw new Error('A senha deve ter no minimo 8 caracteres.');
  }
  if (!/[A-Z]/.test(p)) {
    throw new Error('A senha deve incluir pelo menos uma letra maiuscula (A-Z).');
  }
  if (!/[^A-Za-z0-9]/.test(p)) {
    throw new Error('A senha deve incluir pelo menos um simbolo (ex.: ! @ # %).');
  }
}
