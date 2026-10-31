/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSplitSchedule, isIanaTimeZone, parseTstzrange, toWallClockInTimeZone } from './series-schedule.js';
import type { SeriesSchedule } from './series-schedule.js';
import { instantOfWallClock, parseWallClock, wallClockAt } from './zone.js';

/*
 * Every test here runs under UTC, America/New_York, Asia/Kolkata and Australia/Lord_Howe (`test:packages:tz`). The
 * expectations are literal wall-clock strings, so none of them may depend on the host zone: a host-zone `Date`
 * getter in the module under test would fail them in at least one of the four runs.
 */

const iso = (r: { start: Date; end: Date } | null) => r && [r.start.toISOString(), r.end.toISOString()];
const pad = (n: number) => String(n).padStart(2, '0');

describe('parseTstzrange', () => {
  it('parses the range EditTimeSlotComponent builds (unquoted ISO, Z suffix) (ported date.utils 215)', () => {
    expect(iso(parseTstzrange('[2026-01-06T22:30:00.000Z,2026-01-07T00:30:00.000Z)'))).toEqual([
      '2026-01-06T22:30:00.000Z',
      '2026-01-07T00:30:00.000Z',
    ]);
  });

  it('parses the range PostgREST returns (quoted, space separator, +00 offset) (ported date.utils 220)', () => {
    expect(iso(parseTstzrange('["2026-01-06 22:30:00+00","2026-01-06 23:30:00+00")'))).toEqual([
      '2026-01-06T22:30:00.000Z',
      '2026-01-06T23:30:00.000Z',
    ]);
  });

  it('honors non-UTC offsets (ported date.utils 225)', () => {
    expect(iso(parseTstzrange('["2026-01-06 17:30:00-05","2026-01-06 18:30:00-05")'))).toEqual([
      '2026-01-06T22:30:00.000Z',
      '2026-01-06T23:30:00.000Z',
    ]);
    expect(iso(parseTstzrange('["2026-01-07 04:00:00+05:30","2026-01-07 05:00:00+05:30")'))?.[0]).toBe('2026-01-06T22:30:00.000Z');
  });

  it('returns null for unbounded, zone-less or malformed input (ported date.utils 232)', () => {
    expect(parseTstzrange('(,2026-01-06T23:30:00.000Z)')).toBeNull();
    expect(parseTstzrange('[2026-01-06T22:30:00Z,)')).toBeNull();
    expect(parseTstzrange('[2026-01-06T22:30:00,2026-01-06T23:30:00)')).toBeNull();
    expect(parseTstzrange('empty')).toBeNull();
    expect(parseTstzrange('')).toBeNull();
  });

  it('accepts either bracket on either end and spaces around the comma', () => {
    // [a,b], (a,b] and [a, b) are all bounded ranges; the bracket kind is not read.
    expect(iso(parseTstzrange('(2026-01-06T22:30:00Z, 2026-01-06T23:30:00Z]'))).toEqual(['2026-01-06T22:30:00.000Z', '2026-01-06T23:30:00.000Z']);
  });

  it('rejects an impossible calendar instant rather than returning an Invalid Date', () => {
    expect(parseTstzrange('[2026-13-45T22:30:00Z,2026-13-45T23:30:00Z)')).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(parseTstzrange(undefined as unknown as string)).toBeNull();
    expect(parseTstzrange(42 as unknown as string)).toBeNull();
  });
});

describe('isIanaTimeZone', () => {
  it('accepts exact IANA names and aliases the worker and PostgreSQL also accept (ported date.utils 301)', () => {
    expect(isIanaTimeZone('America/New_York')).toBe(true);
    expect(isIanaTimeZone('Asia/Kolkata')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Asia/Calcutta')).toBe(true);
  });

  it('rejects offsets, wrong case and unknown names (the worker would fall back to UTC) (ported date.utils 308)', () => {
    for (const tz of ['+05:30', '-0500', 'UTC+3', 'GMT-5', 'america/new_york', 'est', 'Not/AZone', '', null, undefined]) {
      expect(isIanaTimeZone(tz), String(tz)).toBe(false);
    }
  });

  it('accepts the half-hour DST zone', () => {
    expect(isIanaTimeZone('Australia/Lord_Howe')).toBe(true);
    expect(isIanaTimeZone('Europe/London')).toBe(true);
  });
});

describe('toWallClockInTimeZone', () => {
  const instant = new Date('2026-01-06T22:30:00.000Z');

  it('formats the instant as wall-clock time in the given zone, without offset (ported date.utils 244)', () => {
    expect(toWallClockInTimeZone(instant, 'America/New_York')).toBe('2026-01-06T17:30:00');
    expect(toWallClockInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-01-07T04:00:00');
    expect(toWallClockInTimeZone(instant, 'UTC')).toBe('2026-01-06T22:30:00');
  });

  it('applies daylight saving time for the date of the instant (ported date.utils 250)', () => {
    expect(toWallClockInTimeZone(new Date('2026-07-07T21:30:00.000Z'), 'America/New_York')).toBe('2026-07-07T17:30:00');
  });

  it('renders midnight as 00, not 24 (ported date.utils 254)', () => {
    expect(toWallClockInTimeZone(new Date('2026-01-07T05:00:00.000Z'), 'America/New_York')).toBe('2026-01-07T00:00:00');
  });

  it('falls back to UTC, like the expansion worker, when the zone is missing or unknown (ported date.utils 258)', () => {
    expect(toWallClockInTimeZone(instant)).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, null)).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, '')).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(instant, 'Not/AZone')).toBe('2026-01-06T22:30:00');
  });

  it('makes toWallClockInTimeZone use UTC for a name the worker would not load (ported date.utils 314)', () => {
    const at = new Date('2026-01-06T22:30:00.000Z');
    expect(toWallClockInTimeZone(at, 'america/new_york')).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(at, '+05:30')).toBe('2026-01-06T22:30:00');
  });

  describe('New York across the 2026-11-01 fall-back', () => {
    // DST ends at 06:00Z on 2026-11-01: 02:00 EDT (UTC-4) becomes 01:00 EST (UTC-5), so the wall clock hour
    // 01:00-01:59 occurs twice. 05:30Z = 01:30 EDT (05:30 - 4h); 06:30Z = 01:30 EST (06:30 - 5h).
    it('shows one wall clock for an instant in the EDT hour and for the same wall clock in EST', () => {
      expect(toWallClockInTimeZone(new Date('2026-11-01T05:30:00.000Z'), 'America/New_York')).toBe('2026-11-01T01:30:00');
      expect(toWallClockInTimeZone(new Date('2026-11-01T06:30:00.000Z'), 'America/New_York')).toBe('2026-11-01T01:30:00');
    });

    it('is continuous on either side of the overlap', () => {
      // 04:59:59Z = 00:59:59 EDT; 07:00Z = 02:00 EST (07:00 - 5h).
      expect(toWallClockInTimeZone(new Date('2026-11-01T04:59:59.000Z'), 'America/New_York')).toBe('2026-11-01T00:59:59');
      expect(toWallClockInTimeZone(new Date('2026-11-01T07:00:00.000Z'), 'America/New_York')).toBe('2026-11-01T02:00:00');
    });
  });

  describe('New York across the 2026-03-08 spring-forward', () => {
    // DST starts at 07:00Z: 02:00 EST (UTC-5) becomes 03:00 EDT (UTC-4); 02:00-02:59 never occurs.
    // 06:59Z = 01:59 EST (06:59 - 5h); 07:00Z = 03:00 EDT (07:00 - 4h); 07:30Z = 03:30 EDT.
    it('skips the gap hour', () => {
      expect(toWallClockInTimeZone(new Date('2026-03-08T06:59:00.000Z'), 'America/New_York')).toBe('2026-03-08T01:59:00');
      expect(toWallClockInTimeZone(new Date('2026-03-08T07:00:00.000Z'), 'America/New_York')).toBe('2026-03-08T03:00:00');
      expect(toWallClockInTimeZone(new Date('2026-03-08T07:30:00.000Z'), 'America/New_York')).toBe('2026-03-08T03:30:00');
    });
  });

  describe('half-hour zones', () => {
    it('Kolkata is UTC+5:30 all year', () => {
      // 18:30Z + 5:30 = 24:00 = 00:00 of the next day (never "24:00:00"), in both January and July.
      expect(toWallClockInTimeZone(new Date('2026-06-30T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-07-01T00:00:00');
      expect(toWallClockInTimeZone(new Date('2026-01-14T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-01-15T00:00:00');
      // 12:15Z + 5:30 = 17:45
      expect(toWallClockInTimeZone(new Date('2026-03-10T12:15:00.000Z'), 'Asia/Kolkata')).toBe('2026-03-10T17:45:00');
    });

    it('Lord_Howe is UTC+11 in summer and UTC+10:30 in winter', () => {
      // 2026-01-15T00:00Z + 11h = 11:00 (LHDT); 2026-07-15T00:00Z + 10:30 = 10:30 (LHST).
      expect(toWallClockInTimeZone(new Date('2026-01-15T00:00:00.000Z'), 'Australia/Lord_Howe')).toBe('2026-01-15T11:00:00');
      expect(toWallClockInTimeZone(new Date('2026-07-15T00:00:00.000Z'), 'Australia/Lord_Howe')).toBe('2026-07-15T10:30:00');
    });

    it('Lord_Howe falls back by 30 minutes at 15:00Z on 2026-04-04 (02:00 LHDT becomes 01:30 LHST)', () => {
      // The first Sunday of April 2026 is the 5th. 14:45Z + 11h = 01:45 (LHDT); 15:15Z + 10:30 = 01:45 (LHST): one
      // wall clock, two instants half an hour apart.
      expect(toWallClockInTimeZone(new Date('2026-04-04T14:45:00.000Z'), 'Australia/Lord_Howe')).toBe('2026-04-05T01:45:00');
      expect(toWallClockInTimeZone(new Date('2026-04-04T15:15:00.000Z'), 'Australia/Lord_Howe')).toBe('2026-04-05T01:45:00');
    });
  });

  it('UTC is the identity on the clock', () => {
    expect(toWallClockInTimeZone(new Date('2026-12-31T23:59:59.000Z'), 'UTC')).toBe('2026-12-31T23:59:59');
  });

  it('treats an offset or a wrong-case name as UTC, not as the zone Intl would resolve', () => {
    const at = new Date('2026-01-06T22:30:00.000Z');
    // '+05:30' would read 04:00 and 'america/new_york' 17:30 if Intl's leniency were used.
    expect(toWallClockInTimeZone(at, '+05:30')).toBe('2026-01-06T22:30:00');
    expect(toWallClockInTimeZone(at, 'america/new_york')).toBe('2026-01-06T22:30:00');
  });
});

describe('buildSplitSchedule', () => {
  const NY: SeriesSchedule = { timezone: 'America/New_York', dtstart: '2026-01-06T17:30:00', time_slot_property: 'time_slot' };

  it('gives the edited start as wall-clock time in the series zone, and the edited length in seconds', () => {
    // 23:30Z on 2026-01-13 is 18:30 EST (23:30 - 5h); the range is one hour long.
    expect(buildSplitSchedule('[2026-01-13T23:30:00.000Z,2026-01-14T00:30:00.000Z)', '2026-01-13', NY)).toEqual({
      dtstart: '2026-01-13T18:30:00',
      duration: '3600 seconds',
    });
  });

  it('reads the PostgREST range shape', () => {
    expect(buildSplitSchedule('["2026-01-13 22:30:00+00","2026-01-14 00:30:00+00")', '2026-01-13', NY)).toEqual({
      dtstart: '2026-01-13T17:30:00',
      duration: '7200 seconds',
    });
  });

  it('uses the series zone, not the zone the range was written in', () => {
    // 22:30Z = 04:00 next day in Kolkata (+5:30).
    expect(buildSplitSchedule('[2026-01-13T22:30:00.000Z,2026-01-13T23:30:00.000Z)', '2026-01-13', { ...NY, timezone: 'Asia/Kolkata' }).dtstart).toBe(
      '2026-01-14T04:00:00',
    );
  });

  it('uses UTC for a null zone and for a name that is not IANA', () => {
    const slot = '[2026-01-13T22:30:00.000Z,2026-01-13T23:30:00.000Z)';
    expect(buildSplitSchedule(slot, '2026-01-13', { ...NY, timezone: null }).dtstart).toBe('2026-01-13T22:30:00');
    expect(buildSplitSchedule(slot, '2026-01-13', { ...NY, timezone: '+05:30' }).dtstart).toBe('2026-01-13T22:30:00');
    expect(buildSplitSchedule(slot, '2026-01-13', { ...NY, timezone: 'america/new_york' }).dtstart).toBe('2026-01-13T22:30:00');
  });

  it('keeps the wall clock across the fall-back: an EDT-hour instant and the same wall clock in EST', () => {
    // 05:30Z = 01:30 EDT and 06:30Z = 01:30 EST, both 2026-11-01T01:30:00.
    expect(buildSplitSchedule('[2026-11-01T05:30:00.000Z,2026-11-01T06:30:00.000Z)', '2026-11-01', NY).dtstart).toBe('2026-11-01T01:30:00');
    expect(buildSplitSchedule('[2026-11-01T06:30:00.000Z,2026-11-01T07:30:00.000Z)', '2026-11-01', NY).dtstart).toBe('2026-11-01T01:30:00');
  });

  it('keeps the wall clock across the spring-forward', () => {
    // 06:59Z = 01:59 EST; 07:30Z = 03:30 EDT.
    expect(buildSplitSchedule('[2026-03-08T06:59:00.000Z,2026-03-08T08:00:00.000Z)', '2026-03-08', NY).dtstart).toBe('2026-03-08T01:59:00');
    expect(buildSplitSchedule('[2026-03-08T07:30:00.000Z,2026-03-08T08:30:00.000Z)', '2026-03-08', NY).dtstart).toBe('2026-03-08T03:30:00');
  });

  it('Kolkata half hour and Lord_Howe half-hour DST', () => {
    // 2026-03-10T12:15Z + 5:30 = 17:45.
    expect(buildSplitSchedule('[2026-03-10T12:15:00.000Z,2026-03-10T13:15:00.000Z)', '2026-03-10', { ...NY, timezone: 'Asia/Kolkata' }).dtstart).toBe(
      '2026-03-10T17:45:00',
    );
    // 2026-07-15T00:00Z + 10:30 = 10:30 (LHST); 2026-01-15T00:00Z + 11 = 11:00 (LHDT).
    const lh = { ...NY, timezone: 'Australia/Lord_Howe' };
    expect(buildSplitSchedule('[2026-07-15T00:00:00.000Z,2026-07-15T01:00:00.000Z)', '2026-07-15', lh).dtstart).toBe('2026-07-15T10:30:00');
    expect(buildSplitSchedule('[2026-01-15T00:00:00.000Z,2026-01-15T01:00:00.000Z)', '2026-01-15', lh).dtstart).toBe('2026-01-15T11:00:00');
  });

  it('gives no duration for an empty or reversed range', () => {
    // start == end is 0 seconds, end before start is negative: neither is a positive length.
    expect(buildSplitSchedule('[2026-01-13T23:30:00.000Z,2026-01-13T23:30:00.000Z)', '2026-01-13', NY).duration).toBeUndefined();
    expect(buildSplitSchedule('[2026-01-14T00:30:00.000Z,2026-01-13T23:30:00.000Z)', '2026-01-13', NY).duration).toBeUndefined();
    expect(buildSplitSchedule('[2026-01-13T23:30:00.000Z,2026-01-13T23:30:00.000Z)', '2026-01-13', NY).dtstart).toBe('2026-01-13T18:30:00');
  });

  it('rounds a sub-second length to whole seconds', () => {
    // 1.5 s rounds to 2 s; 0.4 s rounds to 0, which is not positive.
    expect(buildSplitSchedule('[2026-01-13T23:30:00.000Z,2026-01-13T23:30:01.500Z)', '2026-01-13', NY).duration).toBe('2 seconds');
    expect(buildSplitSchedule('[2026-01-13T23:30:00.000Z,2026-01-13T23:30:00.400Z)', '2026-01-13', NY).duration).toBeUndefined();
  });

  describe('without a usable time slot: the series time of day on the split date', () => {
    it('reads a T separator', () => {
      expect(buildSplitSchedule(undefined, '2026-01-13', NY)).toEqual({ dtstart: '2026-01-13T17:30:00' });
    });

    it('reads a space separator', () => {
      expect(buildSplitSchedule(null, '2026-01-13', { ...NY, dtstart: '2026-01-06 09:15:30' })).toEqual({ dtstart: '2026-01-13T09:15:30' });
    });

    it('pads HH:MM to HH:MM:00', () => {
      expect(buildSplitSchedule('', '2026-01-13', { ...NY, dtstart: '2026-01-06T09:15' })).toEqual({ dtstart: '2026-01-13T09:15:00' });
    });

    it('falls back to T00:00:00 when the series dtstart has no time of day', () => {
      expect(buildSplitSchedule(undefined, '2026-01-13', { ...NY, dtstart: '2026-01-06' })).toEqual({ dtstart: '2026-01-13T00:00:00' });
      expect(buildSplitSchedule(undefined, '2026-01-13', { ...NY, dtstart: '' })).toEqual({ dtstart: '2026-01-13T00:00:00' });
    });

    it('also applies to a time slot that is not a bounded range with zones', () => {
      expect(buildSplitSchedule('[2026-01-13T23:30:00,2026-01-14T00:30:00)', '2026-01-13', NY)).toEqual({ dtstart: '2026-01-13T17:30:00' });
      expect(buildSplitSchedule('empty', '2026-01-13', NY)).toEqual({ dtstart: '2026-01-13T17:30:00' });
    });

    it('ignores the series zone: the time of day is not converted', () => {
      expect(buildSplitSchedule(undefined, '2026-01-13', { ...NY, timezone: 'Asia/Kolkata' })).toEqual({ dtstart: '2026-01-13T17:30:00' });
    });
  });
});

// The series split sends `dtstart` to a `timestamp` column, so what matters is the clock reading in the series zone.
// This must hold whatever the host zone is: `test:packages:tz` runs it under UTC, America/New_York, Asia/Kolkata and
// Australia/Lord_Howe, and a host-zone `Date` getter anywhere in the builder fails it in at least one of them.
describe('buildSplitSchedule: the dtstart is the start instant read as wall-clock time in the series zone', () => {
  const ZONES: (string | null)[] = ['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/London', 'UTC', null];
  const MIN = Date.UTC(2000, 0, 1) / 1000;
  const MAX = Date.UTC(2040, 11, 31) / 1000;

  const isoShape = (ms: number) => new Date(ms).toISOString();
  const postgrestShape = (ms: number) => {
    const d = new Date(ms);
    return `"${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00"`;
  };

  it('has no offset, equals the zone clock of the start, and reads back to the start (or its fall-back twin)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN, max: MAX }),
        fc.integer({ min: 1, max: 3 * 24 * 3600 }),
        fc.constantFrom(...ZONES),
        fc.constantFrom('iso', 'postgrest'),
        (startSec, lengthSec, zone, shape) => {
          const startMs = startSec * 1000;
          const endMs = (startSec + lengthSec) * 1000;
          const fmt = shape === 'iso' ? isoShape : postgrestShape;
          const range = `[${fmt(startMs)},${fmt(endMs)})`;
          const out = buildSplitSchedule(range, '2026-01-01', { timezone: zone, dtstart: '2026-01-01T00:00:00', time_slot_property: 'time_slot' });

          // (a) a bare wall clock: no offset, no Z
          expect(out.dtstart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
          // (b) the zone's clock at the start, with seconds ('UTC' for a null zone)
          const w = wallClockAt(zone ?? 'UTC', startMs);
          expect(out.dtstart).toBe(`${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`);
          // (c) read back as wall-clock time in the zone: the start, or an instant with the same wall clock (an overlap)
          const parsed = parseWallClock(out.dtstart)!;
          expect(parsed).not.toBeNull();
          const back = instantOfWallClock(zone ?? 'UTC', parsed);
          if (back !== startMs) expect(wallClockAt(zone ?? 'UTC', back)).toEqual(w);
          // the length survives as whole seconds
          expect(out.duration).toBe(`${lengthSec} seconds`);
        },
      ),
      { numRuns: 400 },
    );
  });
});
