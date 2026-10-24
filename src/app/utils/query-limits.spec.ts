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

import { clampLimit, clampPage, MAX_LIMIT } from './query-limits';

describe('query-limits', () => {
  it('Q-10: clampLimit drops zero, negative and NaN limits (no limit sent)', () => {
    expect(clampLimit(0)).toBeUndefined();
    expect(clampLimit(-5)).toBeUndefined();
    expect(clampLimit(NaN)).toBeUndefined();
    expect(clampLimit(undefined)).toBeUndefined();
  });

  it('Q-10: clampLimit floors fractions and caps at the maximum', () => {
    expect(clampLimit(2.7)).toBe(2);
    expect(clampLimit(5000)).toBe(MAX_LIMIT);
  });

  it('Q-10: clampPage returns 1 for NaN or below 1 and floors fractions', () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage('abc')).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-2)).toBe(1);
    expect(clampPage('3.9')).toBe(3);
  });
});
