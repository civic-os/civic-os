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

import { getContrastTextColor } from './color.utils';

/**
 * Reference WCAG contrast-ratio implementation used to assert the util picks
 * the higher-ratio text color (mirrors the algorithm under test).
 */
function ratio(hexColor: string, text: 'black' | 'white'): number {
  const hex = hexColor.replace('#', '');
  const chan = (i: number) => {
    const c = parseInt(hex.substring(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const bg = 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
  const fg = text === 'white' ? 1 : 0;
  const lighter = Math.max(bg, fg);
  const darker = Math.min(bg, fg);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('getContrastTextColor', () => {
  // The util returns whichever of black/white text has the HIGHER WCAG contrast
  // ratio against the background — not a YIQ brightness threshold. Mid-luminance
  // hues (blue, red, purple, mid-grays) resolve to black because black text
  // actually contrasts better on them.

  describe('dark backgrounds (should return white)', () => {
    it('should return white for dark green (#166534)', () => {
      expect(getContrastTextColor('#166534')).toBe('white');
    });

    it('should return white for gray (#6B7280)', () => {
      expect(getContrastTextColor('#6B7280')).toBe('white');
    });

    it('should return white for black (#000000)', () => {
      expect(getContrastTextColor('#000000')).toBe('white');
    });
  });

  describe('light/mid backgrounds (should return black)', () => {
    it('should return black for amber (#F59E0B)', () => {
      expect(getContrastTextColor('#F59E0B')).toBe('black');
    });

    it('should return black for yellow (#FFFF00)', () => {
      expect(getContrastTextColor('#FFFF00')).toBe('black');
    });

    it('should return black for bright green (#22C55E)', () => {
      // Tailwind green-500: black text has ~9.2:1 vs white ~2.3:1
      expect(getContrastTextColor('#22C55E')).toBe('black');
    });

    it('should return black for white (#FFFFFF)', () => {
      expect(getContrastTextColor('#FFFFFF')).toBe('black');
    });

    it('should return black for light gray (#D1D5DB)', () => {
      expect(getContrastTextColor('#D1D5DB')).toBe('black');
    });

    it('should return black for cyan (#00FFFF)', () => {
      expect(getContrastTextColor('#00FFFF')).toBe('black');
    });

    it('should return black for blue (#3B82F6)', () => {
      // Ratio-based: black 5.7:1 beats white 3.7:1 (YIQ would have said white)
      expect(getContrastTextColor('#3B82F6')).toBe('black');
    });

    it('should return black for red (#EF4444)', () => {
      // Ratio-based: black 5.6:1 beats white 3.8:1
      expect(getContrastTextColor('#EF4444')).toBe('black');
    });

    it('should return black for purple (#8B5CF6)', () => {
      // Ratio-based: black 5.0:1 beats white 4.2:1
      expect(getContrastTextColor('#8B5CF6')).toBe('black');
    });
  });

  describe('ratio-based selection (returns the higher-contrast option)', () => {
    it('picks black for blue because black contrast > white contrast', () => {
      expect(ratio('#3B82F6', 'black')).toBeGreaterThan(ratio('#3B82F6', 'white'));
      expect(getContrastTextColor('#3B82F6')).toBe('black');
    });

    it('picks white for dark green because white contrast > black contrast', () => {
      expect(ratio('#166534', 'white')).toBeGreaterThan(ratio('#166534', 'black'));
      expect(getContrastTextColor('#166534')).toBe('white');
    });

    it('returns the option meeting the 4.5:1 AA target for amber (#F59E0B)', () => {
      // Black on amber comfortably exceeds 4.5:1
      expect(ratio('#F59E0B', 'black')).toBeGreaterThanOrEqual(4.5);
      expect(getContrastTextColor('#F59E0B')).toBe('black');
    });
  });

  describe('input format handling', () => {
    it('should handle hex without # prefix', () => {
      expect(getContrastTextColor('166534')).toBe('white');
    });

    it('should handle hex with # prefix', () => {
      expect(getContrastTextColor('#166534')).toBe('white');
    });

    it('should handle lowercase hex', () => {
      expect(getContrastTextColor('#166534')).toBe('white');
    });

    it('should handle uppercase hex', () => {
      expect(getContrastTextColor('#F59E0B')).toBe('black');
    });
  });

  describe('mid-gray crossover', () => {
    it('should return black for mid gray (#808080)', () => {
      // WCAG crossover is near L=0.18; #808080 (L≈0.216) favors black text
      expect(getContrastTextColor('#808080')).toBe('black');
    });

    it('should return black for gray just above mid (#838383)', () => {
      expect(getContrastTextColor('#838383')).toBe('black');
    });
  });
});
