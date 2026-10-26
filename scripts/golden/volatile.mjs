/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Masking of wall-clock-derived values in captured metadata.
 *
 * Action parameter defaults such as `DATE DEFAULT CURRENT_DATE` are rendered by the server as the
 * day of the capture, so a fixture would go stale at the next UTC midnight. A `default_value`
 * that is an ISO date within one day of the capture time (one day each side covers a database
 * timezone that differs from UTC) is replaced by a placeholder. Only the `default_value` key is
 * touched: dates elsewhere are user-meaningful content and are never masked.
 */
export const CLOCK_DATE_PLACEHOLDER = '<CURRENT_DATE>';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Returns { value, count } with clock-derived `default_value` strings replaced. */
export function maskClockDates(value, now = new Date()) {
  let count = 0;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const isClockDate = (s) => {
    if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && Math.abs(t - midnight) <= DAY_MS;
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'default_value' && isClockDate(x)) { out[k] = CLOCK_DATE_PLACEHOLDER; count++; }
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), count };
}
