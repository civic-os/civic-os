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
  transformValueForControl,
  transformValuesForApi,
  type TransformProp,
} from './values.js';

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

  it('DateTimeLocal: an unparseable string yields NaN parts, as today', () => {
    expect(transformValueForControl(prop('a', T.DateTimeLocal), 'nope')).toBe('NaN-NaN-NaNTNaN:NaN');
  });

  it('Money: strips $ and commas', () => {
    expect(transformValueForControl(prop('a', T.Money), '$1,234.50')).toBe(1234.5);
  });

  it('Money: unparseable string and non-string pass through', () => {
    expect(transformValueForControl(prop('a', T.Money), 'abc')).toBe('abc');
    expect(transformValueForControl(prop('a', T.Money), 7)).toBe(7);
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

    it('DateTime: appends :00 only for strings of length exactly 16', () => {
      const p = [prop('s', T.DateTime)];
      expect(run({ s: '2025-01-15T10:30' }, p).s).toBe('2025-01-15T10:30:00');
      expect(run({ s: '2025-01-15T10:3' }, p).s).toBe('2025-01-15T10:3');
      expect(run({ s: '2025-01-15T10:30:00' }, p).s).toBe('2025-01-15T10:30:00');
      expect(run({ s: '2025-01-15T10:30:0' }, p).s).toBe('2025-01-15T10:30:0');
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

    it('DateTimeLocal: unparseable 16-char strings and other lengths are left as-is', () => {
      const p = [prop('s', T.DateTimeLocal)];
      expect(run({ s: '2025-13-15T17:30' }, p).s).toBe('2025-13-15T17:30');
      expect(run({ s: '2025-01-15T17:30:00' }, p).s).toBe('2025-01-15T17:30:00');
      expect(run({ s: '2025-01-15T17:3' }, p).s).toBe('2025-01-15T17:3');
    });

    it('null and undefined values are skipped before every branch, and keys are kept', () => {
      const p = [prop('a', T.DateTime), prop('b', T.DateTimeLocal), prop('c', T.PhotoGallery), prop('d', T.File)];
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

    it('PhotoGallery key is deleted for falsy-but-present values, kept when null or undefined', () => {
      const p = [prop('g', T.PhotoGallery)];
      expect('g' in run({ g: '' }, p)).toBe(false);
      expect('g' in run({ g: 0 }, p)).toBe(false);
      expect('g' in run({ g: null }, p)).toBe(true);
      expect('g' in run({ g: undefined }, p)).toBe(true);
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

describe('oracle: core agrees with the pre-move page methods', () => {
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
  const formArb = fc.dictionary(fc.constantFrom(...columns, 'extra'), value);

  const sameKeysAndValues = (actual: any, expected: any) => {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toStrictEqual(expected);
  };

  it('create mode', () => {
    fc.assert(
      fc.property(formArb, fc.array(propArb, { maxLength: 8 }), (form, props) => {
        const frozenForm = deepFreeze(clone(form));
        sameKeysAndValues(
          transformValuesForApi(frozenForm, props, { mode: 'create' }),
          oracleCreate(props, clone(form))
        );
      }),
      { numRuns: 3000 }
    );
  });

  it('edit mode', () => {
    fc.assert(
      fc.property(formArb, fc.array(propArb, { maxLength: 8 }), (form, props) => {
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
        expect(transformValueForControl(p, v)).toStrictEqual(oracleControl(p, v));
      }),
      { numRuns: 3000 }
    );
  });
});
