/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Time-zone arithmetic for the value transforms, on an explicit IANA zone
 * (X-01). Nothing here reads the ambient zone, so the same input gives the
 * same output on any host. A host-zone `Date` constructor is the oracle the
 * tests compare against when the explicit zone is the host zone.
 *
 * Gap and overlap policy for a wall-clock time in a zone:
 * - a time that does not exist (spring-forward gap) is shifted forward by the
 *   gap, like the `Date` constructor and PostgreSQL (F-05): New York
 *   2026-03-08 02:30 is 03:30 EDT (07:30Z);
 * - a time that occurs twice (fall-back overlap) resolves to the earlier
 *   instant, like the `Date` constructor (PostgreSQL picks the later one;
 *   informational only, not changed).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // Intl falls back to the ambient zone for an undefined `timeZone`, so an untyped
  // caller must be stopped here (X-01). Every zone computation goes through this.
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new TypeError(`A time zone is required: pass an IANA zone name such as "America/New_York" (got ${JSON.stringify(timeZone) ?? String(timeZone)}).`);
  }
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new RangeError(`Unknown time zone: ${JSON.stringify(timeZone)}. Pass an IANA zone name such as "America/New_York".`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** Calendar and clock fields, month 1-12. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Epoch ms of wall-clock fields read as UTC (years 0-99 are not remapped to 19xx). */
function utcMs(w: WallClock): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return d.getTime();
}

/** The wall-clock fields `timeZone` shows at the instant `epochMs`. */
export function wallClockAt(timeZone: string, epochMs: number): WallClock {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return {
    year: out['year'],
    month: out['month'],
    day: out['day'],
    hour: out['hour'] === 24 ? 0 : out['hour'],
    minute: out['minute'],
    second: out['second'],
  };
}

/** Offset of `timeZone` from UTC at `epochMs`, in milliseconds (east is positive). */
export function offsetAt(timeZone: string, epochMs: number): number {
  const w = wallClockAt(timeZone, epochMs);
  const asUtc = utcMs(w);
  // Whole seconds only: the formatter has no sub-second field.
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant (epoch ms) of a wall-clock time in `timeZone`; see the gap and overlap policy above. */
export function instantOfWallClock(timeZone: string, w: WallClock): number {
  const naive = utcMs(w);
  const before = offsetAt(timeZone, naive - DAY_MS);
  const after = offsetAt(timeZone, naive + DAY_MS);
  const valid: number[] = [];
  for (const o of before === after ? [before] : [before, after]) {
    const candidate = naive - o;
    if (offsetAt(timeZone, candidate) === o) valid.push(candidate);
  }
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: no offset reproduces the wall clock. The offset in force before
  // the transition shifts the time forward past the gap.
  return naive - before;
}

/** Days in a month (month 1-12) of a proleptic Gregorian year. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True when the fields name a real calendar date and clock time. */
export function isValidWallClock(w: WallClock): boolean {
  return (
    w.month >= 1 && w.month <= 12 &&
    w.day >= 1 && w.day <= daysInMonth(w.year, w.month) &&
    w.hour >= 0 && w.hour <= 23 &&
    w.minute >= 0 && w.minute <= 59 &&
    w.second >= 0 && w.second <= 59
  );
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DDTHH:MM`, the shape a datetime-local control holds. */
export function formatControlValue(w: WallClock): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS` string (16 or 19
 * characters) into wall-clock fields; null when the shape or the calendar is wrong.
 */
export function parseWallClock(value: string): WallClock | null {
  const m = LOCAL_RE.exec(value);
  if (!m) return null;
  const w: WallClock = {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
    hour: parseInt(m[4], 10),
    minute: parseInt(m[5], 10),
    second: m[6] === undefined ? 0 : parseInt(m[6], 10),
  };
  return isValidWallClock(w) ? w : null;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Result of parsing a PostgREST / ISO date-time string. */
export type ParsedTimestamp =
  | { kind: 'instant'; epochMs: number }
  | { kind: 'wallClock'; wallClock: WallClock }
  | { kind: 'date'; wallClock: WallClock };

/**
 * Explicit parse rules for a timestamptz value coming back from PostgREST (F-10):
 * - date and time with an offset (`Z`, `+00:00`, `-0500`, `+05`): an instant;
 * - date and time without an offset: a wall-clock time in the viewer's zone,
 *   shown as written (never read as UTC);
 * - a date alone (`2026-07-04`): a calendar day, shown as midnight of that day
 *   in the viewer's zone (never as UTC midnight, which is the previous evening
 *   west of Greenwich);
 * - anything else, an impossible calendar date, or an offset on a date alone: null.
 */
export function parseTimestamp(value: string): ParsedTimestamp | null {
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const offset = m[7];
  if (!hasTime && offset !== undefined) return null;
  const w: WallClock = {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
    hour: hasTime ? parseInt(m[4], 10) : 0,
    minute: hasTime ? parseInt(m[5], 10) : 0,
    second: hasTime && m[6] !== undefined ? parseInt(m[6], 10) : 0,
  };
  if (!isValidWallClock(w)) return null;
  if (!hasTime) return { kind: 'date', wallClock: w };
  if (offset === undefined) return { kind: 'wallClock', wallClock: w };
  const offsetMs = parseOffsetMs(offset);
  if (offsetMs === null) return null;
  return { kind: 'instant', epochMs: utcMs(w) - offsetMs };
}

/** `Z`, `+HH`, `+HH:MM` or `+HHMM` as milliseconds east of UTC; null when out of range. */
function parseOffsetMs(offset: string): number | null {
  if (offset === 'Z') return 0;
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const hours = parseInt(digits.slice(0, 2), 10);
  const minutes = digits.length > 2 ? parseInt(digits.slice(2), 10) : 0;
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}
