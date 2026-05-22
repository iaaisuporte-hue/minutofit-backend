/**
 * Lightweight server-side HTML sanitizer for user-supplied branding strings.
 * Strips all HTML tags and JS event attributes.
 * Does NOT provide full XSS protection for rich HTML — only for plain-text fields
 * that must never be rendered as innerHTML.
 */

/**
 * Remove all HTML/SVG tags and dangerous patterns.
 * Does NOT decode HTML entities — output is plain text for JSX text nodes.
 * Decoding entities AFTER stripping creates a bypass: &lt;script&gt; survives
 * the tag strip and becomes <script> after decode. Since welcome_message
 * renders via React JSX {expression} (auto-escaped), entity literals in
 * the output render as visible text, which is correct and safe.
 */
export function stripHtml(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '')       // strip literal tags
    .replace(/javascript:/gi, '')  // extra guard against decoded bypasses
    .replace(/on\w+\s*=/gi, '')    // strip event attr residue
    .trim();
}

/** Sanitize and enforce max length. Returns sanitized string or null if falsy. */
export function sanitizeBrandingText(value: unknown, maxLen: number): string | null {
  const s = stripHtml(value);
  if (!s) return null;
  return s.slice(0, maxLen);
}
