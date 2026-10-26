/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  checkEditResult,
  compareColorValues,
  compareDateTimeValues,
  compareDateValues,
  compareGeographyValues,
  compareMoneyValues,
  compareTimeSlotValues,
  parseEWKBPoint,
} from './compare.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Builds little-endian EWKB hex for POINT(x y) with SRID 4326. */
function ewkbPoint(x: number, y: number): string {
  const hex = (n: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, n, true);
    return Array.from({ length: 8 }, (_, i) => view.getUint8(i).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  return '0101000020E6100000' + hex(x) + hex(y);
}

describe('parseEWKBPoint', () => {
  it('decodes a little-endian point with SRID', () => {
    expect(parseEWKBPoint(ewkbPoint(-83.6875, 43.0125))).toBe('SRID=4326;POINT(-83.6875 43.0125)');
  });

  it('returns null for short, non-LE and non-point input', () => {
    expect(parseEWKBPoint('0101')).toBeNull();
    expect(parseEWKBPoint('00' + ewkbPoint(1, 2).slice(2))).toBeNull();
    expect(parseEWKBPoint('0102000020' + ewkbPoint(1, 2).slice(10))).toBeNull();
  });
});

describe('compare* helpers', () => {
  it('datetime strips timezone and milliseconds', () => {
    expect(compareDateTimeValues('2025-10-31T17:00:00', '2025-10-31T17:00:00+00:00')).toEqual({ isDateTime: true, matches: true });
    expect(compareDateTimeValues('2025-10-31T17:00:00', '2025-10-31T18:00:00.000Z')).toEqual({ isDateTime: true, matches: false });
    expect(compareDateTimeValues('x', 'y')).toEqual({ isDateTime: false, matches: false });
    expect(compareDateTimeValues(1, '2025-10-31T17:00')).toEqual({ isDateTime: false, matches: false });
  });

  it('date compares the first 10 characters', () => {
    expect(compareDateValues('2025-01-15', '2025-01-15T05:00:00.000Z')).toEqual({ isDate: true, matches: true });
    expect(compareDateValues('2025-01-15', '2025-01-16T05:00:00.000Z')).toEqual({ isDate: true, matches: false });
    expect(compareDateValues('2025-01-15T10:00', '2025-01-15')).toEqual({ isDate: false, matches: false });
  });

  it('money parses numerics with a 0.01 epsilon', () => {
    expect(compareMoneyValues(100, '$100.00')).toEqual({ isMoney: true, matches: true });
    expect(compareMoneyValues('100.5', '$100.00')).toEqual({ isMoney: true, matches: false });
    expect(compareMoneyValues('abc', '$100.00')).toEqual({ isMoney: false, matches: false });
    expect(compareMoneyValues(100, '100.00')).toEqual({ isMoney: false, matches: false });
  });

  it('color is case-insensitive', () => {
    expect(compareColorValues('#3b82f6', '#3B82F6')).toEqual({ isColor: true, matches: true });
    expect(compareColorValues('#3b82f6', '#FF0000')).toEqual({ isColor: true, matches: false });
    expect(compareColorValues('#123', '#123456')).toEqual({ isColor: false, matches: false });
  });

  it('time slot normalizes PostgreSQL and ISO range formats', () => {
    expect(compareTimeSlotValues('[2025-11-07T15:00:00Z,2025-11-07T22:00:00Z)', '["2025-11-07 15:00:00+00","2025-11-07 22:00:00+00")'))
      .toEqual({ isTimeSlot: true, matches: true });
    expect(compareTimeSlotValues('[2025-11-07T15:00:00.000Z,2025-11-07T22:00:00.000Z)', '["2025-11-07 15:00:00+00","2025-11-07 23:00:00+00")'))
      .toEqual({ isTimeSlot: true, matches: false });
    expect(compareTimeSlotValues('nope', 'nope')).toEqual({ isTimeSlot: false, matches: false });
  });

  it('geography converts EWKB and trusts PostgREST for non-point geometries', () => {
    expect(compareGeographyValues('SRID=4326;POINT(-83 43)', ewkbPoint(-83, 43))).toEqual({ isGeography: true, matches: true });
    expect(compareGeographyValues('POINT(-83 44)', ewkbPoint(-83, 43))).toEqual({ isGeography: true, matches: false });
    expect(compareGeographyValues('POLYGON((0 0,1 1,1 0,0 0))', '0103000020E6100000' + '00'.repeat(8)))
      .toEqual({ isGeography: true, matches: true });
    expect(compareGeographyValues('hello', ewkbPoint(1, 2))).toEqual({ isGeography: false, matches: false });
  });
});

describe('checkEditResult', () => {
  it('passes error responses through', () => {
    const err = deepFreeze({ success: false, error: { message: 'x' } });
    expect(checkEditResult({ a: 1 }, err)).toBe(err);
  });

  it('succeeds when every submitted field matches, using loose equality, FK ids and typed comparisons', () => {
    const input = deepFreeze({ n: '4', fk: 7, c: '#aabbcc', d: '2025-01-15' });
    const rep = deepFreeze({ success: true, body: [{ n: 4, fk: { id: 7, display_name: 'x' }, c: '#AABBCC', d: '2025-01-15T05:00:00.000Z' }] });
    expect(checkEditResult(input, rep)).toEqual({ success: true, body: rep.body });
  });

  it('reports the first mismatching field (every short-circuits; preserved)', () => {
    const r = checkEditResult(deepFreeze({ a: 1, b: 2, c: 3 }), deepFreeze({ success: true, body: [{ a: 1, b: 9, c: 9 }] }));
    expect(r.success).toBe(false);
    expect(r.error.httpCode).toBe(400);
    expect(r.error.details).toBe('Field mismatches: b');
    expect(r.error.hint).toContain('(possibly: b)');
  });

  it('treats an empty body as failure with unknown fields', () => {
    const r = checkEditResult(deepFreeze({ a: 1 }), deepFreeze({ success: true, body: [] }));
    expect(r.success).toBe(false);
    expect(r.error.details).toBe('Field mismatches: unknown fields');
  });
});
