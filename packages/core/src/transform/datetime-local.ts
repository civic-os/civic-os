/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Date parsing for datetime-local control values, safe across browsers.
 *
 * Safari has strict date parsing requirements that differ from Chrome/Firefox.
 * The `new Date("YYYY-MM-DDTHH:MM")` constructor may fail in Safari, returning
 * Invalid Date. This parser ensures consistent date parsing across all browsers.
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
 *
 * @consumer app
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
