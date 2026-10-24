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

/** Largest `limit` / `pageSize` the app sends (calendar range fetches use 1000); core takes the maximum as an option (Q-10). */
export const MAX_LIMIT = 1000;

/** Page sizes the pagination component offers. */
export const PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100, 200];

/**
 * A page size from the URL or localStorage, made safe for core (Q-10): not a
 * positive number falls back to `fallback`, anything above the largest
 * pagination option is clamped to it, fractions are floored.
 */
export function clampPageSize(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, PAGE_SIZE_OPTIONS[PAGE_SIZE_OPTIONS.length - 1]);
}

/** A configured row limit, clamped to {@link MAX_LIMIT}; undefined stays undefined (no limit sent). */
export function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(n, MAX_LIMIT);
}

/** Page number from a URL or stored value: NaN or below 1 becomes 1; fractions are floored. */
export function clampPage(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
