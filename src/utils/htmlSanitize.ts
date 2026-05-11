/**
 * Lightweight server-side HTML sanitizer for user-supplied branding strings.
 * Strips all HTML tags and JS event attributes.
 * Does NOT provide full XSS protection for rich HTML — only for plain-text fields
 * that must never be rendered as innerHTML.
 */

/** Remove all HTML/SVG tags and decode basic entities. */
export function stripHtml(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '')       // strip tags
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/javascript:/gi, '')  // extra guard
    .replace(/on\w+\s*=/gi, '')    // strip event attrs residue
    .trim();
}

/** Sanitize and enforce max length. Returns sanitized string or null if falsy. */
export function sanitizeBrandingText(value: unknown, maxLen: number): string | null {
  const s = stripHtml(value);
  if (!s) return null;
  return s.slice(0, maxLen);
}
