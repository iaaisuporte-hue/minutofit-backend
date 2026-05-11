/**
 * WCAG 2.1 colour utilities.
 * Re-exports from contrastValidator and adds auto-calculation helpers.
 */
export { contrastRatio, validateBrandingColor } from './contrastValidator';

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b];
}

function clamp(v: number): number { return Math.min(255, Math.max(0, Math.round(v))); }

/** Darken a hex colour by `pct` percentage (0–100). */
function darken(hex: string, pct: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const factor = 1 - pct / 100;
  const [r, g, b] = rgb.map((c) => clamp(c * factor)) as [number, number, number];
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Build the primary_hover token (10% darker than primary). */
export function calcPrimaryHover(primary: string): string {
  return darken(primary, 10);
}

/**
 * Build the primary_soft token — primary at 12% opacity blended over white.
 * Returns an rgba-style 8-char hex (#RRGGBBAA) — browsers support this in CSS variables.
 */
export function calcPrimarySoft(primary: string): string {
  const rgb = hexToRgb(primary);
  if (!rgb) return primary;
  const alpha = Math.round(0.12 * 255).toString(16).padStart(2, '0');
  const [r, g, b] = rgb;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${alpha}`;
}

/** Choose #FFFFFF or #000000 to maximise contrast vs `primary`. */
export function calcCtaTextColor(primary: string): string {
  const { contrastRatio } = require('./contrastValidator') as typeof import('./contrastValidator');
  const vsWhite = contrastRatio(primary, '#FFFFFF');
  return vsWhite >= 4.5 ? '#FFFFFF' : '#000000';
}
