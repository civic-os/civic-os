/**
 * Color utility functions for calculating contrast and luminance.
 * Uses the YIQ formula which weights RGB channels based on human perception.
 */

/**
 * Calculate contrast text color based on background luminance.
 * Uses YIQ formula for human-perceived brightness.
 *
 * The YIQ formula weights colors based on human perception:
 * - Green contributes most (58.7%) - our eyes are most sensitive to green
 * - Red is second (29.9%)
 * - Blue is least (11.4%) - our eyes are least sensitive to blue
 *
 * @param hexColor - Hex color string (e.g., '#F59E0B' or 'F59E0B')
 * @returns 'white' for dark backgrounds, 'black' for light backgrounds
 */
export function getContrastTextColor(hexColor: string): 'white' | 'black' {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // YIQ formula: human-perceived brightness (0-255 scale)
  // Threshold of 128 is the midpoint
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  return luminance > 128 ? 'black' : 'white';
}
