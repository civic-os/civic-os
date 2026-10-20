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

/**
 * Safely parse a datetime-local input string to a Date object.
 *
 * datetime-local inputs return values in format "YYYY-MM-DDTHH:MM" (16 characters).
 * Safari may not correctly parse this format with `new Date()`, so we manually
 * extract components to ensure consistent behavior across all browsers.
 *
 * @param datetimeLocalString - String from datetime-local input (e.g., "2025-01-15T14:00")
 * @returns Date object in local timezone, or null if invalid
 *
 * @example
 * const date = parseDatetimeLocal("2025-01-15T14:00");
 * // Returns Date representing 2:00 PM local time on Jan 15, 2025
 *
 * @example
 * const invalid = parseDatetimeLocal("not-a-date");
 * // Returns null
 */
export function parseDatetimeLocal(datetimeLocalString: string): Date | null {
  if (!datetimeLocalString || typeof datetimeLocalString !== 'string') {
    return null;
  }

  // datetime-local format: "YYYY-MM-DDTHH:MM" (exactly 16 characters)
  // Also support "YYYY-MM-DDTHH:MM:SS" (19 characters) for flexibility
  const match = datetimeLocalString.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    // Not a datetime-local format - only fall back to native parsing for
    // ISO 8601 strings with explicit timezone indicators (Z suffix or ±HH:MM offset).
    // This prevents accepting arbitrary date formats that Chrome parses but Safari may not.
    const isISO8601WithTimezone = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(datetimeLocalString);
    if (!isISO8601WithTimezone) {
      return null;
    }
    const fallback = new Date(datetimeLocalString);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, yearStr, monthStr, dayStr, hoursStr, minutesStr, secondsStr] = match;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1; // JavaScript months are 0-indexed
  const day = parseInt(dayStr, 10);
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  const seconds = secondsStr ? parseInt(secondsStr, 10) : 0;

  // Validate ranges
  if (month < 0 || month > 11 || day < 1 || day > 31 ||
      hours < 0 || hours > 23 || minutes < 0 || minutes > 59 ||
      seconds < 0 || seconds > 59) {
    return null;
  }

  // Create Date using local timezone (not UTC)
  const date = new Date(year, month, day, hours, minutes, seconds);

  // Verify the date components weren't adjusted (e.g., Feb 30 -> Mar 2)
  if (date.getFullYear() !== year ||
      date.getMonth() !== month ||
      date.getDate() !== day) {
    return null;
  }

  return date;
}

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
  let formatter: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  };
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timeZone || 'UTC' });
  } catch {
    // RangeError for an unknown zone name: same UTC fallback as the expansion worker
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  // Some engines render midnight as "24" even with hourCycle h23
  const hour = parts['hour'] === '24' ? '00' : parts['hour'];
  return `${parts['year']}-${parts['month']}-${parts['day']}T${hour}:${parts['minute']}:${parts['second']}`;
}
