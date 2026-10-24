/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseContentRangeTotal, transformManyToManyData } from './response.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

describe('Content-Range parsing', () => {
  it('F-14: one parser serves paginated reads and count previews', () => {
    // The two former parsers (parseContentRangeTotal with a row-count fallback,
    // parseContentRangeCount with 0 / row-count) disagreed on missing, empty and `*` totals.
    expect(parseContentRangeTotal('0-24/237')).toBe(237);
    expect(parseContentRangeTotal('0-4/15')).toBe(15);
    expect(parseContentRangeTotal('*/237')).toBe(237);
    expect(parseContentRangeTotal('*/0')).toBe(0);
    expect(parseContentRangeTotal('items 0-24/237')).toBe(237);
    for (const missing of [null, undefined, '', '0-24/*', '0-24/', 'garbage', '0-9/12abc']) {
      expect(parseContentRangeTotal(missing), JSON.stringify(missing)).toBeNull();
    }
  });

  it('Q-16: an unknown total is null, never a row count', () => {
    expect(parseContentRangeTotal('0-24/*')).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
  });

  it('F-14: equals the end-anchored digits rule for arbitrary headers (property)', () => {
    const header = fc.oneof(
      fc.constant(null), fc.constant(''), fc.string({ maxLength: 15 }),
      fc.tuple(fc.nat(500), fc.nat(500), fc.oneof(fc.nat(100000).map(String), fc.constant('*'))).map(([a, b, t]) => `${a}-${b}/${t}`),
    );
    fc.assert(fc.property(header, (h) => {
      const m = h ? h.match(/\/(\d+)$/) : null;
      expect(parseContentRangeTotal(h)).toBe(m ? parseInt(m[1], 10) : null);
    }), { numRuns: 500 });
  });
});

describe('transformManyToManyData', () => {
  it('flattens pure junctions and drops null related rows', () => {
    const junction = deepFreeze([{ Tag: { id: 1, display_name: 'Urgent' } }, { Tag: null }, { Tag: { id: 2, display_name: 'Road' } }]);
    expect(transformManyToManyData(junction, 'Tag')).toEqual([{ id: 1, display_name: 'Urgent' }, { id: 2, display_name: 'Road' }]);
  });

  it('attaches _junction extras for rich junctions without mutating inputs', () => {
    const junction = deepFreeze([{ tool_types: { id: 1, display_name: 'Push Mower' }, quantity: 3 }]);
    const out = transformManyToManyData(junction, 'tool_types', ['quantity', 'missing']);
    expect(out).toEqual([{ id: 1, display_name: 'Push Mower', _junction: { quantity: 3 } }]);
    expect(out[0]).not.toBe(junction[0].tool_types);
  });

  it('walks parent hops and de-duplicates by id', () => {
    const junction = deepFreeze([
      { target: { hop: { id: 9, display_name: 'G' } } },
      { target: { hop: { id: 9, display_name: 'G' } } },
      { target: null },
      { target: { hop: null } },
    ]);
    const hops = deepFreeze([{ table: 'hop' }]) as unknown as Parameters<typeof transformManyToManyData>[3];
    expect(transformManyToManyData(junction, 'x', undefined, hops, 'target')).toEqual([{ id: 9, display_name: 'G' }]);
  });

  it('returns [] for non-arrays', () => {
    expect(transformManyToManyData(null as never, 'x')).toEqual([]);
    expect(transformManyToManyData(undefined as never, 'x')).toEqual([]);
    expect(transformManyToManyData({} as never, 'x')).toEqual([]);
  });
});
