/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Resolves DaisyUI CSS color variables to hex strings for chart libraries.
 *
 * DaisyUI 5 uses oklch() color values which SVG/Canvas libraries can't consume directly.
 * This uses a 1x1 Canvas to convert any CSS color (including oklch) to sRGB hex.
 */

const DAISY_COLOR_VARS = [
  '--color-primary',
  '--color-secondary',
  '--color-accent',
  '--color-info',
  '--color-success',
  '--color-warning',
  '--color-error',
];

const FALLBACK_PALETTE = [
  '#6366f1', '#ec4899', '#f59e0b', '#3b82f6', '#22c55e', '#ef4444', '#a855f7',
];

/**
 * Converts a CSS color string (including oklch) to a hex color using Canvas API.
 * Canvas always resolves to sRGB regardless of input color space.
 */
export function cssColorToHex(cssColor: string): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/**
 * Reads DaisyUI theme color CSS variables and returns them as hex strings.
 * Uses Canvas API to resolve oklch() values to sRGB hex.
 * Returns a fallback palette if running outside a browser or if conversion fails.
 */
export function getDaisyUIChartColors(): string[] {
  if (typeof document === 'undefined') return [...FALLBACK_PALETTE];

  const style = getComputedStyle(document.documentElement);
  const colors: string[] = [];

  for (const varName of DAISY_COLOR_VARS) {
    const value = style.getPropertyValue(varName).trim();
    if (!value) continue;
    const hex = cssColorToHex(value);
    if (hex && hex !== '#000000') {
      colors.push(hex);
    }
  }

  return colors.length >= 2 ? colors : [...FALLBACK_PALETTE];
}

/**
 * Known DaisyUI color names that map to CSS variables.
 * Integrators can use these names in seriesColors config (e.g., 'primary', 'error')
 * instead of hardcoded hex values — colors automatically follow the active theme.
 */
const DAISY_COLOR_NAMES: Record<string, string> = {
  'primary': '--color-primary',
  'secondary': '--color-secondary',
  'accent': '--color-accent',
  'info': '--color-info',
  'success': '--color-success',
  'warning': '--color-warning',
  'error': '--color-error',
  'neutral': '--color-neutral',
  'base-content': '--color-base-content',
};

/**
 * Resolves a color value that may be a DaisyUI name, hex, or any CSS color.
 * - 'primary' → resolves --color-primary from current theme → hex
 * - '#ff0000' → returned as-is
 * - 'rgb(255,0,0)' → converted to hex via Canvas
 */
export function resolveChartColor(color: string): string {
  if (typeof document === 'undefined') return color;

  // Check if it's a DaisyUI color name
  const cssVar = DAISY_COLOR_NAMES[color];
  if (cssVar) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    if (value) {
      return cssColorToHex(value) || color;
    }
  }

  // If it starts with #, it's already hex
  if (color.startsWith('#')) return color;

  // Otherwise try to resolve via Canvas (handles rgb, hsl, oklch, etc.)
  return cssColorToHex(color) || color;
}
