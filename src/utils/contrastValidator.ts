/**
 * WCAG 2.1 relative luminance and contrast ratio.
 * Used to validate branding colors before persisting.
 */

function linearize(val: number): number {
  const v = val / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b];
}

export function contrastRatio(hexA: string, hexB: string): number {
  const rgbA = hexToRgb(hexA);
  const rgbB = hexToRgb(hexB);
  if (!rgbA || !rgbB) return 0;

  const lumA = relativeLuminance(...rgbA);
  const lumB = relativeLuminance(...rgbB);

  const lighter = Math.max(lumA, lumB);
  const darker  = Math.min(lumA, lumB);

  return (lighter + 0.05) / (darker + 0.05);
}

/** Returns null if valid, or an error message if invalid. */
export function validateBrandingColor(
  hex: string,
  label: string,
  minRatio = 4.5
): string | null {
  if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    return `${label}: formato inválido (use #RRGGBB).`;
  }
  const ratio = contrastRatio(hex, '#FFFFFF');
  if (ratio < minRatio) {
    return `${label}: contraste ${ratio.toFixed(2)}:1 abaixo do mínimo WCAG AA de ${minRatio}:1 em relação ao fundo branco.`;
  }
  return null;
}
