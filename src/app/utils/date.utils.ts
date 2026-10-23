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
 * Date utility functions for cross-browser compatibility.
 *
 * Safari has strict date parsing requirements that differ from Chrome/Firefox.
 * The `new Date("YYYY-MM-DDTHH:MM")` constructor may fail in Safari, returning
 * Invalid Date. These utilities ensure consistent date parsing across all browsers.
 */

// parseDatetimeLocal lives in @civic-os/core; re-exported so existing importers are unchanged.
import { parseDatetimeLocal } from '@civic-os/core';
export { parseDatetimeLocal };

/**
 * Check if a datetime-local string is valid without creating a Date object.
 * Useful for validation before parsing.
 *
 * @param datetimeLocalString - String to validate
 * @returns true if the string is a valid datetime-local format
 */
export function isValidDatetimeLocal(datetimeLocalString: string): boolean {
  return parseDatetimeLocal(datetimeLocalString) !== null;
}

/**
 * Parse a bounded PostgreSQL tstzrange string into its two instants.
 *
 * Accepts both shapes a TimeSlot form control can hold:
 * - Built by EditTimeSlotComponent: `[2025-01-15T22:30:00.000Z,2025-01-15T23:30:00.000Z)`
 * - Loaded from PostgREST unchanged: `["2025-01-15 22:30:00+00","2025-01-15 23:30:00+00")`
 *
 * @returns Start and end instants, or null unless both bounds carry an explicit zone
 */
export function parseTstzrange(range: string): { start: Date; end: Date } | null {
  if (!range || typeof range !== 'string') return null;

  const match = range.match(/^[\[(]\s*"?([^",]+?)"?\s*,\s*"?([^",)\]]+?)"?\s*[)\]]$/);
  if (!match) return null;

  const start = parseZonedTimestamp(match[1]);
  const end = parseZonedTimestamp(match[2]);
  return start && end ? { start, end } : null;
}

/** PostgreSQL timestamptz text (space separator, "+00" offsets) or ISO 8601 → Date; null without a zone */
function parseZonedTimestamp(text: string): Date | null {
  const iso = text.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  // An instant needs an explicit zone; a bare wall-clock string would be read as browser-local
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Whether `timeZone` is an IANA name the expansion worker and PostgreSQL accept as
 * stored: exact case, not a UTC offset. Intl is more lenient ("+05:30",
 * "america/new_york", "est"), which would make the frontend and the worker
 * disagree; time_slot_series.timezone is checked against pg_timezone_names.
 */
export function isIanaTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone || /^[+\-]|^(GMT|UTC)[+\-]\d/i.test(timeZone)) return false;
  if (timeZone === 'UTC') return true;
  // IANA names start every segment with an upper-case letter ("America/New_York", "EST")
  if (!timeZone.split('/').every(part => /^[A-Z]/.test(part))) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    // Wrong case resolves to the canonical spelling; an alias resolves to another name
    return resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Format an absolute instant as wall-clock time in an IANA timezone,
 * as `YYYY-MM-DDTHH:MM:SS` with no offset — the shape of a PostgreSQL
 * `timestamp without time zone`.
 *
 * Recurring series store `dtstart` this way (v0.38.5+): "every Tuesday at 17:30"
 * in the series' `timezone`. Sending a UTC ISO string instead makes PostgreSQL
 * drop the zone and store the UTC clock reading, shifting the series by the
 * UTC offset.
 *
 * A series without a (valid) timezone is expanded in UTC by the worker, so that is
 * the fallback here too, never the browser's timezone.
 *
 * @param instant - The absolute point in time
 * @param timeZone - IANA zone (e.g. 'America/New_York'); null, empty or unknown → UTC
 */
export function toWallClockInTimeZone(instant: Date, timeZone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  };
  // Same rule as the worker (LoadLocation) and time_slot_series' check: an exact
  // IANA name, else UTC. Intl alone would accept "+05:30" or "america/new_york".
  const formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: isIanaTimeZone(timeZone) ? timeZone! : 'UTC' });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  // Some engines render midnight as "24" even with hourCycle h23
  const hour = parts['hour'] === '24' ? '00' : parts['hour'];
  return `${parts['year']}-${parts['month']}-${parts['day']}T${hour}:${parts['minute']}:${parts['second']}`;
}

/**
 * Parse a PostgreSQL DATE (`YYYY-MM-DD`) as local midnight.
 *
 * `new Date('2026-12-07')` is UTC midnight, which displays as the previous day
 * anywhere west of UTC. Recurring `occurrence_date` values are local dates in the
 * series timezone (v0.76.9+), so they must be parsed as calendar dates, not instants.
 *
 * @returns Local-midnight Date, or null for anything that is not a valid `YYYY-MM-DD`
 */
export function parseDateOnly(dateString: string): Date | null {
  const match = typeof dateString === 'string' ? dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

/**
 * The calendar date of an instant in an IANA timezone, as `YYYY-MM-DD`, for
 * comparing against PostgreSQL DATE values such as recurring `occurrence_date`
 * (a local date in the series timezone). `toISOString().split('T')[0]` gives the
 * UTC date instead, and the browser's local date is the wrong day for a series in
 * another zone.
 *
 * @param timeZone - The series timezone; null, empty or unknown → UTC (the worker's rule)
 * @param at - The instant (default: now)
 */
export function dateInTimeZone(timeZone: string | null | undefined, at: Date = new Date()): string {
  return toWallClockInTimeZone(at, timeZone).slice(0, 10);
}
