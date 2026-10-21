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

import { parseDatetimeLocal, isValidDatetimeLocal, parseTstzrange, toWallClockInTimeZone, parseDateOnly, dateInTimeZone } from './date.utils';

describe('parseDatetimeLocal', () => {
  describe('valid datetime-local formats', () => {
    it('should parse standard datetime-local format (16 chars)', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30');
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2025);
      expect(result!.getMonth()).toBe(0); // January = 0
      expect(result!.getDate()).toBe(15);
      expect(result!.getHours()).toBe(14);
      expect(result!.getMinutes()).toBe(30);
      expect(result!.getSeconds()).toBe(0);
    });

    it('should parse datetime-local with seconds (19 chars)', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30:45');
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(14);
      expect(result!.getMinutes()).toBe(30);
      expect(result!.getSeconds()).toBe(45);
    });

    it('should parse midnight correctly', () => {
      const result = parseDatetimeLocal('2025-01-15T00:00');
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(0);
      expect(result!.getMinutes()).toBe(0);
    });

    it('should parse end of day correctly', () => {
      const result = parseDatetimeLocal('2025-01-15T23:59');
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(23);
      expect(result!.getMinutes()).toBe(59);
    });

    it('should handle year boundaries', () => {
      const newYear = parseDatetimeLocal('2025-01-01T00:00');
      expect(newYear).not.toBeNull();
      expect(newYear!.getFullYear()).toBe(2025);
      expect(newYear!.getMonth()).toBe(0);
      expect(newYear!.getDate()).toBe(1);

      const endOfYear = parseDatetimeLocal('2025-12-31T23:59');
      expect(endOfYear).not.toBeNull();
      expect(endOfYear!.getMonth()).toBe(11); // December = 11
      expect(endOfYear!.getDate()).toBe(31);
    });

    it('should handle leap year date', () => {
      const leapDay = parseDatetimeLocal('2024-02-29T12:00');
      expect(leapDay).not.toBeNull();
      expect(leapDay!.getMonth()).toBe(1); // February
      expect(leapDay!.getDate()).toBe(29);
    });
  });

  describe('invalid inputs', () => {
    it('should return null for empty string', () => {
      expect(parseDatetimeLocal('')).toBeNull();
    });

    it('should return null for null', () => {
      expect(parseDatetimeLocal(null as unknown as string)).toBeNull();
    });

    it('should return null for undefined', () => {
      expect(parseDatetimeLocal(undefined as unknown as string)).toBeNull();
    });

    it('should return null for non-string types', () => {
      expect(parseDatetimeLocal(12345 as unknown as string)).toBeNull();
      expect(parseDatetimeLocal({} as unknown as string)).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(parseDatetimeLocal('not-a-date')).toBeNull();
      expect(parseDatetimeLocal('2025/01/15 14:30')).toBeNull();
      expect(parseDatetimeLocal('15-01-2025T14:30')).toBeNull();
      expect(parseDatetimeLocal('2025-01-15 14:30')).toBeNull(); // space instead of T
    });

    it('should return null for invalid month', () => {
      expect(parseDatetimeLocal('2025-00-15T14:30')).toBeNull(); // month 0
      expect(parseDatetimeLocal('2025-13-15T14:30')).toBeNull(); // month 13
    });

    it('should return null for invalid day', () => {
      expect(parseDatetimeLocal('2025-01-00T14:30')).toBeNull(); // day 0
      expect(parseDatetimeLocal('2025-01-32T14:30')).toBeNull(); // day 32
    });

    it('should return null for invalid hour', () => {
      expect(parseDatetimeLocal('2025-01-15T24:30')).toBeNull(); // hour 24
      expect(parseDatetimeLocal('2025-01-15T25:30')).toBeNull(); // hour 25
    });

    it('should return null for invalid minute', () => {
      expect(parseDatetimeLocal('2025-01-15T14:60')).toBeNull(); // minute 60
    });

    it('should return null for impossible dates', () => {
      expect(parseDatetimeLocal('2025-02-30T14:30')).toBeNull(); // Feb 30
      expect(parseDatetimeLocal('2025-02-29T14:30')).toBeNull(); // Feb 29 in non-leap year
      expect(parseDatetimeLocal('2025-04-31T14:30')).toBeNull(); // Apr 31
      expect(parseDatetimeLocal('2025-06-31T14:30')).toBeNull(); // Jun 31
      expect(parseDatetimeLocal('2025-09-31T14:30')).toBeNull(); // Sep 31
      expect(parseDatetimeLocal('2025-11-31T14:30')).toBeNull(); // Nov 31
    });
  });

  describe('ISO 8601 fallback', () => {
    it('should parse ISO 8601 with Z suffix', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30:00.000Z');
      expect(result).not.toBeNull();
      // Note: This will be interpreted as UTC, converted to local time
      // We just verify it parses without error
    });

    it('should parse ISO 8601 with timezone offset', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30:00+00:00');
      expect(result).not.toBeNull();
    });

    it('should parse ISO 8601 with negative timezone offset', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30:00-05:00');
      expect(result).not.toBeNull();
    });
  });

  describe('local timezone interpretation', () => {
    it('should interpret datetime-local as local timezone', () => {
      const result = parseDatetimeLocal('2025-01-15T14:30');
      expect(result).not.toBeNull();

      // The date should represent local time, not UTC
      // Create an expected date using local time constructor
      const expected = new Date(2025, 0, 15, 14, 30, 0);
      expect(result!.getTime()).toBe(expected.getTime());
    });

    it('should match Date constructor behavior for local time', () => {
      const dateStr = '2025-06-15T09:45';
      const result = parseDatetimeLocal(dateStr);

      // Our parser should produce the same result as using the multi-arg Date constructor
      const expected = new Date(2025, 5, 15, 9, 45, 0);
      expect(result!.getTime()).toBe(expected.getTime());
    });
  });

  describe('edge cases', () => {
    it('should handle single-digit values with leading zeros', () => {
      const result = parseDatetimeLocal('2025-01-05T09:05');
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(0);
      expect(result!.getDate()).toBe(5);
      expect(result!.getHours()).toBe(9);
      expect(result!.getMinutes()).toBe(5);
    });

    it('should handle dates far in the future', () => {
      const result = parseDatetimeLocal('2099-12-31T23:59');
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2099);
    });

    it('should handle dates in the past', () => {
      const result = parseDatetimeLocal('1990-01-01T00:00');
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(1990);
    });
  });
});

describe('isValidDatetimeLocal', () => {
  it('should return true for valid datetime-local', () => {
    expect(isValidDatetimeLocal('2025-01-15T14:30')).toBe(true);
    expect(isValidDatetimeLocal('2025-01-15T14:30:45')).toBe(true);
  });

  it('should return false for invalid datetime-local', () => {
    expect(isValidDatetimeLocal('')).toBe(false);
    expect(isValidDatetimeLocal('invalid')).toBe(false);
    expect(isValidDatetimeLocal('2025-02-30T14:30')).toBe(false);
  });

  it('should return true for ISO 8601 with timezone', () => {
    expect(isValidDatetimeLocal('2025-01-15T14:30:00Z')).toBe(true);
    expect(isValidDatetimeLocal('2025-01-15T14:30:00+05:00')).toBe(true);
  });
});

describe('parseTstzrange', () => {
  const iso = (r: { start: Date; end: Date } | null) => r && [r.start.toISOString(), r.end.toISOString()];

  it('parses the range EditTimeSlotComponent builds (unquoted ISO, Z suffix)', () => {
    expect(iso(parseTstzrange('[2026-01-06T22:30:00.000Z,2026-01-07T00:30:00.000Z)')))
      .toEqual(['2026-01-06T22:30:00.000Z', '2026-01-07T00:30:00.000Z']);
  });

  it('parses the range PostgREST returns (quoted, space separator, +00 offset)', () => {
    expect(iso(parseTstzrange('["2026-01-06 22:30:00+00","2026-01-06 23:30:00+00")')))
      .toEqual(['2026-01-06T22:30:00.000Z', '2026-01-06T23:30:00.000Z']);
  });

  it('honors non-UTC offsets', () => {
    expect(iso(parseTstzrange('["2026-01-06 17:30:00-05","2026-01-06 18:30:00-05")')))
      .toEqual(['2026-01-06T22:30:00.000Z', '2026-01-06T23:30:00.000Z']);
    expect(iso(parseTstzrange('["2026-01-07 04:00:00+05:30","2026-01-07 05:00:00+05:30")'))?.[0])
      .toBe('2026-01-06T22:30:00.000Z');
  });

  it('returns null for unbounded, zone-less or malformed input', () => {
    expect(parseTstzrange('(,2026-01-06T23:30:00.000Z)')).toBeNull();
    expect(parseTstzrange('[2026-01-06T22:30:00Z,)')).toBeNull();
    expect(parseTstzrange('[2026-01-06T22:30:00,2026-01-06T23:30:00)')).toBeNull();
    expect(parseTstzrange('empty')).toBeNull();
    expect(parseTstzrange('')).toBeNull();
  });
});

describe('toWallClockInTimeZone', () => {
  const instant = new Date('2026-01-06T22:30:00.000Z');

  it('formats the instant as wall-clock time in the given zone, without offset', () => {
    expect(toWallClockInTimeZone(instant, 'America/New_York')).toBe('2026-01-06T17:30:00');
    expect(toWallClockInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-01-07T04:00:00');
    expect(toWallClockInTimeZone(instant, 'UTC')).toBe('2026-01-06T22:30:00');
  });

  it('applies daylight saving time for the date of the instant', () => {
    expect(toWallClockInTimeZone(new Date('2026-07-07T21:30:00.000Z'), 'America/New_York')).toBe('2026-07-07T17:30:00');
  });

  it('renders midnight as 00, not 24', () => {
    expect(toWallClockInTimeZone(new Date('2026-01-07T05:00:00.000Z'), 'America/New_York')).toBe('2026-01-07T00:00:00');
  });

  it('falls back to UTC, like the expansion worker, when the zone is missing or unknown', () => {
    expect(toWallClockInTimeZone(instant)).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, null)).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, '')).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, 'Not/AZone')).toBe('2026-01-06T22:30:00');
  });
});

describe('parseDateOnly', () => {
  it('parses a DATE as local midnight, so it keeps its calendar day in every timezone', () => {
    const date = parseDateOnly('2026-12-07')!;
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 11, 7, 0]);
  });

  it('returns null for non-dates, timestamps and impossible days', () => {
    expect(parseDateOnly('2026-02-30')).toBeNull();
    expect(parseDateOnly('2026-12-07T00:00:00')).toBeNull();
    expect(parseDateOnly('')).toBeNull();
  });
});

describe('dateInTimeZone', () => {
  // 03:30 UTC on Dec 8 is still Dec 7 in New York and already Dec 8 in Kolkata
  const at = new Date('2026-12-08T03:30:00.000Z');

  it('returns the calendar date in the series timezone, not the UTC or browser date', () => {
    expect(dateInTimeZone('America/New_York', at)).toBe('2026-12-07');
    expect(dateInTimeZone('Asia/Kolkata', at)).toBe('2026-12-08');
    expect(dateInTimeZone('Pacific/Auckland', at)).toBe('2026-12-08');
  });

  it('falls back to UTC, like the expansion worker, without a valid timezone', () => {
    expect(dateInTimeZone(null, at)).toBe('2026-12-08');
    expect(dateInTimeZone('Not/AZone', at)).toBe('2026-12-08');
  });

  it('round-trips with parseDateOnly in its own zone', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(dateInTimeZone(tz, parseDateOnly('2027-03-14')!)).toBe('2027-03-14');
  });
});
