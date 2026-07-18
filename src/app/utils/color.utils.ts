/**
 * Color utility functions for calculating WCAG contrast and luminance.
 */

/**
 * Convert a single 0-255 sRGB channel to its linearized value for the
 * WCAG relative-luminance formula.
 * @see https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of an sRGB color (0 = black, 1 = white).
 */
function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/**
 * WCAG contrast ratio between two relative luminances (1:1 to 21:1).
 */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Choose the text color ('black' or 'white') that yields the higher WCAG
 * contrast ratio against the given background color.
 *
 * Unlike a simple YIQ brightness threshold, this computes the actual WCAG 2.1
 * contrast ratio of the background against pure black and pure white and returns
 * whichever wins. When neither reaches the 4.5:1 AA target (common for very
 * mid-luminance hues), the higher-ratio option is still returned so text stays
 * as legible as the background allows.
 *
 * @param hexColor - Hex color string (e.g., '#F59E0B' or 'F59E0B')
 * @returns 'white' or 'black' — whichever contrasts better with the background
 */
export function getContrastTextColor(hexColor: string): 'white' | 'black' {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const bgLuminance = relativeLuminance(r, g, b);
  const contrastWithBlack = contrastRatio(bgLuminance, 0); // black text
  const contrastWithWhite = contrastRatio(bgLuminance, 1); // white text

  return contrastWithBlack >= contrastWithWhite ? 'black' : 'white';
}
