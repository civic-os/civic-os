/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseContentRangeCount, parseContentRangeTotal, transformManyToManyData } from './response.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Oracle: the inline parsing from DataService.getDataPaginated before the move. */
function oracleTotal(contentRange: string | null, dataLength: number): number {
  let totalCount: number;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+|\*)$/);
    if (match && match[1] !== '*') {
      totalCount = parseInt(match[1], 10);
    } else {
      totalCount = dataLength;
    }
  } else {
    totalCount = dataLength;
  }
  return totalCount;
}

/** Oracle: the inline parsing from DataService.getInverseRelationshipPreview. */
function oracleCount(contentRange: string | null, recordsLength: number): number {
  let totalCount = 0;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    totalCount = match ? parseInt(match[1], 10) : recordsLength;
  }
  return totalCount;
}

describe('Content-Range parsing', () => {
  it('paginated variant', () => {
    expect(parseContentRangeTotal('0-24/237', 25)).toBe(237);
    expect(parseContentRangeTotal('0-0/*', 4)).toBe(4);
    expect(parseContentRangeTotal('*/237', 0)).toBe(237);
    expect(parseContentRangeTotal(null, 7)).toBe(7);
    expect(parseContentRangeTotal('', 7)).toBe(7);
    expect(parseContentRangeTotal('garbage', 7)).toBe(7);
  });

  it('count variant gives 0 without a header and falls back to records length when unparseable', () => {
    expect(parseContentRangeCount('0-4/15', 5)).toBe(15);
    expect(parseContentRangeCount(null, 5)).toBe(0);
    expect(parseContentRangeCount('', 5)).toBe(0);
    expect(parseContentRangeCount('0-4/*', 5)).toBe(5);
    expect(parseContentRangeCount('garbage', 5)).toBe(5);
  });

  it('both equal their oracles for arbitrary headers (property)', () => {
    const header = fc.oneof(
      fc.constant(null), fc.constant(''), fc.string({ maxLength: 15 }),
      fc.tuple(fc.nat(500), fc.nat(500), fc.oneof(fc.nat(100000).map(String), fc.constant('*'))).map(([a, b, t]) => `${a}-${b}/${t}`),
    );
    fc.assert(fc.property(header, fc.nat(300), (h, n) => {
      expect(parseContentRangeTotal(h, n)).toBe(oracleTotal(h, n));
      expect(parseContentRangeCount(h, n)).toBe(oracleCount(h, n));
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
