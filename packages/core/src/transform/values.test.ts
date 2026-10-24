/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for untyped form values and raw PostgREST values. */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EntityPropertyType } from '../model/entity.js';
import { parseDatetimeLocal } from './datetime-local.js';
import {
  normalizeValuesForApi,
  parseMoneyOutput,
  transformValueForControl as coreTransformValueForControl,
  transformValuesForApi as coreTransformValuesForApi,
  ValueTransformError,
  type TransformProp,
  type TransformValuesOptions,
} from './values.js';
import { parseWallClock } from './zone.js';

/** The zone the test process runs in; the TZ matrix (scripts/test-packages-tz.mjs) varies it. */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Unless a test names a zone, the transforms run in the host zone, where the host `Date`
// constructor (the oracle below) and the explicit-zone arithmetic must agree.
const transformValueForControl = (prop: TransformProp, raw: any, timeZone = HOST_ZONE) =>
  coreTransformValueForControl(prop, raw, { timeZone });
const transformValuesForApi = (
  values: any,
  props: readonly TransformProp[],
  options: Omit<TransformValuesOptions, 'timeZone'> & { timeZone?: string }
) => coreTransformValuesForApi(values, props, { timeZone: HOST_ZONE, ...options });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as any)[key]);
  }
  return value;
}

/** Deep copy of plain data (keeps undefined-valued keys, unlike JSON). */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const out: any = {};
  for (const key of Object.keys(value as object)) out[key] = clone((value as any)[key]);
  return out;
}

const prop = (column_name: string, type: EntityPropertyType): TransformProp =>
  deepFreeze({ column_name, type });

const T = EntityPropertyType;

/** Pad to the shape a datetime-local control holds. */
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

describe('parseDatetimeLocal', () => {
  it('parses a 16-char datetime-local string as local wall-clock time', () => {
    const d = parseDatetimeLocal('2025-01-15T14:30')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2025, 0, 15, 14, 30]);
  });

  it('accepts seconds', () => {
    expect(parseDatetimeLocal('2025-01-15T14:30:45')!.getSeconds()).toBe(45);
  });

  it('returns null for empty, non-string and malformed input', () => {
    expect(parseDatetimeLocal('')).toBeNull();
    expect(parseDatetimeLocal(null as any)).toBeNull();
    expect(parseDatetimeLocal(12345 as any)).toBeNull();
    expect(parseDatetimeLocal('2025-01-15 14:30')).toBeNull();
    expect(parseDatetimeLocal('2025-13-15T14:30')).toBeNull();
    expect(parseDatetimeLocal('2025-01-15T24:30')).toBeNull();
    expect(parseDatetimeLocal('2025-02-30T14:30')).toBeNull();
  });

  it('falls back to native parsing only for ISO strings with an explicit zone', () => {
    expect(parseDatetimeLocal('2025-01-15T14:30:00.000Z')!.toISOString()).toBe('2025-01-15T14:30:00.000Z');
    expect(parseDatetimeLocal('2025-01-15T14:30:00-05:00')!.toISOString()).toBe('2025-01-15T19:30:00.000Z');
    expect(parseDatetimeLocal('2025-99-99T14:30:00Z')).toBeNull();
  });
});

describe('transformValueForControl', () => {
  it('passes null and undefined through', () => {
    expect(transformValueForControl(prop('a', T.DateTime), null)).toBeNull();
    expect(transformValueForControl(prop('a', T.DateTime), undefined)).toBeUndefined();
  });

  it('DateTime: truncates to 16 characters without zone conversion', () => {
    expect(transformValueForControl(prop('a', T.DateTime), '2025-01-15T10:30:00')).toBe('2025-01-15T10:30');
    expect(transformValueForControl(prop('a', T.DateTime), '2025-01-15T10:30:00+05:00')).toBe('2025-01-15T10:30');
    expect(transformValueForControl(prop('a', T.DateTime), '2025')).toBe('2025');
  });

  it('DateTime: non-string values pass through', () => {
    expect(transformValueForControl(prop('a', T.DateTime), 5)).toBe(5);
  });

  it('DateTimeLocal: formats the instant with local getters', () => {
    const raw = '2025-01-15T10:30:00.000Z';
    const d = new Date(raw);
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(transformValueForControl(prop('a', T.DateTimeLocal), raw)).toBe(expected);
  });

  it('F-03: an invalid DateTimeLocal control value becomes empty, not NaN', () => {
    const p = prop('a', T.DateTimeLocal);
    for (const bad of ['nope', '', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-07-04T25:00:00Z', 'Invalid Date']) {
      expect(transformValueForControl(p, bad)).toBe('');
    }
    expect(transformValueForControl(p, '2026-07-04T10:00:00Z')).not.toContain('NaN');
  });

  it('F-10: explicit parse rules for offsets, offset-less values and bare dates, in any host zone', () => {
    const p = prop('a', T.DateTimeLocal);
    // An offset makes an instant, shown in the given zone (hand-derived offsets for 2026).
    expect(transformValueForControl(p, '2026-07-04T14:30:00Z', 'America/New_York')).toBe('2026-07-04T10:30');
    expect(transformValueForControl(p, '2026-07-04T14:30:00+00:00', 'America/New_York')).toBe('2026-07-04T10:30');
    expect(transformValueForControl(p, '2026-01-15T15:30:00.000Z', 'America/New_York')).toBe('2026-01-15T10:30');
    expect(transformValueForControl(p, '2026-07-04T10:30:00-04:00', 'Asia/Kolkata')).toBe('2026-07-04T20:00');
    expect(transformValueForControl(p, '2026-07-04T10:30:00-0400', 'UTC')).toBe('2026-07-04T14:30');
    expect(transformValueForControl(p, '2026-07-04T10:30:00-04', 'UTC')).toBe('2026-07-04T14:30');
    expect(transformValueForControl(p, '2026-01-15T00:00:00Z', 'Australia/Lord_Howe')).toBe('2026-01-15T11:00');
    expect(transformValueForControl(p, '2026-07-15T00:00:00Z', 'Australia/Lord_Howe')).toBe('2026-07-15T10:30');
    // A space instead of T (PostgreSQL text output) is the same instant.
    expect(transformValueForControl(p, '2026-07-04 14:30:00+00', 'America/New_York')).toBe('2026-07-04T10:30');
    // No offset: wall-clock in the viewer's zone, shown as written, never read as UTC.
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      expect(transformValueForControl(p, '2026-07-04T17:30:00', zone)).toBe('2026-07-04T17:30');
      expect(transformValueForControl(p, '2026-07-04T17:30', zone)).toBe('2026-07-04T17:30');
    }
    // A bare date is that day's midnight in the viewer's zone, never the evening before.
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'UTC', 'Australia/Lord_Howe']) {
      expect(transformValueForControl(p, '2026-07-04', zone)).toBe('2026-07-04T00:00');
    }
    // A date with an offset but no time, and text around the value, are rejected.
    expect(transformValueForControl(p, '2026-07-04Z')).toBe('');
    expect(transformValueForControl(p, ' 2026-07-04T10:30:00Z')).toBe('');
  });

  it('F-11: money output is parsed by explicit rules; anything else is rejected', () => {
    const m = prop('a', T.Money);
    expect(transformValueForControl(m, '$1,234.50')).toBe(1234.5);
    expect(transformValueForControl(m, '$100.00')).toBe(100);
    expect(transformValueForControl(m, '-$1,234.50')).toBe(-1234.5);
    expect(transformValueForControl(m, '$-1,234.50')).toBe(-1234.5);
    expect(transformValueForControl(m, '($1,234.50)')).toBe(-1234.5);
    expect(transformValueForControl(m, '(1.00)')).toBe(-1);
    expect(transformValueForControl(m, '1234.5')).toBe(1234.5);
    expect(transformValueForControl(m, '$0.00')).toBe(0);
    expect(Object.is(transformValueForControl(m, '-$0.00'), 0)).toBe(true);
    for (const bad of ['$1,2,3', '€10.00', 'abc', '', '$', '1,23', '12,3456', '$1.2.3', '--1', '(-1.00)', '$1e3', '2025-01-15T10:3']) {
      expect(transformValueForControl(m, bad), bad).toBeNull();
    }
    expect(parseMoneyOutput('$1,234.50')).toBe(1234.5);
    expect(parseMoneyOutput('abc')).toBeNull();
    expect(transformValueForControl(m, 7)).toBe(7);
  });

  it('Money: strips $ and commas', () => {
    expect(transformValueForControl(prop('a', T.Money), '$1,234.50')).toBe(1234.5);
  });

  it('other types pass through', () => {
    const obj = deepFreeze({ id: 1 });
    expect(transformValueForControl(prop('a', T.TextShort), obj)).toBe(obj);
    expect(transformValueForControl(prop('a', T.TextShort), '')).toBe('');
  });
});

describe('transformValuesForApi', () => {
  const both = ['create', 'edit'] as const;

  describe.each(both)('mode %s', mode => {
    const run = (values: any, props: TransformProp[]) =>
      transformValuesForApi(deepFreeze(values), props, { mode });

    it('does not mutate its input and returns a new object', () => {
      const values = deepFreeze({ s: '2025-01-15T10:30', created_at: 'x' });
      const out = transformValuesForApi(values, [prop('s', T.DateTime)], { mode });
      expect(out).not.toBe(values);
      expect(values).toEqual({ s: '2025-01-15T10:30', created_at: 'x' });
    });

    it('DateTime: appends :00 to a valid 16-character value, keeps a valid 19-character one, passes other lengths through', () => {
      const p = [prop('s', T.DateTime)];
      expect(run({ s: '2025-01-15T10:30' }, p).s).toBe('2025-01-15T10:30:00');
      expect(run({ s: '2025-01-15T10:3' }, p).s).toBe('2025-01-15T10:3');
      expect(run({ s: '2025-01-15T10:30:00' }, p).s).toBe('2025-01-15T10:30:00');
      expect(run({ s: '2025-01-15T10:30:0' }, p).s).toBe('2025-01-15T10:30:0');
      expect(run({ s: '' }, p).s).toBe('');
    });

    it('F-08: DateTime validates before appending :00', () => {
      const p = [prop('s', T.DateTime)];
      for (const bad of ['2026-02-30T10:00', 'abcdefghijklmnop', '2026-13-01T10:00', '2026-07-04T24:00', '2026-07-04T10:60', '2026-07-04 10:30', '2026-07-04T10:30:60']) {
        expect(() => run({ s: bad }, p), bad).toThrow(ValueTransformError);
      }
      const err = (() => { try { run({ s: '2026-02-30T10:00' }, p); } catch (e) { return e as ValueTransformError; } return null; })();
      expect(err).toMatchObject({ column: 's', reason: 'invalid_datetime', value: '2026-02-30T10:00' });
      expect(err!.message).toContain('2026-02-30T10:00');
      // 2028 is a leap year, 2100 is not
      expect(run({ s: '2028-02-29T10:00' }, p).s).toBe('2028-02-29T10:00:00');
      expect(() => run({ s: '2100-02-29T10:00' }, p)).toThrow(ValueTransformError);
    });

    it('F-06: DateTime and DateTimeLocal handle 19-character values (with seconds)', () => {
      expect(run({ s: '2026-07-04T10:30:15' }, [prop('s', T.DateTime)]).s).toBe('2026-07-04T10:30:15');
      expect(
        transformValuesForApi({ s: '2026-07-04T10:30:15' }, [prop('s', T.DateTimeLocal)], { mode, timeZone: 'America/New_York' }).s
      ).toBe('2026-07-04T14:30:15.000Z');
      expect(
        transformValuesForApi({ s: '2026-07-04T10:30:00' }, [prop('s', T.DateTimeLocal)], { mode, timeZone: 'Asia/Kolkata' }).s
      ).toBe('2026-07-04T05:00:00.000Z');
      expect(() => run({ s: '2026-07-04T10:30:75' }, [prop('s', T.DateTimeLocal)])).toThrow(ValueTransformError);
    });

    it('DateTime: non-strings are untouched', () => {
      const d = deepFreeze({ x: 1 });
      expect(run({ s: d }, [prop('s', T.DateTime)]).s).toBe(d);
      expect(run({ s: 16 }, [prop('s', T.DateTime)]).s).toBe(16);
    });

    it('DateTimeLocal: converts local wall-clock time to a UTC ISO string', () => {
      const out = run({ s: '2025-01-15T17:30' }, [prop('s', T.DateTimeLocal)]).s;
      expect(out).toBe(new Date(2025, 0, 15, 17, 30).toISOString());
    });

    it('DateTimeLocal: converts in the explicit zone, whatever the host zone is (hand-derived 2026 offsets)', () => {
      const p = [prop('s', T.DateTimeLocal)];
      const at = (s: string, timeZone: string) => transformValuesForApi({ s }, p, { mode, timeZone }).s;
      expect(at('2026-07-04T10:30', 'America/New_York')).toBe('2026-07-04T14:30:00.000Z'); // EDT -4
      expect(at('2026-01-15T10:30', 'America/New_York')).toBe('2026-01-15T15:30:00.000Z'); // EST -5
      expect(at('2026-07-04T10:30', 'Asia/Kolkata')).toBe('2026-07-04T05:00:00.000Z'); // +5:30
      expect(at('2026-07-04T10:30', 'UTC')).toBe('2026-07-04T10:30:00.000Z');
      expect(at('2026-01-15T12:00', 'Australia/Lord_Howe')).toBe('2026-01-15T01:00:00.000Z'); // +11
      expect(at('2026-07-15T12:00', 'Australia/Lord_Howe')).toBe('2026-07-15T01:30:00.000Z'); // +10:30
    });

    it('F-05: a local time in the spring-forward gap shifts forward (02:30 becomes 03:30 EDT), as PostgreSQL resolves it', () => {
      const p = [prop('s', T.DateTimeLocal)];
      const at = (s: string, timeZone: string) => transformValuesForApi({ s }, p, { mode, timeZone }).s;
      // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT. 02:30 does not exist; it is 07:30Z = 03:30 EDT.
      expect(at('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
      expect(at('2026-03-08T02:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
      expect(at('2026-03-08T01:59', 'America/New_York')).toBe('2026-03-08T06:59:00.000Z');
      expect(at('2026-03-08T03:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
      // Lord Howe, 2026-10-04: 02:00 (+10:30) jumps to 02:30 (+11), a half-hour gap. 02:15 does not exist
      // and shifts forward by the gap to 02:45 at +11 (15:45Z the day before).
      expect(at('2026-10-04T02:15', 'Australia/Lord_Howe')).toBe('2026-10-03T15:45:00.000Z'); // 02:15 -> 02:45 at +11
      // Fall-back overlap: the earlier (EDT) occurrence of 01:30 on 2026-11-01.
      expect(at('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
      // Asia/Kolkata has no transitions.
      expect(at('2026-03-08T02:30', 'Asia/Kolkata')).toBe('2026-03-07T21:00:00.000Z');
    });

    it('F-09: an invalid local time is rejected with a ValueTransformError, not sent as written', () => {
      const p = [prop('s', T.DateTimeLocal)];
      for (const bad of ['2026-02-30T10:00', '2026-07-04T24:00', '2026-13-01T10:00', 'abcdefghijklmnop', '2026-07-04 10:30']) {
        expect(() => run({ s: bad }, p), bad).toThrow(ValueTransformError);
      }
      const err = (() => { try { run({ s: '2026-13-01T10:00' }, p); } catch (e) { return e as ValueTransformError; } return null; })();
      expect(err).toMatchObject({ name: 'ValueTransformError', column: 's', reason: 'invalid_datetime', value: '2026-13-01T10:00' });
    });

    it('DateTimeLocal: other lengths (an offset-bearing ISO value, short text) are passed through', () => {
      const p = [prop('s', T.DateTimeLocal)];
      expect(run({ s: '2025-01-15T17:30:00.000Z' }, p).s).toBe('2025-01-15T17:30:00.000Z');
      expect(run({ s: '2025-01-15T17:3' }, p).s).toBe('2025-01-15T17:3');
      expect(run({ s: '' }, p).s).toBe('');
    });

    it('null and undefined values are skipped before every branch, and keys are kept', () => {
      const p = [prop('a', T.DateTime), prop('b', T.DateTimeLocal), prop('c', T.File), prop('d', T.File)];
      const out = run({ a: null, b: undefined, c: null, d: undefined }, p);
      expect(out).toEqual({ a: null, b: undefined, c: null, d: undefined });
      expect(Object.keys(out)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('other types are untouched', () => {
      expect(run({ n: '', m: 5 }, [prop('n', T.TextShort), prop('m', T.Money)])).toEqual({ n: '', m: 5 });
    });

    it('audit columns are dropped unless a property owns them', () => {
      const v = { created_at: 'c', updated_at: 'u', x: 1 };
      expect(run(v, [prop('x', T.IntegerNumber)])).toEqual({ x: 1 });
      expect(run(v, [prop('created_at', T.DateTimeLocal)])).toEqual({ created_at: 'c', x: 1 });
      expect(run(v, [prop('updated_at', T.TextShort)])).toEqual({ updated_at: 'u', x: 1 });
      expect(run(v, [prop('created_at', T.TextShort), prop('updated_at', T.TextShort)])).toEqual(v);
    });

    it('fields without a property pass through', () => {
      expect(run({ extra: '2025-01-15T10:30' }, [])).toEqual({ extra: '2025-01-15T10:30' });
    });
  });

  describe('edit mode', () => {
    const run = (values: any, props: TransformProp[]) =>
      transformValuesForApi(deepFreeze(values), props, { mode: 'edit' });

    it.each([T.File, T.FileImage, T.FilePDF])('type %s: object with truthy id becomes the id', type => {
      expect(run({ f: { id: 'u-1', name: 'x' } }, [prop('f', type)]).f).toBe('u-1');
    });

    it('file: string, object without id, and object with falsy id are kept', () => {
      const p = [prop('f', T.File)];
      expect(run({ f: 'u-1' }, p).f).toBe('u-1');
      const noId = { name: 'x' };
      expect(run({ f: noId }, p).f).toBe(noId);
      const zero = { id: 0 };
      expect(run({ f: zero }, p).f).toBe(zero);
      const empty = { id: '' };
      expect(run({ f: empty }, p).f).toBe(empty);
    });

    it('PhotoGallery: object with truthy id becomes the id, otherwise kept', () => {
      const p = [prop('g', T.PhotoGallery)];
      expect(run({ g: { id: 'g-1', images: [] } }, p).g).toBe('g-1');
      expect(run({ g: 'g-1' }, p).g).toBe('g-1');
      const noId = { images: [] };
      expect(run({ g: noId }, p).g).toBe(noId);
    });
  });

  describe('create mode', () => {
    const run = (values: any, props: TransformProp[]) =>
      transformValuesForApi(deepFreeze(values), props, { mode: 'create' });

    it('file values are passed through untouched', () => {
      const obj = { id: 'u-1' };
      expect(run({ f: obj }, [prop('f', T.File)]).f).toBe(obj);
    });

    it('PhotoGallery key is deleted when it has a value', () => {
      const out = run({ g: { id: 'g-1' }, k: 1 }, [prop('g', T.PhotoGallery)]);
      expect('g' in out).toBe(false);
      expect(out.k).toBe(1);
    });

    it('F-12: the PhotoGallery key is omitted whatever its value, null and undefined included', () => {
      const p = [prop('g', T.PhotoGallery)];
      expect('g' in run({ g: '' }, p)).toBe(false);
      expect('g' in run({ g: 0 }, p)).toBe(false);
      expect('g' in run({ g: null }, p)).toBe(false);
      expect('g' in run({ g: undefined }, p)).toBe(false);
      expect('g' in run({}, p)).toBe(false);
      // Edit mode does not omit it: a null gallery there is a deliberate clear.
      const edit = transformValuesForApi(deepFreeze({ g: null }), p, { mode: 'edit' });
      expect(edit).toEqual({ g: null });
    });
  });
});

describe('round trips', () => {
  const localParts = fc.record({
    y: fc.integer({ min: 1990, max: 2060 }),
    mo: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
    h: fc.integer({ min: 0, max: 23 }),
    mi: fc.integer({ min: 0, max: 59 }),
  });
  const fmt = (p: { y: number; mo: number; d: number; h: number; mi: number }) =>
    `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;

  it('DateTimeLocal: control -> API -> control returns the original wall-clock string', () => {
    const p = prop('t', T.DateTimeLocal);
    fc.assert(
      fc.property(localParts, parts => {
        const s = fmt(parts);
        // Skip wall-clock times that do not exist in this TZ (DST gap)
        const parsed = parseDatetimeLocal(s)!;
        fc.pre(
          parsed.getFullYear() === parts.y && parsed.getMonth() === parts.mo - 1 &&
          parsed.getDate() === parts.d && parsed.getHours() === parts.h && parsed.getMinutes() === parts.mi
        );
        const api = transformValuesForApi({ t: s }, [p], { mode: 'edit' });
        expect(transformValueForControl(p, api.t)).toBe(s);
      }),
      { numRuns: 2000 }
    );
  });

  it('DateTimeLocal: control -> API -> control round-trips in every explicit zone, outside gaps', () => {
    const p = prop('t', T.DateTimeLocal);
    for (const timeZone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
      fc.assert(
        fc.property(localParts, parts => {
          const s = fmt(parts);
          const api = transformValuesForApi({ t: s }, [p], { mode: 'edit', timeZone });
          const back = transformValueForControl(p, api.t, timeZone);
          // Gap times come back shifted forward by the gap, never anywhere else; everything else is exact.
          if (back !== s) {
            const shifted = new Date(api.t);
            expect(isNaN(shifted.getTime())).toBe(false);
            expect(transformValuesForApi({ t: back }, [p], { mode: 'edit', timeZone }).t).toBe(api.t);
          }
        }),
        { numRuns: 400 }
      );
    }
  });

  it('DateTime: API -> control returns the original string', () => {
    const p = prop('t', T.DateTime);
    fc.assert(
      fc.property(localParts, parts => {
        const s = fmt(parts);
        for (const mode of ['create', 'edit'] as const) {
          const api = transformValuesForApi({ t: s }, [p], { mode });
          expect(api.t).toBe(s + ':00');
          expect(transformValueForControl(p, api.t)).toBe(s);
        }
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// Oracle: verbatim copies of the page methods as they stood before the move
// (create.page.ts transformValuesForApi, edit.page.ts transformValuesForApi and
// transformValueForControl), with `this.currentProps` turned into a parameter.
// ---------------------------------------------------------------------------

function oracleCreate(currentProps: TransformProp[], formData: any): any {
  const transformed = { ...formData };
  currentProps.forEach(prop => {
    const value = transformed[prop.column_name];
    if (value === null || value === undefined) return;
    if (prop.type === EntityPropertyType.DateTime) {
      if (typeof value === 'string') {
        if (value.length === 16) {
          transformed[prop.column_name] = value + ':00';
        }
      }
    }
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof value === 'string') {
        if (value.length === 16) {
          const localDate = parseDatetimeLocal(value);
          if (localDate) {
            const utcISO = localDate.toISOString();
            transformed[prop.column_name] = utcISO;
          }
        }
      }
    }
    if (prop.type === EntityPropertyType.PhotoGallery) {
      delete transformed[prop.column_name];
    }
  });
  const editableColumns = new Set(currentProps.map(p => p.column_name));
  if (!editableColumns.has('created_at')) {
    delete transformed.created_at;
  }
  if (!editableColumns.has('updated_at')) {
    delete transformed.updated_at;
  }
  return transformed;
}

function oracleEdit(currentProps: TransformProp[], formData: any): any {
  const transformed = { ...formData };
  currentProps.forEach(prop => {
    const value = transformed[prop.column_name];
    if (value === null || value === undefined) return;
    if ([EntityPropertyType.File, EntityPropertyType.FileImage, EntityPropertyType.FilePDF].includes(prop.type)) {
      if (typeof value === 'object' && value.id) {
        transformed[prop.column_name] = value.id;
      }
    }
    if (prop.type === EntityPropertyType.PhotoGallery) {
      if (typeof value === 'object' && value.id) {
        transformed[prop.column_name] = value.id;
      }
    }
    if (prop.type === EntityPropertyType.DateTime) {
      if (typeof value === 'string') {
        if (value.length === 16) {
          transformed[prop.column_name] = value + ':00';
        }
      }
    }
    if (prop.type === EntityPropertyType.DateTimeLocal) {
      if (typeof value === 'string') {
        if (value.length === 16) {
          const localDate = parseDatetimeLocal(value);
          if (localDate) {
            const utcISO = localDate.toISOString();
            transformed[prop.column_name] = utcISO;
          }
        }
      }
    }
  });
  const editableColumns = new Set(currentProps.map(p => p.column_name));
  if (!editableColumns.has('created_at')) {
    delete transformed.created_at;
  }
  if (!editableColumns.has('updated_at')) {
    delete transformed.updated_at;
  }
  return transformed;
}

function oracleControl(prop: TransformProp, rawValue: any): any {
  // Verbatim pre-move body follows. Rows that changed it on purpose (F-03, F-10, F-11) are excluded
  // from the comparison by the properties below and pinned by their own tests above.
  if (rawValue === null || rawValue === undefined) return rawValue;
  if (prop.type === EntityPropertyType.DateTime) {
    if (typeof rawValue === 'string') {
      return rawValue.substring(0, 16);
    }
  }
  if (prop.type === EntityPropertyType.DateTimeLocal) {
    if (typeof rawValue === 'string') {
      const utcDate = new Date(rawValue);
      const year = utcDate.getFullYear();
      const month = String(utcDate.getMonth() + 1).padStart(2, '0');
      const day = String(utcDate.getDate()).padStart(2, '0');
      const hours = String(utcDate.getHours()).padStart(2, '0');
      const minutes = String(utcDate.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    }
  }
  if (prop.type === EntityPropertyType.Money) {
    if (typeof rawValue === 'string') {
      const numericValue = parseFloat(rawValue.replace(/[$,]/g, ''));
      if (!isNaN(numericValue)) {
        return numericValue;
      }
    }
  }
  return rawValue;
}

describe('oracle: core agrees with the pre-move page methods wherever no ledger row changed the behavior', () => {
  const types = [
    T.TextShort, T.DateTime, T.DateTimeLocal, T.Money, T.File, T.FileImage, T.FilePDF,
    T.PhotoGallery, T.IntegerNumber, T.Boolean,
  ];
  const columns = ['a', 'b', 'c', 'd', 'created_at', 'updated_at'];

  const stringValue = fc.oneof(
    fc.constant(''),
    fc.constant('2025-01-15T10:30'),
    fc.constant('2025-01-15T10:3'),
    fc.constant('2025-01-15T10:30:00'),
    fc.constant('2025-01-15T10:30:00.000Z'),
    fc.constant('2025-13-45T10:30'),
    fc.constant('$1,234.50'),
    fc.string({ minLength: 15, maxLength: 19 }),
    fc.string({ minLength: 16, maxLength: 16 }),
    fc.tuple(
      fc.integer({ min: 1990, max: 2060 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 }),
      fc.integer({ min: 0, max: 24 }), fc.integer({ min: 0, max: 60 })
    ).map(([y, mo, d, h, mi]) => `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`)
  );
  const value = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    stringValue,
    fc.integer(),
    fc.boolean(),
    fc.constant({}),
    fc.constant({ id: 0 }),
    fc.constant({ id: '' }),
    fc.record({ id: fc.oneof(fc.uuid(), fc.integer({ min: 1 })) }),
    fc.record({ id: fc.uuid(), name: fc.string() })
  );
  const propArb = fc.record({
    column_name: fc.constantFrom(...columns),
    type: fc.constantFrom(...types),
  });
  // One property per column: the pre-move methods applied duplicates in sequence, so a 16-character value
  // rewritten to 19 characters by a DateTime property met a DateTimeLocal property for the same column
  // unconverted. F-06 changes that case on purpose, and a real entity has one property per column.
  const propsArb = fc.array(propArb, { maxLength: 8 }).map(ps => [...new Map(ps.map(p => [p.column_name, p])).values()]);
  const formArb = fc.dictionary(fc.constantFrom(...columns, 'extra'), value);

  /** True when a ledger row (F-06, F-08, F-09) deliberately changes this input: seconds, or an invalid local time. */
  const changedByLedger = (props: TransformProp[], form: any) =>
    props.some(p => {
      const v = form[p.column_name];
      return (
        (p.type === T.DateTime || p.type === T.DateTimeLocal) &&
        typeof v === 'string' &&
        (v.length === 19 || (v.length === 16 && parseWallClock(v) === null))
      );
    });

  /** F-12: create mode omits the gallery key whatever its value. */
  const omitGalleries = (props: TransformProp[], out: any) => {
    for (const p of props) if (p.type === T.PhotoGallery) delete out[p.column_name];
    return out;
  };

  const sameKeysAndValues = (actual: any, expected: any) => {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toStrictEqual(expected);
  };

  it('create mode', () => {
    fc.assert(
      fc.property(formArb, propsArb, (form, props) => {
        fc.pre(!changedByLedger(props, form));
        const frozenForm = deepFreeze(clone(form));
        sameKeysAndValues(
          transformValuesForApi(frozenForm, props, { mode: 'create' }),
          omitGalleries(props, oracleCreate(props, clone(form)))
        );
      }),
      { numRuns: 3000 }
    );
  });

  it('edit mode', () => {
    fc.assert(
      fc.property(formArb, propsArb, (form, props) => {
        fc.pre(!changedByLedger(props, form));
        const frozenForm = deepFreeze(clone(form));
        sameKeysAndValues(
          transformValuesForApi(frozenForm, props, { mode: 'edit' }),
          oracleEdit(props, clone(form))
        );
      }),
      { numRuns: 3000 }
    );
  });

  it('transformValueForControl', () => {
    fc.assert(
      fc.property(propArb, value, (p, v) => {
        // F-03 / F-10: only instants with an explicit offset are compared for DateTimeLocal; F-11: only canonical money text.
        if (p.type === T.DateTimeLocal && typeof v === 'string') {
          const hasOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v);
          fc.pre(hasOffset && !isNaN(new Date(v).getTime()));
        }
        if (p.type === T.Money && typeof v === 'string') fc.pre(parseMoneyOutput(v) !== null);
        expect(transformValueForControl(p, v)).toStrictEqual(oracleControl(p, v));
      }),
      { numRuns: 3000 }
    );
  });
});

describe('X-01: values supplied without a form (the MCP helper)', () => {
  const run = (values: any, props: TransformProp[]) => normalizeValuesForApi(deepFreeze(values), props);
  const dtl = [prop('t', T.DateTimeLocal)];

  it('X-01: timestamptz needs an ISO value with an offset; offset-less values are rejected with an instructive error', () => {
    expect(run({ t: '2026-07-04T10:30:00-04:00' }, dtl).t).toBe('2026-07-04T14:30:00.000Z');
    expect(run({ t: '2026-07-04T14:30:00Z' }, dtl).t).toBe('2026-07-04T14:30:00.000Z');
    expect(run({ t: '2026-07-04T14:30Z' }, dtl).t).toBe('2026-07-04T14:30:00.000Z');
    expect(run({ t: '2026-07-04T20:00:00+05:30' }, dtl).t).toBe('2026-07-04T14:30:00.000Z');
    for (const bare of ['2026-07-04T10:30', '2026-07-04T10:30:00', '2026-07-04']) {
      const err = (() => { try { run({ t: bare }, dtl); } catch (e) { return e as ValueTransformError; } return null; })();
      expect(err, bare).toBeInstanceOf(ValueTransformError);
      expect(err).toMatchObject({ column: 't', reason: 'missing_offset', value: bare });
      expect(err!.message).toContain('no UTC offset');
      expect(err!.message).toContain('2026-07-04T10:30:00-04:00');
    }
    expect(() => run({ t: 'next tuesday' }, dtl)).toThrow(/not a valid timestamp/);
    expect(() => run({ t: '2026-02-30T10:30:00Z' }, dtl)).toThrow(ValueTransformError);
  });

  it('X-01: DateTime stays wall-clock verbatim; money and files are normalized', () => {
    expect(run({ t: '2026-07-04T10:30' }, [prop('t', T.DateTime)]).t).toBe('2026-07-04T10:30');
    expect(run({ t: '2026-07-04 10:30:00' }, [prop('t', T.DateTime)]).t).toBe('2026-07-04 10:30:00');
    expect(run({ m: '$1,234.50' }, [prop('m', T.Money)]).m).toBe(1234.5);
    expect(run({ m: 12.5 }, [prop('m', T.Money)]).m).toBe(12.5);
    expect(() => run({ m: 'twelve' }, [prop('m', T.Money)])).toThrow(ValueTransformError);
    expect(run({ f: { id: 'u-1' }, g: { id: 'g-1' }, h: 'u-2' }, [prop('f', T.FileImage), prop('g', T.PhotoGallery), prop('h', T.File)])).toEqual({ f: 'u-1', g: 'g-1', h: 'u-2' });
    expect(run({ n: null, x: 'keep' }, [prop('n', T.DateTimeLocal)])).toEqual({ n: null, x: 'keep' });
  });
});
