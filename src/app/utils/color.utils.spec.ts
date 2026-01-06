/**
 * Copyright (C) 2023-2025 Civic OS, L3C
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

describe('getContrastTextColor', () => {
  describe('dark backgrounds (should return white)', () => {
    it('should return white for blue (#3B82F6)', () => {
      expect(getContrastTextColor('#3B82F6')).toBe('white');
    });

    it('should return white for red (#EF4444)', () => {
      expect(getContrastTextColor('#EF4444')).toBe('white');
    });

    it('should return white for dark green (#166534)', () => {
      // Tailwind green-800: dark enough for white text
      expect(getContrastTextColor('#166534')).toBe('white');
    });

    it('should return white for gray (#6B7280)', () => {
      expect(getContrastTextColor('#6B7280')).toBe('white');
    });

    it('should return white for purple (#8B5CF6)', () => {
      expect(getContrastTextColor('#8B5CF6')).toBe('white');
    });

    it('should return white for black (#000000)', () => {
      expect(getContrastTextColor('#000000')).toBe('white');
    });
  });

  describe('light backgrounds (should return black)', () => {
    it('should return black for amber (#F59E0B)', () => {
      expect(getContrastTextColor('#F59E0B')).toBe('black');
    });

    it('should return black for yellow (#FFFF00)', () => {
      expect(getContrastTextColor('#FFFF00')).toBe('black');
    });

    it('should return black for bright green (#22C55E)', () => {
      // Tailwind green-500: luminance ~136.5, light enough for dark text
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
  });

  describe('input format handling', () => {
    it('should handle hex without # prefix', () => {
      expect(getContrastTextColor('3B82F6')).toBe('white');
    });

    it('should handle hex with # prefix', () => {
      expect(getContrastTextColor('#3B82F6')).toBe('white');
    });

    it('should handle lowercase hex', () => {
      expect(getContrastTextColor('#3b82f6')).toBe('white');
    });

    it('should handle uppercase hex', () => {
      expect(getContrastTextColor('#3B82F6')).toBe('white');
    });
  });

  describe('edge cases around threshold (128)', () => {
    // Pure gray at exactly 128 luminance would be R=G=B where:
    // (R*299 + G*587 + B*114) / 1000 = 128
    // R * (299 + 587 + 114) / 1000 = 128
    // R = 128 (when R=G=B)
    // So #808080 (128, 128, 128) should be exactly at threshold

    it('should return white for gray at threshold (#808080)', () => {
      // Luminance = (128*299 + 128*587 + 128*114) / 1000 = 128
      // Since we use > 128, this should return white
      expect(getContrastTextColor('#808080')).toBe('white');
    });

    it('should return black for gray just above threshold (#838383)', () => {
      // Luminance = (131*299 + 131*587 + 131*114) / 1000 = 131
      expect(getContrastTextColor('#838383')).toBe('black');
    });
  });
});
