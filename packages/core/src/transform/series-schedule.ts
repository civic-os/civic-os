/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The schedule a "this and following" series split sends. Private to core: `recordEditor` edit mode is the only
 * consumer, so this module is not exported from `transform/index.ts` or any barrel.
 *
 * A series' `dtstart` is a `timestamp` (wall clock, no offset) in the series' own zone, so the builder reads the
 * edited start instant as a clock reading in that zone. Nothing here may use a host-zone `Date` getter: the result
 * must be the same wherever the code runs.
 */

import { wallClockAt } from './zone.js';
import type { WallClock } from './zone.js';

/** Schedule anchor of a series version: the `time_slot_series` columns the split reads. */
export interface SeriesSchedule {
  timezone: string | null;
  dtstart: string;
  time_slot_property: string;
}

/** The new schedule of a split: `dtstart` is wall-clock text in the series zone, `duration` an interval in seconds. */
export interface SplitSchedule {
  dtstart: string;
  duration?: string;
}

/** PostgreSQL timestamptz text (space separator, "+00" offsets) or ISO 8601 to an instant; null without a zone. */
function parseZonedTimestamp(text: string): Date | null {
  const iso = text.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  // An instant needs an explicit zone; a bare wall-clock string would be read in the host zone.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Parses a bounded tstzrange text into its two instants. Accepts the range a TimeSlot control builds
 * (`[2025-01-15T22:30:00.000Z,2025-01-15T23:30:00.000Z)`) and the one PostgREST returns
 * (`["2025-01-15 22:30:00+00","2025-01-15 23:30:00+00")`).
 *
 * @returns the start and end instants, or null unless both bounds carry an explicit zone
 */
export function parseTstzrange(range: string): { start: Date; end: Date } | null {
  if (!range || typeof range !== 'string') return null;
  const match = range.match(/^[[(]\s*"?([^",]+?)"?\s*,\s*"?([^",)\]]+?)"?\s*[)\]]$/);
  if (!match) return null;
  const start = parseZonedTimestamp(match[1]!);
  const end = parseZonedTimestamp(match[2]!);
  return start && end ? { start, end } : null;
}

/**
 * Whether `timeZone` is an IANA name the expansion worker and PostgreSQL accept as stored: exact case, not a UTC
 * offset. Intl is more lenient ("+05:30", "america/new_york", "est"), which would make the client and the worker
 * disagree.
 */
export function isIanaTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone || /^[+-]|^(GMT|UTC)[+-]\d/i.test(timeZone)) return false;
  if (timeZone === 'UTC') return true;
  // IANA names start every segment with an upper-case letter ("America/New_York", "EST").
  if (!timeZone.split('/').every(part => /^[A-Z]/.test(part))) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    // Wrong case resolves to the canonical spelling; an alias resolves to another name.
    return resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase();
  } catch {
    return false;
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const format = (w: WallClock) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;

/**
 * An instant as wall-clock text (`YYYY-MM-DDTHH:MM:SS`, no offset) in an IANA zone, the shape of a `timestamp`
 * column. A missing or non-IANA zone reads as UTC, which is what the expansion worker does, never the host zone.
 */
export function toWallClockInTimeZone(instant: Date, timeZone?: string | null): string {
  return format(wallClockAt(isIanaTimeZone(timeZone) ? timeZone! : 'UTC', instant.getTime()));
}

/**
 * The new schedule of a split. With a readable time slot, the start becomes wall-clock text in the series zone and
 * the length becomes the duration. Without one (not part of the edit), the series' own time of day moves to the split
 * date and the duration is left out.
 */
export function buildSplitSchedule(timeSlot: string | null | undefined, splitDate: string, schedule: SeriesSchedule): SplitSchedule {
  const range = timeSlot ? parseTstzrange(timeSlot) : null;
  if (range) {
    const seconds = Math.round((range.end.getTime() - range.start.getTime()) / 1000);
    return {
      dtstart: toWallClockInTimeZone(range.start, schedule.timezone),
      duration: seconds > 0 ? `${seconds} seconds` : undefined,
    };
  }
  const timeOfDay = schedule.dtstart?.match(/[T ](\d{2}:\d{2}(?::\d{2})?)/)?.[1];
  if (timeOfDay) return { dtstart: `${splitDate}T${timeOfDay.length === 5 ? `${timeOfDay}:00` : timeOfDay}` };
  return { dtstart: `${splitDate}T00:00:00` };
}
